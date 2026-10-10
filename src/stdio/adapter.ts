/**
 * FORK ADDITION (tinyfish-mcp-lite) — this module does not exist upstream.
 *
 * stdio transport: spawn-and-forget mode for MCP clients that launch their
 * servers as commands. The client owns the process lifecycle (stdin closed ⇒
 * shutdown), no port to manage, no server to start by hand. Newline-delimited
 * JSON-RPC on stdin/stdout per the MCP stdio spec; every log goes to stderr
 * (log.ts) so stdout stays protocol-pure — log.ts documents exactly this
 * contract ("stdout stays clean for a future stdio transport").
 *
 * Routing mirrors the HTTP adapter's route() one-to-one (notifications →
 * notify BEFORE any tools/call check; initialize → initialize; tools/call →
 * forwardStream; everything else, including forbidden batch arrays and
 * shapeless bodies, → forward), so the withToolFilter decorator covers both
 * transports identically: tools/list filtered, hidden tools/call answered
 * locally, notification-shaped calls dropped, batches rejected — see
 * tests/stdio.test.ts and tests/tool-filter.test.ts.
 *
 * Differences from the HTTP hop that are intrinsic to stdio:
 * - No status codes, no headers: upstream's JSON-RPC body is the message;
 *   a JSON-RPC error body relays verbatim, and failures upstream never
 *   answered as JSON-RPC are shaped through toJsonRpcError (same as HTTP).
 * - One client, one session: the localKey is the constant "stdio" — the
 *   core stores the upstream session id on that entry at initialize and
 *   replays it on every later call. No Mcp-Session-Id plumbing exists here.
 * - A parse error answers with id null (JSON-RPC rule for unparseable
 *   input) rather than the HTTP hop's -1: there is no upstream shape to
 *   stay byte-compatible with on this transport.
 * - Progress notifications from a streamed tools/call relay to stdout as
 *   ordinary JSON-RPC notification lines (MCP stdio allows server → client
 *   notifications any time), serialized through the same write queue as
 *   responses.
 *
 * Writes are queued (requests dispatch concurrently — a slow search must not
 * stall pings — so responses may become ready out of order, which JSON-RPC
 * ids disambiguate), and each write respects pipe backpressure: a full
 * tools/list line is far larger than PIPE_BUF, so writes must never overlap
 * mid-line. stdin end drains the queue before the run promise resolves, so
 * the caller's exit never truncates a half-written response.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ProxyCoreError, toJsonRpcError } from "../core/errors.js";
import { requestIdOf, type OnEvent, type ProxyCore } from "../core/proxy-core.js";
import { log } from "../log.js";

/** stdio serves exactly one client, so the local session key is a constant. */
const SESSION_KEY = "stdio";

export interface StdioStreams {
  input: Readable;
  output: Writable;
}

/**
 * Run the transport until `streams.input` ends (the client closed its pipe —
 * MCP stdio shutdown) or `streams.output` errors (EPIPE: the client died
 * without closing stdin). Resolves void; the caller runs shutdown hooks and
 * exits.
 */
export function runStdioTransport(
  core: ProxyCore,
  streams: StdioStreams = { input: process.stdin, output: process.stdout }
): Promise<void> {
  let resolveRun!: () => void;
  const run = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });

  let writeChain: Promise<void> = Promise.resolve();
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    input.close();
    // Drain pending writes before resolving: the caller exits right after,
    // and process.exit would truncate an in-flight line.
    void writeChain.finally(() => resolveRun());
  };

  const enqueue = (message: unknown): void => {
    writeChain = writeChain
      .then(() => writeLine(streams.output, message))
      .catch((err) => {
        // A failed stdout write means the local client is dying (EPIPE);
        // the output 'error' handler finishes the transport.
        log.warn(`writing to stdout failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  };

  // Relayed SSE progress frames (free tools never stream today, but the
  // relay must exist so the stdio path can never orphan upstream progress).
  const onEvent: OnEvent = (event) => {
    enqueue(event);
  };

  async function handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Unparseable input: the one message answered without forwarding.
      enqueue({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: Invalid JSON" },
        id: null,
      });
      return;
    }

    try {
      if (isNotification(message)) {
        await core.notify(SESSION_KEY, message);
        return;
      }

      const method = methodOf(message);

      if (method === "initialize") {
        const response = await core.initialize(SESSION_KEY, message, protocolVersionOf(message));
        enqueue(response.body);
        return;
      }

      if (method === "tools/call") {
        const response = await core.forwardStream(SESSION_KEY, message, onEvent);
        enqueue(response.body);
        return;
      }

      // Everything else — ping, tools/list, resources/*, client responses to
      // (never-initiated) server requests, unknown methods, and batch arrays —
      // forwards generically, byte-for-byte the HTTP adapter's fallthrough.
      const response = await core.forward(SESSION_KEY, message);
      enqueue(response.body);
    } catch (err) {
      // Same classification as the HTTP adapter: classified core errors log
      // their message; anything else is a proxy bug (full stack, generic
      // InternalError to the client).
      if (err instanceof ProxyCoreError) {
        log.warn(err.message);
      } else {
        log.error(
          `proxy bug (client got a generic InternalError): ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`
        );
      }
      enqueue(toJsonRpcError(err, requestIdOf(message)).body);
    }
  }

  const input = createInterface({ input: streams.input });
  input.on("line", (line) => {
    void handleLine(line);
  });
  input.on("close", finish);
  streams.output.on("error", (err) => {
    log.warn(
      `stdout error (client went away?): ${err instanceof Error ? err.message : String(err)}`
    );
    finish();
  });

  return run;
}

/** One JSON-RPC message per line; resolves on kernel-buffer flush or drain. */
function writeLine(output: Writable, message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = output.write(`${JSON.stringify(message)}\n`, (err) =>
      err ? reject(err) : resolve()
    );
    if (!ok) output.once("drain", () => resolve());
  });
}

/** JSON-RPC notification: an object with a method and no id key (upstream's rule). */
function isNotification(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    !Array.isArray(message) &&
    typeof (message as { method?: unknown }).method === "string" &&
    !("id" in message)
  );
}

function methodOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const method = (message as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

/** `initialize.params.protocolVersion`, when the client sent one. */
function protocolVersionOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const params = (message as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return undefined;
  const version = (params as { protocolVersion?: unknown }).protocolVersion;
  return typeof version === "string" ? version : undefined;
}
