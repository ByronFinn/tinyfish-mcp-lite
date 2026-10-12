# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-10-12

### Fixed

- **A silent (blackholed) upstream no longer hangs a request forever.** The
  single upstream fetch had no timeout, so when the connection was accepted
  but no bytes ever arrived (dead route, firewall/proxy swallowing the
  request, hung server) `fetch` neither resolved nor rejected and the stdio
  process sat silent — a client saw `initialize` with no response and no
  error. An idle watchdog now bounds both the header wait and the gap between
  JSON body chunks, so the request fails fast as a normal JSON-RPC `-32000`
  ("… sent no data within `N`ms") with a precise stderr line instead.

### Added

- `TINYFISH_UPSTREAM_TIMEOUT_MS` (default `30000`; `0` disables) — the idle
  watchdog window. It is an idle (not total) deadline, so a slow-but-alive
  response is never cut. Only the free tools' non-streaming JSON path is
  bounded; SSE (`run_web_automation`) is passed through untouched.
- A third startup log line stating the active upstream idle timeout.

## [0.1.0] - 2026-08-03

### Added

- Initial release of `@tiny-fish/mcp`: a local Streamable-HTTP MCP server at
  `http://127.0.0.1:3711/mcp` that transparently reverse-proxies the hosted
  TinyFish MCP server (`https://agent.tinyfish.ai/mcp`).
- API-key auth: reads `TINYFISH_API_KEY` from the environment and sends it
  upstream as `X-API-Key`, with `X-TF-Request-Origin` / `X-TF-Client-Name` /
  `X-TF-Client-Version` attribution headers on every call.
- Transparent pass-through of `initialize`, `ping`, `tools/list`,
  `tools/call`, `resources/list`, and `resources/read`, including verbatim
  forwarding of upstream JSON-RPC errors and byte-verbatim relay of the
  `run_web_automation` SSE progress stream.
- Session bridging: one upstream `Mcp-Session-Id` per local session; local
  teardown aborts in-flight upstream requests (upstream has no DELETE).
- Security guardrails: loopback-only bind (`127.0.0.1`, not configurable),
  Origin-header allowlist (403 otherwise), and the API key never logged or
  echoed.
- Configuration via `PORT` (default `3711`) and `TINYFISH_UPSTREAM_URL`
  (default hosted; `http:` allowed only for loopback hosts).
- Locally shaped errors for upstream-leg failures: `-32001` (auth rejected,
  HTTP 502), `-32000` (unreachable / stream failed, HTTP 502), with recovery
  guidance and `runId` on mid-stream failures.
- `tinyfish-mcp` bin, Node >= 22, ESM, published files limited to `dist/`,
  `README.md`, `LICENSE`.

[Unreleased]: https://github.com/tinyfish-io/tinyfish-mcp-server/commits/main
[0.2.2]: https://github.com/ByronFinn/tinyfish-mcp-lite/releases/tag/v0.2.2
[0.1.0]: https://www.npmjs.com/package/@tiny-fish/mcp/v/0.1.0
