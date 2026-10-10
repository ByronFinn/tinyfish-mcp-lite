/**
 * FORK ADDITION (tinyfish-mcp-lite): tests for the free-tool filter
 * (src/core/tool-filter.ts). Unit tests run against a scripted fake core;
 * full-flow tests drive the real HTTP adapter over a real local server
 * against the shared mock upstream — same harness as adapter.test.ts, so
 * "the blocked call never left the process" is asserted via mock.seen.
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import type { ProxyCore, ProxyResponse } from "../src/core/proxy-core.js";
import { DEFAULT_ALLOWED_TOOLS, parseToolPolicy, withToolFilter } from "../src/core/tool-filter.js";
import { createProxyCore } from "../src/core/proxy-core.js";
import { createMcpAdapter } from "../src/http/adapter.js";
import { createAppHandler, startHttpServer } from "../src/http/index.js";
import { automationCall, listeningPort, postJson, send, sseDataPayloads } from "./helpers/http.js";
import { buildEchoResult, startMockUpstream, type MockUpstream } from "./helpers/mock-upstream.js";

// ---------------------------------------------------------------------------
// parseToolPolicy
// ---------------------------------------------------------------------------

describe("parseToolPolicy", () => {
  it("defaults to exactly the two free tools when the env var is unset", () => {
    const policy = parseToolPolicy(undefined);
    expect(policy).toEqual({ mode: "allow", allowed: new Set(DEFAULT_ALLOWED_TOOLS) });
    if (policy.mode !== "allow") throw new Error("expected allow mode");
    expect([...policy.allowed]).toEqual(["search", "fetch_content"]);
  });

  it('"*" means passthrough (filter off)', () => {
    expect(parseToolPolicy("*")).toEqual({ mode: "passthrough" });
    expect(parseToolPolicy("  * ")).toEqual({ mode: "passthrough" });
  });

  it("parses an explicit list, trimming and deduping, order-preserving", () => {
    const policy = parseToolPolicy(" search , fetch_content , search ");
    expect(policy).toEqual({ mode: "allow", allowed: new Set(["search", "fetch_content"]) });
    if (policy.mode !== "allow") throw new Error("expected allow mode");
    expect([...policy.allowed]).toEqual(["search", "fetch_content"]);
  });

  it("rejects an empty list with an actionable ConfigError", () => {
    expect(() => parseToolPolicy("")).toThrow(ConfigError);
    expect(() => parseToolPolicy("  ")).toThrow(/TINYFISH_TOOLS/);
  });

  it("rejects malformed tool names (never silently widens the allowlist)", () => {
    expect(() => parseToolPolicy("search,run_web_automation;rm -rf")).toThrow(ConfigError);
    expect(() => parseToolPolicy("a,,b")).toThrow(ConfigError);
    expect(() => parseToolPolicy("{{tool}}")).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// withToolFilter — unit level, scripted fake core
// ---------------------------------------------------------------------------

/** A ProxyCore stub that records every delegated call and returns settable results. */
function fakeCore(scripted: { forward?: ProxyResponse; forwardStream?: ProxyResponse }) {
  const calls: string[] = [];
  const core: ProxyCore & { calls: string[] } = {
    calls,
    async initialize() {
      calls.push("initialize");
      return { status: 200, body: {}, sessionId: "s-upstream", contentType: "application/json" };
    },
    async notify() {
      calls.push("notify");
    },
    async forward(_localKey, request) {
      calls.push(`forward:${String((request as { method?: string }).method)}`);
      return (
        scripted.forward ?? {
          status: 200,
          body: {},
          sessionId: null,
          contentType: "application/json",
        }
      );
    },
    async forwardStream(_localKey, request) {
      calls.push(`forwardStream:${String((request as { method?: string }).method)}`);
      return (
        scripted.forwardStream ?? {
          status: 200,
          body: {},
          sessionId: null,
          contentType: "application/json",
        }
      );
    },
    close() {
      calls.push("close");
    },
    closeAll() {
      calls.push("closeAll");
    },
  };
  return core;
}

const toolsListBody = {
  jsonrpc: "2.0",
  result: {
    tools: [
      { name: "search", description: "free search" },
      { name: "run_web_automation", description: "paid automation" },
      { name: "fetch_content", description: "free fetch" },
      { name: "create_monitor", description: "paid monitor" },
    ],
    nextCursor: "cursor-2",
  },
  id: 7,
};

