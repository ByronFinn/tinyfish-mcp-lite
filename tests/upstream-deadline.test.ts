/**
 * FORK ADDITION (tinyfish-mcp-lite): tests for the upstream idle watchdog
 * (src/core/upstream-deadline.ts).
 *
 * These drive the REAL UpstreamClient over a local node:http upstream, so the
 * assertions cover the full path: dead upstream → wrapper abort →
 * toTransportError classification → the error the client-facing shaping layer
 * would relay. No network access required.
 *
 * The behavior under test exists precisely because lite only exposes the two
 * FREE tools (`search`, `fetch_content`), which are non-streaming JSON — so
 * the watchdog bounds the header wait and the JSON-body wait, and deliberately
 * leaves SSE (the paid `run_web_automation` path) untouched.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UpstreamTimeoutError, withUpstreamDeadline } from "../src/core/upstream-deadline.js";
import { UpstreamUnreachableError } from "../src/core/errors.js";
import { UpstreamClient, type FetchLike } from "../src/core/upstream.js";

const API_KEY = "sk-unit-secret-0123";
const PING = { jsonrpc: "2.0", id: 1, method: "ping" };

/** A listening local upstream + its URL; always closed in afterEach. */
let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

/** Start a local upstream whose per-path handler mimics the real shapes. */
async function startUpstream(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const created = createServer(handler);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", () => resolve()));
  const address = created.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

function clientFor(url: string, idleMs?: number): UpstreamClient {
  return new UpstreamClient({
    url,
    apiKey: API_KEY,
    fetchFn: withUpstreamDeadline(globalThis.fetch, idleMs),
  });
}

describe("withUpstreamDeadline", () => {
  it("is the identity function when disabled (undefined or <= 0)", () => {
    const fetchFn = (() => Promise.reject(new Error("unused"))) as unknown as FetchLike;
    expect(withUpstreamDeadline(fetchFn, undefined)).toBe(fetchFn);
    expect(withUpstreamDeadline(fetchFn, 0)).toBe(fetchFn);
    expect(withUpstreamDeadline(fetchFn, -5)).toBe(fetchFn);
  });

  it("aborts a blackholed upstream with UpstreamTimeoutError, not AbortError", async () => {
    // Accepts the connection and never writes a byte.
    const base = await startUpstream(() => {
      /* intentionally never responds */
    });
    const wrapped = withUpstreamDeadline(globalThis.fetch, 200);
    const err = await wrapped(`${base}/mcp`, { method: "POST", body: "{}" }).then(
      () => {
        throw new Error("the watchdog did not fire");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    // Must NOT be classified as a local abort by the core's isAbortError().
    expect((err as Error).name).not.toBe("AbortError");
    expect((err as UpstreamTimeoutError).idleMs).toBe(200);
  });

  it("preserves status, statusText and every header on the happy path", async () => {
    const base = await startUpstream((_req, res) => {
      res.writeHead(200, "OK", {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "sess-42",
        "X-Custom": "keep-me",
      });
      res.end('{"jsonrpc":"2.0","result":{"ok":1},"id":1}');
    });
    const wrapped = withUpstreamDeadline(globalThis.fetch, 5_000);
    const response = await wrapped(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("mcp-session-id")).toBe("sess-42");
    expect(response.headers.get("x-custom")).toBe("keep-me");
    expect(await response.text()).toBe('{"jsonrpc":"2.0","result":{"ok":1},"id":1}');
  });

  it("passes a 204 (no body) through untouched", async () => {
    const base = await startUpstream((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const wrapped = withUpstreamDeadline(globalThis.fetch, 5_000);
    const response = await wrapped(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("does not cut a slow-but-alive JSON body (re-arm on every chunk)", async () => {
    // Three chunks 120ms apart (total 360ms) with a 200ms idle window: a total
    // budget would kill it; the idle watchdog must not.
    const base = await startUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders();
      let i = 0;
      const timer = setInterval(() => {
        i += 1;
        if (i === 3) {
          clearInterval(timer);
          res.end('"done"]}');
        } else if (i === 1) {
          res.write('{"chunks":[');
        } else {
          res.write('"c",');
        }
      }, 120);
      res.on("close", () => clearInterval(timer));
    });
    const wrapped = withUpstreamDeadline(globalThis.fetch, 200);
    const response = await wrapped(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(await response.text()).toBe('{"chunks":["c","done"]}');
  });

  it("leaves an SSE stream untouched even when frame gaps exceed the idle window", async () => {
    // The paid/streaming path: frames 300ms apart with a 150ms idle window.
    // The watchdog disarms on SSE, so this must drain completely.
    const base = await startUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        res.write(`data: {"n":${n}}\n\n`);
        if (n === 3) {
          clearInterval(timer);
          res.end();
        }
      }, 300);
      res.on("close", () => clearInterval(timer));
    });
    const wrapped = withUpstreamDeadline(globalThis.fetch, 150);
    const response = await wrapped(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text.trim().split("\n\n")).toHaveLength(3);
  });
});

describe("UpstreamClient under the watchdog", () => {
  it("bounds initialize against a blackholed upstream and stays a -32000-class failure", async () => {
    const base = await startUpstream(() => {
      /* never responds */
    });
    const client = clientFor(`${base}/mcp`, 200);
    const err = await client.post({ ...PING, method: "initialize" }).then(
      () => {
        throw new Error("should have timed out");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(UpstreamUnreachableError);
    expect((err as Error).message).toContain("upstream sent no data within 200ms");
    expect((err as Error).message).not.toContain(API_KEY);
  });

  it("bounds a body that stalls after headers arrived", async () => {
    const base = await startUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders();
      res.write('{"partial":'); // then silence
    });
    const client = clientFor(`${base}/mcp`, 200);
    const err = await client.post(PING).then(
      () => {
        throw new Error("should have timed out");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(UpstreamUnreachableError);
  });

  it("delivers a normal JSON response (session header intact) when the watchdog is set", async () => {
    const base = await startUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "up-1" });
      res.end('{"jsonrpc":"2.0","result":{},"id":1}');
    });
    const client = clientFor(`${base}/mcp`, 5_000);
    const response = await client.post(PING);
    expect(response.kind).toBe("json");
    if (response.kind !== "json") throw new Error("expected a JSON response");
    expect(response.status).toBe(200);
    expect(response.sessionId).toBe("up-1");
  });
});
