/**
 * FORK ADDITION (tinyfish-mcp-lite): integration tests for the free-tool
 * filter — the real local proxy with the DEFAULT policy against the real
 * hosted upstream (default https://agent.tinyfish.ai/mcp, override with
 * TINYFISH_UPSTREAM_URL).
 *
 * Run: TINYFISH_API_KEY=... npm run test:integration
 * Without the key the suite skips with a printed notice (same contract as
 * proxy.integration.test.ts).
 *
 * Coverage when the key is set:
 * - tools/list through the filtered proxy advertises EXACTLY the free pair,
 *   and their schemas deep-equal the direct upstream response (the parity
 *   guarantee, narrowed to allowed tools);
 * - tools/call of a paid tool (run_web_automation) is answered LOCALLY with
 *   the unknown-tool error — nothing is invoked upstream;
 * - one free tools/call (search) round-trips through the filter.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listeningPort, postJson } from "./helpers/http.js";
import { createProxyCore } from "../src/core/proxy-core.js";
import { parseToolPolicy, withToolFilter } from "../src/core/tool-filter.js";
import { createMcpAdapter } from "../src/http/adapter.js";
import { createAppHandler, startHttpServer } from "../src/http/index.js";
import { VERSION } from "../src/version.js";

const API_KEY = process.env.TINYFISH_API_KEY;
const UPSTREAM_URL = process.env.TINYFISH_UPSTREAM_URL ?? "https://agent.tinyfish.ai/mcp";

if (!API_KEY) {
  process.stderr.write(
    "\ntool-filter.integration: TINYFISH_API_KEY is not set — skipping the filter " +
      "integration suite (offline coverage runs via `npm test`).\n" +
      "Run with: TINYFISH_API_KEY=... npm run test:integration\n\n"
  );
}

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "tinyfish-mcp-lite-integration", version: VERSION },
};

/** Direct upstream POST, bypassing the proxy — the parity baseline. */
async function postUpstream(
  body: unknown,
  sessionId?: string
): Promise<{ status: number; sessionId: string | null; json: unknown }> {
  const response = await fetch(UPSTREAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-API-Key": API_KEY as string,
      "X-TF-Request-Origin": "tinyfish-mcp",
      "X-TF-Client-Name": "tinyfish-mcp",
      "X-TF-Client-Version": VERSION,
      ...(sessionId !== undefined ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    json: JSON.parse(await response.text()),
  };
}

const describeWithApiKey = API_KEY ? describe.sequential : describe.skip;

describeWithApiKey("tool filter integration (real hosted upstream, default policy)", () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  let mcpUrl: string;
  let sessionId: string;

  beforeAll(async () => {
    const core = withToolFilter(
      createProxyCore({ upstreamUrl: UPSTREAM_URL, apiKey: API_KEY as string, hooks: null }),
      parseToolPolicy(undefined) // the fork default: search + fetch_content only
    );
    server = await startHttpServer(0, createAppHandler(createMcpAdapter(core)));
    mcpUrl = `http://127.0.0.1:${listeningPort(server)}/mcp`;

    const init = await postJson(mcpUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: INITIALIZE_PARAMS,
    });
    expect(init.status).toBe(200);
    sessionId = init.sessionId as string;
    expect(sessionId).toBeTruthy();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const sessionHeaders = () => ({
    "Mcp-Session-Id": sessionId,
    "MCP-Protocol-Version": "2025-11-25",
  });

  it("tools/list advertises EXACTLY the two free tools, schemas identical to upstream's", async () => {
    const [viaProxy, direct] = await Promise.all([
      postJson(mcpUrl, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionHeaders()),
      postUpstream({ jsonrpc: "2.0", id: 99, method: "tools/list" }, sessionId),
    ]);
    expect(viaProxy.status).toBe(200);

    const proxied = JSON.parse(viaProxy.text) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const proxiedNames = proxied.result?.tools?.map((t) => t.name) ?? [];
    expect(proxiedNames.sort()).toEqual(["fetch_content", "search"]);

    // Parity, narrowed to allowed tools: each kept schema deep-equals the
    // direct upstream entry (no accidental mutation by the filter).
    const directTools = (
      (direct.json as { result?: { tools?: Array<Record<string, unknown>> } }).result?.tools ?? []
    ).filter((t) => proxiedNames.includes(t.name as string));
    expect(proxied.result?.tools).toEqual(directTools);

    // And the filter really dropped tools upstream still advertises (dynamic
    // comparison — the upstream catalog may grow or shrink; only "upstream
    // has strictly more than we expose" is the invariant).
    const directCount = ((direct.json as { result?: { tools?: unknown[] } }).result?.tools ?? [])
      .length;
    expect(directCount).toBeGreaterThan(proxiedNames.length);
  });

  it("tools/call of a paid tool is blocked LOCALLY — unknown-tool error, never invoked upstream", async () => {
    const result = await postJson(
      mcpUrl,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "run_web_automation",
          arguments: {
            url: "https://example.com",
            goal: "should never run",
            session_id: "00000000-0000-4000-8000-000000000000",
          },
          _meta: { progressToken: "pt" },
        },
      },
      sessionHeaders()
    );
    expect(result.status).toBe(400);
    expect(result.contentType).toContain("application/json"); // no SSE opened
    expect(JSON.parse(result.text)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32602, message: "Unknown tool: run_web_automation" },
      id: 3,
    });
  });

  it("free tools/call (search) still works through the filter", async () => {
    const result = await postJson(
      mcpUrl,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "search", arguments: { query: "tinyfish mcp server github", page: 0 } },
      },
      sessionHeaders()
    );
    expect(result.status).toBe(200);
    const body = JSON.parse(result.text) as {
      result?: { isError?: boolean; content?: Array<{ type: string }> };
      error?: { message: string };
    };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.content?.length).toBeGreaterThan(0);
  });
});
