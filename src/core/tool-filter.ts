/**
 * FORK ADDITION (tinyfish-mcp-lite) — this module does not exist upstream.
 *
 * Free-tool allowlist for the fork: the hosted TinyFish server exposes 28
 * tools, but only `search` and `fetch_content` are free — every other tool
 * costs credits the account may not have, while its schema still lands in
 * the client's context and burns tokens on each session (filtering to the
 * two free tools cuts the tools/list payload by ~72%). This module hides
 * everything else from the client AND blocks calls to hidden tools locally,
 * so a hallucinated tool name can never reach the paid upstream path.
 *
 * Design constraints (see FORK.md):
 * - Upstream files stay untouched except the two-line wiring in index.ts —
 *   all fork logic lives in this fork-owned module, so `git merge
 *   upstream/main` stays conflict-free by construction.
 * - Implemented as a ProxyCore decorator, not an adapter change: the adapter
 *   routes every tools/call through forwardStream and every tools/list
 *   through forward, so decorating those two methods covers both directions
 *   (advertise and invoke) without touching request parsing or SSE relay.
 * - TINYFISH_TOOLS="*" restores byte-identical upstream passthrough.
 */
import { ConfigError } from "../config.js";
import { log } from "../log.js";
import { requestIdOf, type ProxyCore, type ProxyResponse } from "./proxy-core.js";

/** The two tools the hosted server serves for free. */
export const DEFAULT_ALLOWED_TOOLS: readonly string[] = ["search", "fetch_content"];

/** Env var: comma-separated tool allowlist, or "*" to disable filtering. */
export const TOOLS_ENV_VAR = "TINYFISH_TOOLS";

/**
 * `allow` exposes only the listed tools (insertion-ordered for the startup
 * log); `passthrough` disables the filter entirely (upstream verbatim).
 */
export type ToolPolicy = { mode: "allow"; allowed: ReadonlySet<string> } | { mode: "passthrough" };

/** Tool names MCP permits: letters, digits, `_`, `-`, `.` (defensive superset). */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Parse TINYFISH_TOOLS. Undefined → the free-tool default; "*" → passthrough;
 * otherwise a strict comma-separated list (each entry trimmed, deduped,
 * order-preserving). Throws ConfigError with an actionable message on
 * malformed input — same contract as parseConfig in config.ts.
 */
export function parseToolPolicy(raw: string | undefined): ToolPolicy {
  if (raw === undefined) {
    return { mode: "allow", allowed: new Set(DEFAULT_ALLOWED_TOOLS) };
  }
  const value = raw.trim();
  if (value === "*") {
    return { mode: "passthrough" };
  }
  if (value === "") {
    throw new ConfigError(
      `Invalid ${TOOLS_ENV_VAR} "${raw}" — list at least one tool name (comma-separated) or "*" for all upstream tools`
    );
  }
  const seen = new Set<string>();
  for (const entry of value.split(",")) {
    const name = entry.trim();
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new ConfigError(
        `Invalid ${TOOLS_ENV_VAR} entry "${entry}" — tool names may contain only letters, digits, "_", "-", "."`
      );
    }
    seen.add(name);
  }
  return { mode: "allow", allowed: seen };
}

/**
 * Wrap a ProxyCore with the policy. Passthrough returns the core itself
 * (identity — zero overhead, zero behavior change). Otherwise every
 * tools/list response has non-allowed tools stripped (result key order and
 * nextCursor preserved; error or unexpected shapes relayed untouched), and
 * every tools/call naming a hidden tool is answered LOCALLY with the same
 * JSON-RPC error the hosted server itself produces for an unknown tool —
 * the request never reaches upstream, so it can never bill.
 *
 * Not intercepted, by design:
 * - initialize/resources/* — delegated verbatim (fork policy is about tools
 *   only; anything else would diverge from upstream for no token win).
 *
 * Also closed (defense in depth — the no-paid-call guarantee must not
 * depend on upstream behavior):
 * - tools/call shaped as a NOTIFICATION (no id): the adapter routes
 *   notifications through notify(), which would otherwise forward verbatim;
 *   hidden-tool ones are swallowed locally (notifications have no response
 *   channel, so a silent drop is indistinguishable from upstream's 204).
 * - JSON-RPC batch ARRAYS carrying a hidden tools/call: MCP forbids
 *   batching and the hosted server rejects batches as InvalidRequest, but
 *   JSON-RPC 2.0 permits them — a batch-capable upstream change must not
 *   silently widen the filter. Batches containing hidden-tool calls are
 *   rejected locally with the exact shape upstream produces today.
 */
