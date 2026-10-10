/**
 * FORK ADDITION (tinyfish-mcp-lite): tests for the stdio transport
 * (src/stdio/adapter.ts). In-process tests drive runStdioTransport over
 * PassThrough streams against the shared mock upstream — the same harness as
 * tool-filter.test.ts — so "the blocked call never left the process" is
 * asserted via mock.seen, and session bridging (initialize → replayed
 * Mcp-Session-Id) is proven by the mock rejecting session-less requests.
 * One end-to-end test spawns the real entrypoint (`src/index.ts --stdio`
 * under tsx) to cover argv wiring, stdout purity and exit-on-stdin-close.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProxyCore } from "../src/core/proxy-core.js";
import { parseToolPolicy, withToolFilter } from "../src/core/tool-filter.js";
import { runStdioTransport } from "../src/stdio/adapter.js";
import {
  MOCK_INITIALIZE_RESULT,
  startMockUpstream,
  type MockUpstream,
} from "./helpers/mock-upstream.js";

const API_KEY = "test-key";
const INDEX_TS = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

/** Collects newline-delimited stdout messages with a timeout on the next line. */
class LineReader {
  private buffer = "";
  private readonly queue: string[] = [];
  private readonly waiters: Array<{ resolve: (line: string) => void }> = [];

  constructor(output: PassThrough) {
    // Decode as utf8 across chunk boundaries (mock tool results may carry
    // non-ASCII); chunk.toString("utf8") would corrupt split multibyte chars.
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => this.push(chunk));
  }

  private push(chunk: string): void {
    this.buffer += chunk;
    let newlineAt = this.buffer.indexOf("\n");
    while (newlineAt !== -1) {
      const line = this.buffer.slice(0, newlineAt);
      this.buffer = this.buffer.slice(newlineAt + 1);
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter.resolve(line);
      else this.queue.push(line);
      newlineAt = this.buffer.indexOf("\n");
    }
  }

  next(timeoutMs = 5000): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a stdout line")),
        timeoutMs
      );
      this.waiters.push({
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  }

  /** Passes when NO line arrives within the window (notifications are silent). */
  async expectSilence(ms = 250): Promise<void> {
    if (this.queue.length > 0) throw new Error("expected silence, but a line is already queued");
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.queue.length > 0) throw new Error("expected silence, but a line arrived");
  }
}

