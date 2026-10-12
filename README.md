# tinyfish-mcp-lite

[![npm version](https://img.shields.io/npm/v/tinyfish-mcp-lite)](https://www.npmjs.com/package/tinyfish-mcp-lite)

> **⚠️ You are on `tinyfish-mcp-lite`** — a fork that exposes **only the two
> free hosted tools** (`search`, `fetch_content`) and hides the 26 paid ones,
> so they neither burn client context tokens (~72% smaller `tools/list`) nor
> can ever be invoked through this proxy. **Start here:
> [Using this fork](#using-this-fork-tinyfish-mcp-lite)** · fork guide:
> [FORK.md](FORK.md). Everything below this section is inherited from
> upstream and describes the unfiltered behavior unless noted.

TinyFish MCP server: web search, page fetching and extraction, browser
automation and page monitoring for Claude, Cursor, VS Code and any MCP
client. Search and Fetch are free.

> **Using Claude or ChatGPT in the browser or desktop app?** Skip the setup and add the official
> TinyFish plugin for **[Claude](https://claude.ai/directory/tinyfish)** or **[ChatGPT](https://chatgpt.com/plugins/plugin_asdk_app_695325bae7348191b58ae9349a963d22)** in one click. It bundles
> these tools with ready-made skills and safety rules.

This package is a transparent reverse proxy that exposes a local
Streamable-HTTP MCP endpoint at `http://127.0.0.1:3711/mcp` and forwards every
request to the hosted TinyFish MCP server at `https://agent.tinyfish.ai/mcp`.

The proxy defines no tools and no schemas of its own. `tools/list`,
`tools/call`, `resources/*`, errors, and the `run_web_automation` SSE progress
stream all come from the hosted server: streaming (SSE) responses are relayed
byte-verbatim, and non-streaming JSON responses are relayed content-identical
(parsed and re-serialized, deep-equal to upstream). What the hosted server
says is what your client sees.

## Using this fork (tinyfish-mcp-lite)

Everything below about install, API key, and client configuration applies to
this fork too — with exactly these differences:

- **Only the free tools are exposed.** `tools/list` returns exactly
  `search` and `fetch_content` (their schemas verbatim from upstream). All
  other tools are hidden.
- **Paid tools cannot be invoked.** A `tools/call` naming a hidden tool is
  answered locally with the same error the hosted server itself produces for
  an unknown tool (HTTP 400, JSON-RPC `-32602 "Unknown tool: <name>"`) — the
  request never leaves your machine, so it can never bill. Notification-
  shaped calls and JSON-RPC batches carrying hidden tools are blocked the
  same way.
- **One extra env var, `TINYFISH_TOOLS`** (default `search,fetch_content`):
  a comma-separated allowlist. Set `TINYFISH_TOOLS=*` to restore the full
  upstream catalog (28 tools, unfiltered). Invalid values abort startup.
- **A second startup log line** states the active filter, e.g.
  `tinyfish-mcp [info] tool filter: exposing [search, fetch_content] — set TINYFISH_TOOLS=* to expose every upstream tool`.
- **An upstream idle watchdog** (`TINYFISH_UPSTREAM_TIMEOUT_MS`, default
  30000) turns a blackholed upstream into a fast, diagnosable `-32000` instead
  of a request that hangs forever — see
  [Upstream idle timeout](#troubleshooting). A third startup log line states
  the active value.
- **A stdio transport (`--stdio`)** so a client can spawn it as a plain
  command and own its lifecycle — the recommended setup; see
  [Install (this fork)](#install-this-fork). The HTTP server is the shared
  alternative, and both run the exact same filtered proxy.

### Install (this fork)

The fork ships on npm as **`tinyfish-mcp-lite`** (requires Node.js >= 22).
Two transports are available — **stdio is the recommended one** for almost
every setup.

**stdio — recommended: one command, the client manages the process.** The
client spawns the server when a session starts and tears it down when the
session ends: nothing to start, stop or supervise by hand, no port open on
your machine, and the API key exists only inside that process's environment.
Configure it wherever your client takes a command + env vars:

```json
{
  "command": "npx",
  "args": ["-y", "tinyfish-mcp-lite", "--stdio"],
  "env": { "TINYFISH_API_KEY": "tf_..." }
}
```

The same shape works in Claude Desktop's `claude_desktop_config.json`, in
Cursor's `.cursor/mcp.json`, and in VS Code's `.vscode/mcp.json` (there under
`"servers"` with `"type": "stdio"`). On **Windows**, some clients cannot spawn
`npx` directly — use `cmd /c`:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "tinyfish-mcp-lite", "--stdio"],
  "env": { "TINYFISH_API_KEY": "tf_..." }
}
```

For Claude Code, one line sets up the same thing:

```sh
claude mcp add --env TINYFISH_API_KEY=tf_... tinyfish -- npx -y tinyfish-mcp-lite --stdio
```

(With the global install (`npm i -g tinyfish-mcp-lite`) you can replace the
`npx` invocation with just `tinyfish-mcp --stdio`. To pin a version instead of
following `latest`, write `tinyfish-mcp-lite@<version>` in place of the
package name.)

**HTTP — alternative: one shared server for several clients.** Start it once
(terminal, systemd, pm2) and point every client at the same URL:

```sh
TINYFISH_API_KEY=tf_... npx tinyfish-mcp-lite          # no --stdio flag
```

```sh
# or from a clone
git clone https://github.com/ByronFinn/tinyfish-mcp-lite.git
cd tinyfish-mcp-lite
npm ci && npm run build
TINYFISH_API_KEY=tf_... node dist/index.js             # HTTP
# TINYFISH_API_KEY=tf_... node dist/index.js --stdio   # stdio
```

Both transports expose the same filtered proxy; stdio just has no port and
no manual startup — closing the client's pipe shuts the process down.

> **Note on git-based installs** (`npm i -g github:ByronFinn/tinyfish-mcp-lite`):
> npm ≥ 11.17 with the install-script policy enabled (an `allow-scripts`
> entry in your `~/.npmrc`) rejects them with `EALLOWSCRIPTS` — the policy
> leaks into the inner git-dep build via the environment. Use the npm or
> clone routes instead; registry installs (`npx tinyfish-mcp-lite`) are
> unaffected.

For the HTTP transport, point your MCP client at `http://127.0.0.1:3711/mcp`
as described in [Client configuration](#client-configuration) below.

Why a fork at all: the hosted server's paid tools (automation, browsers,
monitors…) are unusable without wallet funds, but their schemas still land
in every client session. If you only ever use the free search/fetch, this
fork keeps the client context lean and makes accidental paid calls
impossible. Fork maintenance and upstream-sync details: [FORK.md](FORK.md).

## Tools

The hosted server exposes 28 tools. You can use them to search the web, fetch and
extract pages, automate browsers, run remote Chrome sessions (CDP), keep
signed-in Browser Context Profiles and schedule page and topic Monitors.
(In this fork only the `Search & Fetch` row is advertised — see
[Using this fork](#using-this-fork-tinyfish-mcp-lite).)

| Category | Tools |
|---|---|
| Search & Fetch | `search`, `fetch_content` |
| Web automation | `run_web_automation`, `run_web_automation_async`, `get_run`, `list_runs`, `cancel_run`, `batch_status`, `batch_cancel` |
| Browser sessions | `create_browser_session`, `list_browser_sessions`, `close_browser_session` |
| Browser Context Profiles | `create_profile`, `list_profiles`, `start_profile_setup_session`, `save_profile_setup_session`, `cancel_profile_setup_session` |
| Monitors | `create_monitor`, `get_monitor`, `list_monitors`, `run_monitor`, `pause_monitor`, `resume_monitor`, `cancel_monitor` |
| Account & usage | `get_wallet`, `get_search_usage`, `list_fetch_usage`, `guide_next_step` |

- [Tool reference](https://github.com/tinyfish-io/tinyfish-mcp-server/blob/main/docs/tools.md): every tool, verbatim, with parameters
- [Examples](https://github.com/tinyfish-io/tinyfish-mcp-server/blob/main/docs/examples.md): common workflows and prompts
- [MCP Integration guide](https://docs.tinyfish.ai/mcp-integration): client setup, auth, rates, troubleshooting
- Full documentation: [docs.tinyfish.ai](https://docs.tinyfish.ai)

## Use the hosted server first

If your MCP client supports remote Streamable-HTTP servers (Claude Code,
Claude Desktop connectors, Cursor, VS Code, and most modern clients do),
connect it **directly** to the hosted server — no install, no local process:

```text
https://agent.tinyfish.ai/mcp
```

Use this package instead when:

- your client only talks to local MCP servers, or
- you want to authenticate with a **TinyFish API key** from your environment
  instead of the hosted server's OAuth flow (CI, headless machines, scripts).

## Install

```sh
npm install -g @tiny-fish/mcp
```

Or run it without installing:

```sh
npx @tiny-fish/mcp
```

Requires **Node.js >= 22**. (This is a deliberate deviation from the TinyFish
CLI's `>=24` requirement — nothing here needs Node 24.)

## API key

The server reads `TINYFISH_API_KEY` from its environment at startup and sends
it upstream as `X-API-Key` on every call. Get a key at
[https://agent.tinyfish.ai](https://agent.tinyfish.ai).

```sh
export TINYFISH_API_KEY=tf_...
tinyfish-mcp
```

On success it prints one line to stderr:

```text
tinyfish-mcp [info] listening on http://127.0.0.1:3711 — upstream https://agent.tinyfish.ai/mcp — v0.1.0
```

The key is never logged and never echoed back to clients.

## Client configuration

> **Using this fork with the recommended stdio setup?** The examples below
> are for the **HTTP transport only** (the shared-server route) — the stdio
> configuration in [Install (this fork)](#install-this-fork) is purely
> client-side and needs no URL. If you run the shared HTTP server, everything
> below applies unchanged.

Start `tinyfish-mcp` (e.g. in a terminal, or under your process manager of
choice), then point your client at `http://127.0.0.1:3711/mcp`.

### Claude Code

```sh
claude mcp add --transport http tinyfish http://127.0.0.1:3711/mcp
```

### Claude Desktop

Settings → Connectors → Add custom connector, with URL
`http://127.0.0.1:3711/mcp`. On versions whose
`claude_desktop_config.json` supports URL-based servers:

```json
{
  "mcpServers": {
    "tinyfish": {
      "url": "http://127.0.0.1:3711/mcp"
    }
  }
}
```

Note: Claude Desktop can also use the hosted `https://agent.tinyfish.ai/mcp`
directly as a custom connector — prefer that unless you need API-key auth.

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "tinyfish": {
      "url": "http://127.0.0.1:3711/mcp"
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "tinyfish": {
      "type": "http",
      "url": "http://127.0.0.1:3711/mcp"
    }
  }
}
```

### Any other client

Configure a Streamable-HTTP (remote/URL) MCP server with:

```json
{ "url": "http://127.0.0.1:3711/mcp" }
```

The endpoint accepts `POST /mcp` only (matching the hosted server, which has
no GET SSE channel and no DELETE session teardown). `GET /healthz` returns
`200 ok` for debugging.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TINYFISH_API_KEY` | (required) | TinyFish API key, sent upstream as `X-API-Key`. The server refuses to start without it. |
| `PORT` | `3711` | Local listen port (integer 1-65535). No auto-increment: if the port is busy the server exits with an error. (Ignored by the stdio transport — it never listens.) |
| `TINYFISH_UPSTREAM_URL` | `https://agent.tinyfish.ai/mcp` | Upstream MCP URL. Must be `https:`; `http:` is allowed only for `127.0.0.1`/`localhost` (local testing). |
| `TINYFISH_TOOLS` | `search,fetch_content` | **Fork only:** comma-separated allowlist of upstream tools to expose; `*` disables filtering and exposes the full upstream catalog. Invalid values abort startup. |
| `TINYFISH_UPSTREAM_TIMEOUT_MS` | `30000` | **Fork only:** idle watchdog for the upstream request. If no bytes arrive from upstream for this long (headers, or the gap between body chunks), the request fails fast with a JSON-RPC `-32000` instead of hanging — the fix for a blackholed upstream that otherwise leaves `initialize` unanswered forever. `0` disables the watchdog (wait indefinitely). |

The proxy also sends attribution headers on every upstream call:
`X-TF-Request-Origin: tinyfish-mcp`, `X-TF-Client-Name: tinyfish-mcp`, and
`X-TF-Client-Version: <package version>`.

## Security & trust model

This is a loopback-only server with a deliberate, documented trust boundary:

- **Loopback bind, always.** The server binds the `127.0.0.1` literal and this
  is not configurable — it can never listen on `0.0.0.0` or a LAN interface.
- **Origin validation.** Requests carrying an `Origin` header are rejected
  with `403` unless the origin is `http(s)://127.0.0.1` or
  `http(s)://localhost` (any port). This blocks the DNS-rebinding attack the
  MCP spec calls out for local HTTP servers. Requests without an `Origin`
  header (curl, MCP SDKs, inspectors) are allowed.
- **Server-holds-key.** The process reads `TINYFISH_API_KEY` from its env;
  clients send no credential on the local hop. This is the simplest model,
  but it means **any local process that can reach `127.0.0.1:<port>` can use
  your key and drive automations** (which can spend TinyFish credits). The
  loopback bind and Origin check are the mitigations; treat the port as a
  local trust boundary on a machine you trust.
- **stdio narrows this boundary further.** The stdio transport opens no port
  at all: the key lives only in the client-spawned process's environment, and
  its only I/O is the client's own stdin/stdout pipes — other local processes
  have no handle to reach for.

## Troubleshooting

**"Port 3711 is already in use"** — another process holds the port. Stop it,
or set `PORT` to a free port and update your client config to match.

**HTTP 502 with JSON-RPC error `-32001`** ("Upstream rejected the request …
check that TINYFISH_API_KEY is set to a valid TinyFish API key") — the hosted
server rejected your key. Verify `TINYFISH_API_KEY` is set in the environment
of the `tinyfish-mcp` process (not just your shell) and that the key is valid
at [https://agent.tinyfish.ai](https://agent.tinyfish.ai). The error's `data`
carries the upstream status and (truncated) body for diagnosis.

**HTTP 502 with JSON-RPC error `-32000`** ("cannot reach …") — the upstream
server is unreachable: check your network/proxy/VPN; the hosted server may
also be temporarily down. If you overrode `TINYFISH_UPSTREAM_URL`, check it.
If a streamed `run_web_automation` call fails mid-stream you get the same
`-32000` as the final SSE frame, with a "the run may still be executing"
warning and the `runId` when known — check the run's status instead of
retrying blindly.

**HTTP 502 with JSON-RPC error `-32000`** ("… sent no data within
`N`ms") — the upstream accepted the connection but went silent past the idle
watchdog (`TINYFISH_UPSTREAM_TIMEOUT_MS`, default 30000). This is the
deliberate fix for a blackholed upstream (dead route, firewall/proxy
swallowing the request) that would otherwise leave a request — including
`initialize` — unanswered forever with no error. Check your network path to
`agent.tinyfish.ai`; if you have a legitimately slow upstream, raise the
value, or set it to `0` to disable the watchdog and wait indefinitely.

**Batch requests don't work** — MCP forbids JSON-RPC batching and the hosted
server does not support batch arrays. The proxy forwards a batch as-is and
the upstream answers its own error; send one JSON-RPC message per request.

**Claude/other client can't connect** — make sure `tinyfish-mcp` is actually
running (it's a standalone server; clients do not launch it) and that
`GET http://127.0.0.1:3711/healthz` answers `ok`. (On the stdio transport the
client launches the process itself — see the next entry.)

**stdio client launches but the server never answers** — run the exact
command from your client config (`npx -y tinyfish-mcp-lite --stdio`) in a
terminal: it should print the `stdio transport — …` and `tool filter: …`
lines on stderr and answer JSON-RPC on stdin. A silent spawn failure usually
means `npx` cannot reach the registry (offline, or a registry mirror that has
not synced a brand-new release yet — pin the exact version, e.g.
`tinyfish-mcp-lite@0.2.1`, until it does), or that the client cannot spawn
`npx` directly on Windows (use the `cmd /c` form from
[Install (this fork)](#install-this-fork)).

## Development

```sh
npm ci
npm run build        # tsc → dist/, marks dist/index.js executable
npm test             # unit tests (offline, mock upstream)
npm run test:watch   # unit tests in watch mode
npm run lint         # eslint over src/ tests/
npm run format       # prettier
npm run type-check   # tsc --noEmit over the whole tree
```

Layout: `src/core/` is the transport-agnostic proxy core (upstream client,
session bridge, SSE relay, error shaping); `src/http/` is the thin HTTP
adapter (routing, Origin check); `tests/` holds the unit suites plus
`tests/helpers/mock-upstream.ts`, a mock of the hosted endpoint that the unit
tests run against entirely offline.

Integration tests hit the **real** hosted upstream and are gated: without
`TINYFISH_API_KEY` they skip with a printed notice.

```sh
TINYFISH_API_KEY=... npm run test:integration
```

Set `TINYFISH_UPSTREAM_URL` to point them at a sandbox deployment instead of
production. Note the `run_web_automation` integration test executes a real
automation and spends credits.

## Maintenance

Maintained by [@Zechereh](https://github.com/Zechereh). Bugs and feature
requests: [GitHub issues](https://github.com/tinyfish-io/tinyfish-mcp-server/issues).
This fork is maintained at
[ByronFinn/tinyfish-mcp-lite](https://github.com/ByronFinn/tinyfish-mcp-lite);
fork-specific questions live in [FORK.md](FORK.md).

## License

MIT
