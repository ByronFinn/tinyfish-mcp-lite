/**
 * FORK ADDITION (tinyfish-mcp-lite) — this module does not exist upstream.
 *
 * Idle-watchdog wrapper around the upstream fetch. Without it, a blackholed
 * upstream (the connection is accepted but no bytes ever arrive — dead
 * network, a firewall/proxy swallowing the request, or a hung server) makes
 * the single fetch call site in core/upstream.ts wait forever: fetch neither
 * resolves nor rejects, so a stdio client sees `initialize` with no response
 * and no error — the process just sits silent.
 *
 * The lite fork only exposes the two FREE tools (`search`, `fetch_content`),
 * which the hosted server answers as non-streaming JSON. So the two windows
 * that can stall for this fork are:
 *   1. waiting for the response headers, and
 *   2. waiting for the (JSON) body — including the gap BETWEEN body chunks
 *      while a large `fetch_content` result drains.
 *
 * The watchdog is an IDLE deadline, not a total budget: every received byte
 * re-arms the timer, so a slow-but-alive upstream (a large fetch_content
 * response arriving in pieces) is never cut, while a genuinely silent one is
 * bounded. A total budget would be wrong here — it cannot tell "slow" from
 * "dead" and would kill legitimate slow responses.
 *
 * Out of scope by design (SSE): `run_web_automation` — the only tool that
 * streams — is a PAID tool this fork hides behind the free-tool allowlist
 * (`TINYFISH_TOOLS=*` restores it). SSE responses are passed through
 * untouched, preserving today's byte-verbatim streaming behavior exactly; the
 * paid/streaming path is deliberately not something this fork adds timing
 * policy to. (The stdio adapter's own comment notes free tools never stream.)
 *
 * Wiring is a single seam — the injectable `fetchFn` of createProxyCore —
 * so no upstream file changes and `git merge upstream/main` stays trivial.
 * The injected wrapper's abort reason is an UpstreamTimeoutError (NOT an
 * AbortError), so the existing classification in core/upstream.ts turns it
 * into an UpstreamUnreachableError and the client still receives a normal
 * JSON-RPC `-32000` — the client-facing contract is unchanged.
 */
import type { FetchLike } from "./upstream.js";

/**
 * Abort reason for a watchdog timeout. Deliberately an `Error` whose `name`
 * is not "AbortError": core/upstream.ts's isAbortError() keys on that name to
 * classify LOCAL cancellations (session close / shutdown) as
 * UpstreamAbortedError, and a timeout must not be misreported as one.
 */
export class UpstreamTimeoutError extends Error {
  /** The idle window (ms) that elapsed with no upstream bytes. */
  readonly idleMs: number;

  constructor(idleMs: number) {
    super(`upstream sent no data within ${idleMs}ms`);
    this.name = "UpstreamTimeoutError";
    this.idleMs = idleMs;
  }
}

/**
 * Wrap a fetch so a silent upstream is aborted after `idleMs` of no bytes.
 *
 * `idleMs` undefined or <= 0 returns `fetchFn` unchanged (identity — zero
 * overhead, zero behavior change; used to disable the watchdog).
 *
 * The returned wrapper preserves the response verbatim: status, statusText,
 * and every header (including Mcp-Session-Id and Content-Type) survive the
 * body re-wrap, so nothing downstream can tell the difference on the happy
 * path.
 */
export function withUpstreamDeadline(fetchFn: FetchLike, idleMs?: number): FetchLike {
  if (idleMs === undefined || idleMs <= 0) return fetchFn;
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const watchdog = new AbortController();
    const reason = new UpstreamTimeoutError(idleMs);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => watchdog.abort(reason), idleMs);
      // Never hold the event loop open on the watchdog alone: the process must
      // still exit promptly when stdin closes with a request in flight.
      timer.unref?.();
    };
    const disarm = (): void => {
      clearTimeout(timer);
      timer = undefined;
    };

    arm(); // window 1: waiting for response headers
    // Compose with any caller signal (HTTP transport's client-disconnect
    // abort) so both cancellation paths fire the same fetch signal.
    const signal =
      init.signal !== undefined && init.signal !== null
        ? AbortSignal.any([init.signal, watchdog.signal])
        : watchdog.signal;

    let response: Response;
    try {
      response = await fetchFn(input, { ...init, signal });
    } catch (err) {
      // Covers both the headers deadline (reason surfaces verbatim) and any
      // upstream transport failure (propagated untouched).
      disarm();
      throw err;
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    // Empty body (204) and SSE: nothing this fork needs to bound. SSE is the
    // paid/streaming path — pass it through untouched (see module comment).
    if (response.body === null || contentType.startsWith("text/event-stream")) {
      disarm();
      return response;
    }

    // window 2: the JSON body — re-arm on every chunk so a slow-but-alive
    // stream survives while a stalled one (headers arrived, then silence) is
    // bounded.
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          arm();
          controller.enqueue(chunk);
        },
        flush() {
          disarm();
        },
      })
    );
    // A caller-triggered abort — the HTTP transport's client-disconnect signal
    // or the core's session close/shutdown — retires the watchdog. (A bare
    // consumer cancel propagates to the source stream, which closes the
    // upstream socket; the unref'd timer then just fires harmlessly against an
    // already-dead request, so it needs no separate hook.)
    signal.addEventListener("abort", disarm, { once: true });

    // Rebuild with explicit init: this preserves status/statusText and ALL
    // headers (the `new Response(body, response)` short form drops the URL and
    // is avoided for clarity).
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