describe("stdio transport (mock upstream)", () => {
  let mock: MockUpstream;

  beforeAll(async () => {
    mock = await startMockUpstream();
  });

  afterAll(async () => {
    await mock.close();
  });

  interface Transport {
    input: PassThrough;
    reader: LineReader;
    run: Promise<void>;
    send(message: unknown): void;
  }

  function startTransport(policy: string): Transport {
    const input = new PassThrough();
    const output = new PassThrough();
    const core = withToolFilter(
      createProxyCore({ upstreamUrl: mock.url, apiKey: API_KEY, hooks: null }),
      parseToolPolicy(policy)
    );
    const reader = new LineReader(output);
    const run = runStdioTransport(core, { input, output });
    return { input, reader, run, send: (message) => input.write(`${JSON.stringify(message)}\n`) };
  }

  it("initialize + tools/list: free-tool filter applied, upstream session replayed", async () => {
    const t = startTransport("echo");
    t.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stdio-test", version: "1" },
      },
    });
    const initLine = JSON.parse(await t.reader.next());
    expect(initLine.id).toBe(1);
    expect(initLine.result).toEqual(MOCK_INITIALIZE_RESULT);

    t.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listLine = JSON.parse(await t.reader.next());
    expect(listLine.id).toBe(2);
    expect(listLine.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo"]);

    // Session bridging: initialize arrives header-less (the mock mints a
    // UUID for it and records the minted value), and the tools/list request
    // must REPLAY that same id on the wire — the mock never mints for
    // non-initialize methods (a session-less one is rejected outright), so
    // equal ids can only mean the core bridged the session.
    expect(mock.seen[0].method).toBe("initialize");
    expect(mock.seen[1].method).toBe("tools/list");
    expect(mock.seen[1].sessionId).toBe(mock.seen[0].sessionId);

    t.input.end();
    await t.run;
  });

  it("tools/call of a hidden tool is answered locally — never sent upstream", async () => {
    const t = startTransport("echo");
    t.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    await t.reader.next();

    const seenBefore = mock.seen.length;
    t.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "run_web_automation", arguments: { goal: "should never run" } },
    });
    const line = JSON.parse(await t.reader.next());
    expect(line).toEqual({
      jsonrpc: "2.0",
      error: { code: -32602, message: "Unknown tool: run_web_automation" },
      id: 2,
    });
    expect(mock.seen.length).toBe(seenBefore);

    t.input.end();
    await t.run;
  });

  it("notifications forward upstream silently — no stdout line is written", async () => {
    const t = startTransport("echo");
    t.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    await t.reader.next();

    t.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("notification never reached upstream")),
        3000
      );
      const check = () => {
        if (mock.seen.some((entry) => entry.method === "notifications/initialized")) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(check, 20);
        }
      };
      check();
    });
    // The notification itself writes nothing; the next line is the ping's
    // response, proving no phantom message was enqueued for it.
    await t.reader.expectSilence();
    t.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    const pingLine = JSON.parse(await t.reader.next());
    expect(pingLine.id).toBe(2);

    t.input.end();
    await t.run;
  });

  it("unparseable input answers -32700 with id null and keeps serving", async () => {
    const t = startTransport("echo");
    t.input.write("this is not json\n");
    const line = JSON.parse(await t.reader.next());
    expect(line).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: Invalid JSON" },
      id: null,
    });

    // Still alive afterwards.
    t.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(JSON.parse(await t.reader.next()).id).toBe(1);

    t.input.end();
    await t.run;
  });

  it("a batch array carrying a hidden call is rejected locally (-32600)", async () => {
    const t = startTransport("echo");
    t.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    await t.reader.next();

    const seenBefore = mock.seen.length;
    t.send({
      jsonrpc: "2.0",
      id: 2,
      method: "ping",
    });
    // Keep the batch on the same connection after a valid request: only the
    // batch must fail, and the valid one must still succeed — both responses
    // are consumed and asserted (order is not guaranteed; ids disambiguate).
    t.send([
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "run_web_automation", arguments: { goal: "nope" } },
      },
    ]);
    const responses = [JSON.parse(await t.reader.next()), JSON.parse(await t.reader.next())];
    const batchLine = responses.find((line) => line.id === -1);
    const pingLine = responses.find((line) => line.id === 2);
    expect(batchLine?.error?.code).toBe(-32600);
    expect(pingLine?.result).toBeDefined();
    // The ping legitimately reached upstream; the batch must not have.
    expect(mock.seen.length).toBe(seenBefore + 1);
    expect(mock.seen[mock.seen.length - 1].method).toBe("ping");

    t.input.end();
    await t.run;
  });

  it("notification-shaped tools/call of a hidden tool is dropped locally (no upstream hop)", async () => {
    const t = startTransport("echo");
    t.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    await t.reader.next();

    const seenBefore = mock.seen.length;
    t.send({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "run_web_automation", arguments: { goal: "fire-and-forget" } },
    });
    // No response channel for notifications — silence on stdout, and the
    // decorator's drop means mock.seen must not grow.
    await t.reader.expectSilence();
    expect(mock.seen.length).toBe(seenBefore);

    t.input.end();
    await t.run;
  });

  it("streamed tools/call relays progress notifications then the final response", async () => {
    // Policy = the streaming tool itself: the only path where the mock
    // streams SSE, exercising the onEvent → stdout relay end to end.
    const t = startTransport("run_web_automation");
    t.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    await t.reader.next();

    t.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "run_web_automation",
        arguments: { goal: "stream me" },
        _meta: { progressToken: "pt" },
      },
    });

    const lines: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 4; i += 1) {
      lines.push(JSON.parse(await t.reader.next()));
    }
    const progress = lines.slice(0, 3);
    for (const frame of progress) {
      expect(frame.method).toBe("notifications/progress");
      expect((frame.params as { progressToken?: string }).progressToken).toBe("pt");
    }
    const final = lines[3];
    expect(final.id).toBe(2);
    expect(final.error).toBeUndefined();

    t.input.end();
    await t.run;
  });

  it("stdin end resolves the run promise (client-owned lifecycle)", async () => {
    const t = startTransport("echo");
    t.input.end();
    await t.run;
  });

  it("a pipelined ping during the initialize round-trip rides the bridged session", async () => {
    // JSON-RPC allows pipelining and the MCP lifecycle allows pings in this
    // window; the gate must hold the ping until initialize settles so it
    // forwards with the bridged upstream session (the mock rejects
    // session-less non-initialize requests, so a leak would error here).
    const t = startTransport("echo");
    const seenBefore = mock.seen.length;
    t.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    t.send({ jsonrpc: "2.0", id: 2, method: "ping" });

    const initLine = JSON.parse(await t.reader.next());
    expect(initLine.id).toBe(1);
    const pingLine = JSON.parse(await t.reader.next());
    expect(pingLine.id).toBe(2);
    expect(pingLine.result).toBeDefined();

    const initEntry = mock.seen[seenBefore];
    const pingEntry = mock.seen[seenBefore + 1];
    expect(initEntry.method).toBe("initialize");
    expect(pingEntry.method).toBe("ping");
    expect(pingEntry.sessionId).toBe(initEntry.sessionId);

    t.input.end();
    await t.run;
  });

  it("a notification whose upstream hop fails writes no stdout line", async () => {
    // JSON-RPC forbids replying to notifications: the transport error is
    // stderr-logged only, never an id-null error line on stdout.
    const input = new PassThrough();
    const output = new PassThrough();
    const deadCore = withToolFilter(
      createProxyCore({ upstreamUrl: "http://127.0.0.1:1/mcp", apiKey: API_KEY, hooks: null }),
      parseToolPolicy("echo")
    );
    const reader = new LineReader(output);
    const run = runStdioTransport(deadCore, { input, output });

    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await reader.expectSilence(300);

    input.end();
    await run;
  });

  it("backpressure (write() === false) still delivers every line and resolves after stdin end", async () => {
    const input = new PassThrough();
    // 1-byte high-water mark: every meaningful write reports false and must
    // wait for drain; the reader keeps draining, so nothing stalls.
    const output = new PassThrough({ highWaterMark: 1 });
    const core = withToolFilter(
      createProxyCore({ upstreamUrl: mock.url, apiKey: API_KEY, hooks: null }),
      parseToolPolicy("echo")
    );
    const reader = new LineReader(output);
    const run = runStdioTransport(core, { input, output });
    const send = (message: unknown): void => {
      input.write(`${JSON.stringify(message)}\n`);
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const initLine = JSON.parse(await reader.next());
    expect(initLine.id).toBe(1);

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listLine = JSON.parse(await reader.next());
    expect(listLine.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo"]);

    input.end();
    await run;
  });
});