export function withToolFilter(core: ProxyCore, policy: ToolPolicy): ProxyCore {
  if (policy.mode === "passthrough") {
    return core;
  }
  const allowed = policy.allowed;

  function filterToolsListBody(body: unknown): unknown {
    if (typeof body !== "object" || body === null) return body;
    const result = (body as { result?: unknown }).result;
    if (typeof result !== "object" || result === null) return body;
    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) return body;
    const kept = tools.filter(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        typeof (tool as { name?: unknown }).name === "string" &&
        allowed.has((tool as { name: string }).name)
    );
    if (kept.length === tools.length) return body;
    // Spread re-assignment keeps every original key in place (including
    // `tools` at its original position and any `nextCursor`), so the
    // re-serialized response stays byte-stable apart from removed entries.
    return {
      ...(body as Record<string, unknown>),
      result: { ...(result as Record<string, unknown>), tools: kept },
    };
  }

  return {
    // Delegated methods are copied by reference — the decorator overrides
    // only the routing methods below. No `this` anywhere (the underlying
    // core is a plain object literal, like the decorator).
    ...core,
    async forward(localKey, request, clientProtocolVersion) {
      if (containsHiddenToolCall(request, allowed)) {
        // Batch array with a hidden tools/call inside: answer locally with
        // the same rejection the hosted server produces for batches today
        // (HTTP 400 / -32600), so client behavior is unchanged while the
        // fork — not upstream — owns the no-paid-call property.
        return invalidBatchResponse();
      }
      const response = await core.forward(localKey, request, clientProtocolVersion);
      if (requestMethodOf(request) !== "tools/list") return response;
      return { ...response, body: filterToolsListBody(response.body) };
    },
    async forwardStream(localKey, request, onEvent, clientProtocolVersion, signal) {
      const name = calledToolNameOf(request);
      if (name !== undefined && !allowed.has(name)) {
        return blockedToolResponse(request, name);
      }
      return core.forwardStream(localKey, request, onEvent, clientProtocolVersion, signal);
    },
    async notify(localKey, notification, clientProtocolVersion) {
      // A tools/call without an id is protocol-invalid but the adapter
      // forwards ANY notification verbatim — close that path: hidden-tool
      // calls are dropped locally (the adapter still answers the client
      // 204, exactly like upstream's notification path).
      const name = calledToolNameOf(notification);
      if (name !== undefined && !allowed.has(name)) {
        log.warn(
          `dropped tools/call notification for hidden tool "${name}" — notifications have no response channel`
        );
        return;
      }
      return core.notify(localKey, notification, clientProtocolVersion);
    },
  };
}

/** The hosted server's batch rejection, mirrored byte-for-byte. */
function invalidBatchResponse(): ProxyResponse {
  return {
    status: 400,
    body: {
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request format" },
      id: -1,
    },
    sessionId: null,
    contentType: "application/json",
  };
}

/** True only for ARRAY requests (MCP-forbidden batches) hiding a blocked call. */
function containsHiddenToolCall(request: unknown, allowed: ReadonlySet<string>): boolean {
  if (!Array.isArray(request)) return false;
  return request.some((element) => {
    const name = calledToolNameOf(element);
    return name !== undefined && !allowed.has(name);
  });
}

/**
 * The local answer for a hidden tool. Mirrors the hosted server's own
 * unknown-tool error — JSON-RPC -32602 "Unknown tool: <name>", client-error
 * code mapped to HTTP 400 — so a client cannot tell the block apart from
 * calling a genuinely nonexistent tool upstream, and no paid request is
 * ever sent. Upstream echoes no session id on locally synthesized answers.
 */
function blockedToolResponse(request: unknown, name: string): ProxyResponse {
  return {
    status: 400,
    body: {
      jsonrpc: "2.0",
      error: { code: -32602, message: `Unknown tool: ${name}` },
      id: requestIdOf(request),
    },
    sessionId: null,
    contentType: "application/json",
  };
}

/** The JSON-RPC method of a request message, if it is a string. */
function requestMethodOf(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const method = (request as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

/**
 * The tool name of a tools/call request. Undefined when the request is not
 * a tools/call or carries no string name — those forward upstream and let
 * the hosted server produce its own (authoritative) error.
 */
function calledToolNameOf(request: unknown): string | undefined {
  if (requestMethodOf(request) !== "tools/call") return undefined;
  if (typeof request !== "object" || request === null) return undefined;
  const params = (request as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return undefined;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : undefined;
}
