# tinyfish-mcp-lite — fork guide

This repository is a **fork of [tinyfish-io/tinyfish-mcp-server](https://github.com/tinyfish-io/tinyfish-mcp-server)**
with exactly one divergence: it exposes only the **free** hosted tools.

The hosted TinyFish MCP server advertises 28 tools (at the time of writing),
but only `search` and `fetch_content` are free (official rates: search
$0.00/request — 30/min, 500/hr, 12,000/day; fetch_content $0.00/URL —
150 URLs/min, 1,000/day; paid tools meter through the Wallet, e.g.
`run_web_automation` at $0.016/step). The other 26 (web automation, browser
sessions, profiles, monitors, account tools) cost credits and are unusable
on a free-tier account — while their schemas still land in every MCP
client's context. Filtering to the free pair cut the `tools/list` payload
by ~72% at the time of writing (≈47.7 KB → ≈13.4 KB of tool schemas per
session) and makes it impossible for a client to invoke a paid tool through
this proxy. The **allowlist** (rather than a blocklist) also future-proofs
against paid tools upstream has not shipped yet.

## Behavior of the fork (vs upstream)

| Aspect                                                                                     | Upstream             | This fork (default)                                                                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/list` result                                                                        | all advertised tools | exactly `search`, `fetch_content` (schemas verbatim from upstream)                                                                        |
| `tools/call` of a hidden tool                                                              | forwarded upstream   | answered locally: HTTP 400, JSON-RPC `-32602` `Unknown tool: <name>` — the request never leaves the process, so a paid call cannot happen |
| Everything else (initialize, ping, notifications, resources, allowed calls, SSE streaming) | —                    | byte-identical passthrough                                                                                                                |

### Configuration: `TINYFISH_TOOLS`

```sh
TINYFISH_TOOLS=search,fetch_content   # default — the free tools
TINYFISH_TOOLS=*                      # disable the filter (pure upstream behavior)
TINYFISH_TOOLS=search,fetch_content,get_wallet   # any explicit allowlist
```

Invalid values (empty list, malformed names) fail startup with an actionable
message, same as `TINYFISH_API_KEY`/`PORT` handling.

## Divergence inventory (what makes this a fork)

All fork logic lives in **fork-owned files**, marked so merges stay trivial:

| File                                    | Status                   | Purpose                                                                                                                               |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/tool-filter.ts`               | fork-only                | policy parsing (`parseToolPolicy`) + `ProxyCore` decorator (`withToolFilter`)                                                         |
| `tests/tool-filter.test.ts`             | fork-only                | unit + full-flow tests (mock upstream)                                                                                                |
| `tests/tool-filter.integration.test.ts` | fork-only                | real-upstream integration tests                                                                                                       |
| `.github/workflows/sync-upstream.yml`   | fork-only                | weekly upstream sync PR (see below)                                                                                                   |
| `FORK.md`                               | fork-only                | this file                                                                                                                             |
| `src/index.ts`                          | **edited upstream file** | 4 small hunks, each tagged `FORK(lite)` — import, `parseToolPolicy` in the config try-block, `withToolFilter` wrap, startup log lines |
| `README.md`                             | **edited upstream file** | fork banner at the top + a "Using this fork" section (install, differences), a `TINYFISH_TOOLS` env row, small fork notes elsewhere  |
| `package.json`                          | **edited upstream file** | renamed to `tinyfish-mcp-lite` (published on npm; repository/homepage/bugs/mcpName point at the fork), `"prepare": "npm run build"` + an `allowScripts` object for npm ≥ 11.17 script-policy installs, bin target without the `./` prefix (npm ≥ 11.17 publish normalization drops `bin` otherwise) |
| `.github/workflows/ci.yml`              | **edited upstream file** | integration leg scoped to the fork's free-tool suite (`FORK(lite)` note on the step) — upstream's suite runs a real paid automation |

Every hunk that touches an upstream file carries a `FORK(lite)` comment (code)
or sits inside the marked fork sections (README). Upstream files are otherwise
**never modified in place** — the decorator pattern was chosen precisely so
`git merge upstream/main` has at most the `src/index.ts` hunk region to
reconcile; README conflicts resolve by taking upstream's side and re-applying
the fork sections, and `package.json` conflicts by keeping both sides' script
additions.

## Syncing with upstream

### Automatic (recommended)

`.github/workflows/sync-upstream.yml` runs weekly (and on demand via
`workflow_dispatch`):

1. Merges `upstream/main` into a `sync/upstream` branch.
2. Runs the full gate **inside the workflow** on the merged tree: `npm ci`,
   lint, type-check, unit tests — plus the fork's free-tool integration suite
   (only `tests/tool-filter.integration.test.ts`) against the real hosted
   upstream when the `TINYFISH_API_KEY` secret is configured. Upstream's own
   integration suite is deliberately not run here: it executes a real paid
   automation and would spend credits (or 402 on an empty wallet). (The gate
   runs there, not on the PR, because a PR opened with `GITHUB_TOKEN` does not
   trigger new `pull_request` workflow runs — a documented GitHub behavior.)
3. Clean merge + green gate → opens/updates a PR titled
   `Sync upstream <sha>`; gate failure is called out in the PR body.
   Nothing auto-merges — you press the button.
4. Nothing new upstream → exits quietly. Merge conflict → opens an issue
   with instructions instead of a destructive PR.

**One-time setup** (Settings → Actions → General):

- Enable **Allow GitHub Actions to create and approve pull requests**
  (off by default; required for the workflow's `GITHUB_TOKEN` to open the
  sync PR).
- Optionally add the `TINYFISH_API_KEY` secret so the sync gate also
  validates the filter against the live upstream.

### Manual

```sh
git fetch upstream
git merge upstream/main          # merge, never rebase — history is published
npm ci && npm test && npm run type-check && npm run lint
# free fork filter check against the live upstream (no cost):
TINYFISH_API_KEY=... npx vitest --run --config vitest.integration.config.ts tests/tool-filter.integration.test.ts
git push
```

(The full `npm run test:integration` also works, but includes upstream's
`proxy.integration.test.ts`, which executes a real paid automation and spends
credits.)

### Releasing to npm

The fork publishes as [`tinyfish-mcp-lite`](https://www.npmjs.com/package/tinyfish-mcp-lite)
(`publishConfig.registry` points at npmjs). After landing upstream changes
worth shipping:

```sh
npm version patch        # or minor / major
npm publish              # builds dist/ via prepublishOnly; no install-time scripts
git push --follow-tags
```

The published package carries no install-time lifecycle scripts, so npm's
install-script policy (`allow-scripts`) never blocks it. Note for new
package names: the first publish lands as a `0.0.0-stage` placeholder until
you confirm the release on npmjs.com — later versions publish directly.

### Resolving conflicts

- `src/index.ts` is the only upstream file with functional edits. On
  conflict, take **upstream's** side, then re-apply the `FORK(lite)` hunks
  (grep for the marker): the import, the `parseToolPolicy`/`withToolFilter`
  wiring, and the startup log lines.
- `README.md`: take upstream's side, then re-apply the fork sections — the
  top banner, "Using this fork (tinyfish-mcp-lite)" with its Install
  subsection, the `TINYFISH_TOOLS` row in the env-var table, and the short
  fork notes in Tools/Maintenance.
- `package.json`: keep upstream's side plus the `"prepare": "npm run build"`
  line.
- Fork-owned files (`tool-filter.ts`, its tests, `sync-upstream.yml`,
  `FORK.md`) exist only here — upstream cannot conflict with them.
- After any sync, check the upstream README/tool docs for **new free
  tools**: if TinyFish adds one, extend `DEFAULT_ALLOWED_TOOLS` in
  `src/core/tool-filter.ts` (the real-upstream integration test pins the
  default to exactly `search` + `fetch_content`, so it will fail loudly if
  upstream's free set changes shape).

## Design notes

- **Why a `ProxyCore` decorator and not an adapter change?** The HTTP
  adapter routes every `tools/list` through `forward` and every `tools/call`
  through `forwardStream`; decorating those two methods covers both
  advertise and invoke directions with zero upstream-file edits, and the
  SSE relay path stays untouched (the streaming test proves allowed tools
  still stream end-to-end).
- **Why answer blocked calls at all?** A client that hallucinates a hidden
  tool name would otherwise trigger a real (potentially billable) upstream
  request. The local answer mimics the hosted server's own unknown-tool
  error (`-32602`, client-error codes mapped to HTTP 400), so clients treat
  it exactly like calling a nonexistent tool.
- **JSON-RPC batches** containing a hidden `tools/call`, and notification-
  shaped `tools/call` messages (no `id`), are rejected/dropped LOCALLY with
  the same shapes the hosted server produces — the no-paid-call guarantee
  never depends on upstream behavior (see the regression tests in
  `tests/tool-filter.test.ts`).