describe("stdio transport (spawned entrypoint end-to-end)", () => {
  let mock: MockUpstream;

  beforeAll(async () => {
    mock = await startMockUpstream();
  });

  afterAll(async () => {
    await mock.close();
  });

  it("src/index.ts --stdio serves the filtered proxy and exits on stdin close", async () => {
    const child = spawn(process.execPath, [TSX_CLI, INDEX_TS, "--stdio"], {
      env: {
        ...process.env,
        TINYFISH_API_KEY: API_KEY,
        TINYFISH_UPSTREAM_URL: mock.url,
        TINYFISH_TOOLS: "echo",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const reader = new LineReader(child.stdout as unknown as PassThrough);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "spawn-test", version: "1" },
      },
    });
    const initLine = JSON.parse(await reader.next());
    expect(initLine.id).toBe(1);
    expect(initLine.result).toEqual(MOCK_INITIALIZE_RESULT);

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listLine = JSON.parse(await reader.next());
    expect(listLine.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo"]);

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "run_web_automation", arguments: { goal: "blocked locally" } },
    });
    const blockedLine = JSON.parse(await reader.next());
    expect(blockedLine.error.code).toBe(-32602);

    // Startup logs go to stderr only — stdout carried protocol lines alone.
    expect(stderr).toContain("stdio transport");
    expect(stderr).toContain("tool filter: exposing [echo]");

    child.stdin.end();
    const [code] = await new Promise<[number | null]>((resolve) => {
      child.on("exit", (code) => resolve([code]));
    });
    expect(code).toBe(0);
  }, 20000);
});

describe("stdio transport (published dist smoke)", () => {
  // Guards the shipped artifact, not just tsx+src: a stale dist/ without the
  // --stdio branch would silently fall back to HTTP mode and hang here —
  // exactly the failure mode that once passed the whole suite green. CI runs
  // build before test; locally the suite skips when dist/ does not exist yet.
  const distIndex = fileURLToPath(new URL("../dist/index.js", import.meta.url));

  it.skipIf(!existsSync(distIndex))(
    "dist/index.js --stdio serves the filtered proxy and exits on stdin close",
    async () => {
      const mock = await startMockUpstream();
      const child = spawn(process.execPath, [distIndex, "--stdio"], {
        env: {
          ...process.env,
          TINYFISH_API_KEY: API_KEY,
          TINYFISH_UPSTREAM_URL: mock.url,
          TINYFISH_TOOLS: "echo",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const reader = new LineReader(child.stdout as unknown as PassThrough);
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "dist-smoke", version: "1" },
          },
        })}\n`
      );
      const initLine = JSON.parse(await reader.next());
      expect(initLine.id).toBe(1);
      expect(initLine.result).toEqual(MOCK_INITIALIZE_RESULT);
      expect(stderr).toContain("stdio transport");

      child.stdin.end();
      const [code] = await new Promise<[number | null]>((resolve) => {
        child.on("exit", (code) => resolve([code]));
      });
      expect(code).toBe(0);
      await mock.close();
    },
    20000
  );
});
