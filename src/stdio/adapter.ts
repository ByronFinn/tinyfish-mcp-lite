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
 *   A notification whose upstream hop fails writes NOTHING — JSON-RPC forbids
 *   replying to notifications, and an id-null error line would be protocol
 *   garbage to an id-dispatching client; the failure is logged to stderr.
 * - One client, one session: the localKey is the empty string — the same
 *   session-less shape the HTTP hop uses — so before initialize bridges the
 *   real upstream session id, upstream.post omits Mcp-Session-Id entirely and
 *   no adapter-invented id can reach the wire. While an initialize round-trip
 *   is outstanding, further lines are queued (JSON-RPC pipelining is legal,
 *   and the MCP lifecycle even allows pings in this window) and dispatched in
 *   arrival order once it settles, so they ride the bridged upstream session.
 * - A parse error answers with id null (JSON-RPC rule for unparseable input)
 *   rather than the HTTP hop's -1: there is no upstream shape to stay
 *   byte-compatible with on this transport.
 * - Progress notifications from a streamed tools/call relay to stdout as
 *   ordinary JSON-RPC notification lines (MCP stdio allows server → client
 *   notifications any time). onEvent returns the write promise so the core's
 *   frame loop awaits each relayed frame — stdout backpressure propagates to
 *   the upstream stream (the OnEvent contract) and a dead stdout surfaces as
 *   LocalWriteError instead of being silently swallowed.
 *
 * Writes are queued (requests dispatch concurrently — a slow search must not
 * stall pings — so responses may become ready out of order, which JSON-RPC
 * ids disambiguate; the queue serializes the write() calls, so lines can
 * never interleave mid-line) and each write respects pipe backpressure.
 * Shutdown (stdin close, stdin error, stdout error or close) aborts in-flight
 * upstream fetches via core.close, waits for the outstanding handlers so
 * their final (often error) responses still reach a client that is draining
 * stdout, then drains the write queue before resolving — the caller's exit
 * never truncates a half-written line.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ProxyCoreError, toJsonRpcError } from "../core/errors.js";
import { requestIdOf, type OnEvent, type ProxyCore } from "../core/proxy-core.js";
import { log } from "../log.js";

/** stdio serves exactly one client; "" matches the HTTP hop's session-less shape. */
const SESSION_KEY = "";

export interface StdioStreams {
  input: Readable;
  output: Writable;
}

/**
 * Run the transport until `streams.input` ends or errors (the client closed
 * or lost its pipe — MCP stdio shutdown) or `streams.output` errors/closes
 * (EPIPE: the client died without closing stdin). Resolves void; the caller
 * runs shutdown hooks and exits.
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
  let inflight = 0;
  let inflightSettled: (() => void) | null = null;
  let initGate: Promise<void> | null = null;
  const gatedLines: string[] = [];

  /**
   * Chain a write onto the queue and hand the promise back — onEvent returns
   * it so upstream SSE frames are relayed one awaited write at a time.
   */
  const enqueue = (message: unknown): Promise<void> => {
    const write = writeChain.then(() => writeLine(streams.output, message));
    // Keep the queue alive after a failed write (dying client); `write`
    // itself still rejects, preserving the LocalWriteError contract.
    writeChain = write.then(
      () => undefined,
      () => undefined
    );
    return write;
  };

  /** Fire-and-forget enqueue for responses; a failed stdout write is logged. */
  const emit = (message: unknown): void => {
    void enqueue(message).catch((err) => {
      log.warn(`writing to stdout failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    input.close();
    void (async () => {
      // Abort in-flight upstream fetches for this session so the handlers
      // below settle promptly (idempotent — the caller's shutdown hooks run
      // core.closeAll() on top, covering the rest of the session store).
      core.close(SESSION_KEY);
      // Let the outstanding handlers land their final responses before the
      // drain below captures the queue, so a client still draining stdout
      // receives them instead of a truncated stream.
      if (inflight > 0) {
        await new Promise<void>((resolve) => {
          inflightSettled = resolve;
        });
      }
      await writeChain;
      resolveRun();
    })();
  };

  const settleInflight = (): void => {
    inflight -= 1;
    if (inflight === 0 && inflightSettled !== null) {
      const settle = inflightSettled;
      inflightSettled = null;
      settle();
    }
  };

  // Relayed SSE progress frames (free tools never stream today, but the
  // relay must exist so the stdio path can never orphan upstream progress).
  const onEvent: OnEvent = (event) => enqueue(event);

  async function routeMessage(message: unknown): Promise<void> {
    try {
      if (isNotification(message)) {
        await core.notify(SESSION_KEY, message);
        return;
      }

      const method = methodOf(message);

      if (method === "initialize") {
        const response = await core.initialize(SESSION_KEY, message, protocolVersionOf(message));
        emit(response.body);
        return;
      }

      if (method === "tools/call") {
        const response = await core.forwardStream(SESSION_KEY, message, onEvent);
        emit(response.body);
        return;
      }

      // Everything else — ping, tools/list, resources/*, client responses to
      // (never-initiated) server requests, unknown methods, and batch arrays —
      // forwards generically, byte-for-byte the HTTP adapter's fallthrough.
      const response = await core.forward(SESSION_KEY, message);
      emit(response.body);
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
      // A notification has no response channel — JSON-RPC forbids replying
      // to one, so its upstream failure only logs (see module comment).
      if (!isNotification(message)) {
        emit(toJsonRpcError(err, requestIdOf(message)).body);
      }
    }
  }

  async function dispatchMessage(message: unknown): Promise<void> {
    inflight += 1;
    try {
      await routeMessage(message);
    } finally {
      settleInflight();
    }
  }

  function handleLine(line: string): void {
    if (finished) return;
    const trimmed = line.trim();
    if (trimmed === "") return;

    if (initGate !== null) {
      // Pipelined behind an in-flight initialize: queued, dispatched in
      // arrival order once it settles (see module comment).
      gatedLines.push(trimmed);
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Unparseable input: the one message answered without forwarding.
      emit({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: Invalid JSON" },
        id: null,
      });
      return;
    }

    if (!isNotification(message) && methodOf(message) === "initialize") {
      // Install the gate before any await so lines arriving during the
      // round-trip hit the queue above, then flush it in order.
      const gate = dispatchMessage(message);
      initGate = gate;
      void gate.finally(() => {
        initGate = null;
        if (!finished) {
          for (const queued of gatedLines.splice(0)) handleLine(queued);
        }
      });
      return;
    }

    void dispatchMessage(message);
  }

  const input = createInterface({ input: streams.input });
  input.on("line", (line) => {
    handleLine(line);
  });
  // readline re-emits an input-stream error here; without this listener the
  // 'error' event is unhandled (crash, hooks never run) and 'close' never
  // fires afterwards — hence the explicit finish().
  input.on("error", (err) => {
    log.warn(`stdin error: ${err instanceof Error ? err.message : String(err)}`);
    finish();
  });
  input.on("close", finish);
  streams.output.on("error", (err) => {
    log.warn(
      `stdout error (client went away?): ${err instanceof Error ? err.message : String(err)}`
    );
    finish();
  });
  // stdout destroyed without an error event (silent destroy): still shut down.
  streams.output.on("close", finish);

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