describe("withToolFilter (scripted core)", () => {
  it("passthrough returns the core itself — identity, zero wrapping", () => {
    const core = fakeCore({});
    expect(withToolFilter(core, parseToolPolicy("*"))).toBe(core);
  });

  it("tools/list response keeps only allowed tools, preserving key order and nextCursor", async () => {
    const core = fakeCore({
      forward: {
        status: 200,
        body: toolsListBody,
        sessionId: "s",
        contentType: "application/json",
      },
    });
    const filtered = withToolFilter(core, parseToolPolicy("search,fetch_content"));
    const response = await filtered.forward("key", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
    });
    // Byte-stable serialization: key order (jsonrpc, result{tools,nextCursor}, id)
    // preserved — only the two allowed tool entries survive.
    expect(JSON.stringify(response.body)).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        result: {
          tools: [
            { name: "search", description: "free search" },
            { name: "fetch_content", description: "free fetch" },
          ],
          nextCursor: "cursor-2",
        },
        id: 7,
      })
    );
  });

  it("tools/list where nothing is dropped returns the body object untouched", async () => {
    const core = fakeCore({
      forward: {
        status: 200,
        body: { jsonrpc: "2.0", result: { tools: [{ name: "search" }] }, id: 1 },
        sessionId: null,
        contentType: "application/json",
      },
    });
    const filtered = withToolFilter(core, parseToolPolicy("search"));
    const response = await filtered.forward("key", { method: "tools/list" });
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      result: { tools: [{ name: "search" }] },
      id: 1,
    });
  });

  it("tools/list error responses and shapeless bodies relay untouched", async () => {
    const errorBody = { jsonrpc: "2.0", error: { code: -32000, message: "boom" }, id: 7 };
    for (const body of [errorBody, { jsonrpc: "2.0", result: {}, id: 7 }, null]) {
      const core = fakeCore({
        forward: { status: 500, body, sessionId: null, contentType: "application/json" },
      });
      const filtered = withToolFilter(core, parseToolPolicy("search"));
      const response = await filtered.forward("key", { method: "tools/list" });
      expect(response.body).toBe(body);
    }
  });

  it("non-tools/list forwards (ping, resources/*, unknown) bypass the filter", async () => {
    const core = fakeCore({
      forward: {
        status: 200,
        body: { ok: true },
        sessionId: null,
        contentType: "application/json",
      },
    });
    const filtered = withToolFilter(core, parseToolPolicy("search"));
    for (const method of ["ping", "resources/list", "bogus/method"]) {
      const response = await filtered.forward("key", { jsonrpc: "2.0", id: 1, method });
      expect(response.body).toEqual({ ok: true });
    }
  });

  it("tools/call of a hidden tool is answered locally — the core is never touched", async () => {
    const core = fakeCore({});
    const filtered = withToolFilter(core, parseToolPolicy("search"));
    const response = await filtered.forwardStream(
      "key",
      {
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "run_web_automation", arguments: { goal: "book a flight" } },
      },
      () => undefined
    );
    expect(response.status).toBe(400);
    expect(response.sessionId).toBeNull();
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32602, message: "Unknown tool: run_web_automation" },
      id: 42,
    });
    expect(core.calls).toEqual([]); // nothing delegated — no upstream contact
  });

  it("tools/call of an allowed tool and non-tools/call streams delegate verbatim", async () => {
    const core = fakeCore({});
    const filtered = withToolFilter(core, parseToolPolicy("search"));
    await filtered.forwardStream(
      "key",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { query: "hi" } },
      },
      () => undefined
    );
    await filtered.forwardStream("key", { jsonrpc: "2.0", id: 2, method: "ping" }, () => undefined);
    expect(core.calls).toEqual(["forwardStream:tools/call", "forwardStream:ping"]);
  });

  it("tools/call without a string name delegates (upstream produces its own error)", async () => {
    const core = fakeCore({});
    const filtered = withToolFilter(core, parseToolPolicy("search"));
    await filtered.forwardStream(
      "key",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} },
      () => undefined
    );
    expect(core.calls).toEqual(["forwardStream:tools/call"]);
  });

  it("initialize/notify/close/closeAll delegate untouched", async () => {
    const core = fakeCore({});
    const filtered = withToolFilter(core, parseToolPolicy("search"));
    await filtered.initialize("key", {});
    await filtered.notify("key", { method: "notifications/initialized" });
    filtered.close("key");
    filtered.closeAll();
    expect(core.calls).toEqual(["initialize", "notify", "close", "closeAll"]);
  });

  it("tools/call NOTIFICATION (no id) of a hidden tool is swallowed — never delegated", async () => {
    // Regression pin for the notify-path bypass: a notification-shaped
    // tools/call would otherwise be forwarded verbatim by the adapter.
    const core = fakeCore({});
    const filtered = withToolFilter(core, parseToolPolicy("search"));
    await expect(
      filtered.notify("key", {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "run_web_automation", arguments: { goal: "fire and forget" } },
      })
    ).resolves.toBeUndefined();
    expect(core.calls).toEqual([]); // nothing left the process
  });

  it("non-tools/call notifications still delegate (control-plane passthrough)", async () => {
    const core = fakeCore({});
    const filtered = withToolFilter(core, parseToolPolicy("search"));
    await filtered.notify("key", { jsonrpc: "2.0", method: "notifications/initialized" });
    await filtered.notify("key", {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });
    expect(core.calls).toEqual(["notify", "notify"]);
  });

  it("batch array hiding a tools/call is rejected locally with upstream's batch shape", async () => {
    // Regression pin for the batch bypass: the no-paid-call property must
    // not depend on the hosted server rejecting batches.
    const core = fakeCore({});
    const filtered = withToolFilter(core, parseToolPolicy("search"));
    const response = await filtered.forward("key", [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "create_monitor", arguments: {} },
      },
    ]);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request format" },
      id: -1,
    });
    expect(core.calls).toEqual([]); // the batch never left the process
  });

  it("batch arrays without hidden tools/call still delegate (upstream answers them)", async () => {
    const core = fakeCore({});
    const filtered = withToolFilter(core, parseToolPolicy("search"));
    await filtered.forward("key", [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: {} } },
    ]);
    expect(core.calls).toEqual(["forward:undefined"]); // array method is undefined — delegated
  });
});

// ---------------------------------------------------------------------------
// Full flow: real local HTTP → adapter → filtered core → mock upstream
// ---------------------------------------------------------------------------

const API_KEY = "sk-filter-secret-0000";

describe("tool filter full flow (real local HTTP → mock upstream)", () => {
  let mock: MockUpstream;
  let server: Server;
  let mcpUrl: string;
  let sessionId: string;
  const sessionHeaders = () => ({
    "Mcp-Session-Id": sessionId,
    "MCP-Protocol-Version": "2025-11-25",
  });

  beforeAll(async () => {
    mock = await startMockUpstream();
    // The mock exposes "echo" and "run_web_automation"; allow only "echo" so
    // the filter has one tool to keep and one (streaming, paid-equivalent)
    // to hide.
    const core = withToolFilter(
      createProxyCore({ upstreamUrl: mock.url, apiKey: API_KEY, hooks: null }),
      parseToolPolicy("echo")
    );
    server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    mcpUrl = `http://127.0.0.1:${listeningPort(server)}/mcp`;
    const init = await postJson(mcpUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "filter-test", version: "0.0.0" },
      },
    });
    sessionId = init.sessionId as string;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mock.close();
  });

  it("tools/list advertises only allowed tools (run_web_automation hidden)", async () => {
    const result = await postJson(
      mcpUrl,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      sessionHeaders()
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.text);
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);
    expect(body.result.tools[0]).toEqual(
      expect.objectContaining({ name: "echo" }) // full schema kept, not stubbed
    );
  });

  it("allowed tools/call (echo) round-trips verbatim through the filter", async () => {
    const result = await postJson(
      mcpUrl,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "through the filter" } },
      },
      sessionHeaders()
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({
      jsonrpc: "2.0",
      result: buildEchoResult("echo", { text: "through the filter" }),
      id: 3,
    });
  });

  it("hidden tools/call (run_web_automation): local 400 -32602, NOTHING reaches upstream", async () => {
    const seenBefore = mock.seen.length;
    const result = await postJson(mcpUrl, automationCall(4, {}), sessionHeaders());
    expect(result.status).toBe(400);
    expect(result.contentType).toContain("application/json");
    expect(JSON.parse(result.text)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32602, message: "Unknown tool: run_web_automation" },
      id: 4,
    });
    expect(mock.seen.length).toBe(seenBefore); // no upstream request was made
  });

  it("hidden tools/call never opens an SSE stream even with a progressToken", async () => {
    const seenBefore = mock.seen.length;
    const result = await postJson(mcpUrl, automationCall(5, {}, "token-5"), sessionHeaders());
    expect(result.status).toBe(400);
    expect(result.contentType).toContain("application/json"); // not event-stream
    expect(mock.seen.length).toBe(seenBefore);
  });

  it("REGRESSION: notification-shaped tools/call (no id) of a hidden tool → 204, NOTHING upstream", async () => {
    const seenBefore = mock.seen.length;
    const result = await send(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeaders() },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "run_web_automation", arguments: { goal: "fire and forget" } },
      }),
    });
    expect(result.status).toBe(204); // notification contract kept
    expect(mock.seen.length).toBe(seenBefore); // but it never left the process
  });

  it("REGRESSION: batch array hiding a tools/call → local 400 -32600, NOTHING upstream", async () => {
    const seenBefore = mock.seen.length;
    const result = await postJson(
      mcpUrl,
      [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "run_web_automation", arguments: {} },
        },
      ],
      sessionHeaders()
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request format" },
      id: -1,
    });
    expect(mock.seen.length).toBe(seenBefore);
  });

  it("an allowed-but-upstream-unknown tool forwards and surfaces upstream's own answer", async () => {
    // Separate server whose policy allows "search": the mock has no such
    // tool and echoes any non-automation name, proving allowed names ALWAYS
    // forward (the filter never second-guesses upstream's tool catalog).
    const mock2 = await startMockUpstream();
    const core2 = withToolFilter(
      createProxyCore({ upstreamUrl: mock2.url, apiKey: API_KEY, hooks: null }),
      parseToolPolicy("search")
    );
    const server2 = await startHttpServer(0, createAppHandler(createMcpAdapter(core2)));
    try {
      const url2 = `http://127.0.0.1:${listeningPort(server2)}/mcp`;
      const init = await postJson(url2, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "filter-allowed-test", version: "0.0.0" },
        },
      });
      const result = await postJson(
        url2,
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search", arguments: {} } },
        { "Mcp-Session-Id": init.sessionId as string, "MCP-Protocol-Version": "2025-11-25" }
      );
      expect(result.status).toBe(200);
      expect(JSON.parse(result.text).result).toEqual(buildEchoResult("search", {}));
      expect(mock2.seen.at(-1)?.method).toBe("tools/call");
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      await mock2.close();
    }
  });

  it("allowed STREAMING tool still streams end-to-end through the decorator", async () => {
    // Fresh policy that allows the streaming tool, on its own server+session,
    // to prove the decorator does not disturb the SSE relay path.
    const mock2 = await startMockUpstream();
    const core2 = withToolFilter(
      createProxyCore({ upstreamUrl: mock2.url, apiKey: API_KEY, hooks: null }),
      parseToolPolicy("run_web_automation")
    );
    const server2 = await startHttpServer(0, createAppHandler(createMcpAdapter(core2)));
    try {
      const url2 = `http://127.0.0.1:${listeningPort(server2)}/mcp`;
      const init = await postJson(url2, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "filter-sse-test", version: "0.0.0" },
        },
      });
      const result = await postJson(url2, automationCall(2, { frameDelayMs: 1 }, "pt"), {
        "Mcp-Session-Id": init.sessionId as string,
        "MCP-Protocol-Version": "2025-11-25",
      });
      expect(result.status).toBe(200);
      expect(result.contentType).toContain("text/event-stream");
      const payloads = sseDataPayloads(result.text);
      expect(payloads).toHaveLength(4); // 3 progress notifications + final response
      const finalFrame = JSON.parse(payloads[3]);
      expect(finalFrame.result._meta).toBeDefined();
      expect(finalFrame.result.structuredContent.status).toBe("completed");
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      await mock2.close();
    }
  });

  it("default policy hides BOTH mock tools — the default is exactly the free pair", async () => {
    const mock3 = await startMockUpstream();
    const core3 = withToolFilter(
      createProxyCore({ upstreamUrl: mock3.url, apiKey: API_KEY, hooks: null }),
      parseToolPolicy(undefined)
    );
    const server3 = await startHttpServer(0, createAppHandler(createMcpAdapter(core3)));
    try {
      const url3 = `http://127.0.0.1:${listeningPort(server3)}/mcp`;
      const init = await postJson(url3, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "filter-default-test", version: "0.0.0" },
        },
      });
      const list = await postJson(
        url3,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { "Mcp-Session-Id": init.sessionId as string, "MCP-Protocol-Version": "2025-11-25" }
      );
      expect(JSON.parse(list.text).result.tools).toEqual([]); // mock has no free tools
    } finally {
      await new Promise<void>((resolve) => server3.close(() => resolve()));
      await mock3.close();
    }
  });
});
