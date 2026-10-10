#!/usr/bin/env node
import { ConfigError, parseConfig } from "./config.js";
import { createProxyCore } from "./core/proxy-core.js";
// FORK(lite): free-tool allowlist — see src/core/tool-filter.ts and FORK.md.
import { parseToolPolicy, withToolFilter } from "./core/tool-filter.js";
import { createMcpAdapter } from "./http/adapter.js";
import { createAppHandler, startHttpServer } from "./http/index.js";
import { log } from "./log.js";
import { shutdownHooks } from "./shutdown.js";
import { VERSION } from "./version.js";

function isErrnoException(err: unknown): err is Error & { code?: string } {
  return err instanceof Error && "code" in err;
}

async function main(): Promise<void> {
  let config;
  let toolPolicy; // FORK(lite)
  try {
    config = parseConfig(process.env);
    // FORK(lite): TINYFISH_TOOLS allowlist (default: the free search +
    // fetch_content; "*" restores unfiltered upstream passthrough).
    toolPolicy = parseToolPolicy(process.env.TINYFISH_TOOLS);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // The real MCP handler: origin/routing shell → adapter → proxy core.
  // createProxyCore registers session teardown into shutdownHooks itself.
  // FORK(lite): the decorator hides non-allowed tools from tools/list and
  // answers tools/call for them locally — paid tools are never advertised
  // and never invoked upstream.
  const core = withToolFilter(
    createProxyCore({ upstreamUrl: config.upstreamUrl, apiKey: config.apiKey }),
    toolPolicy
  );

  // FORK(lite): stdio transport — spawn-and-forget mode for clients that
  // launch their MCP servers as commands (`tinyfish-mcp --stdio`, or
  // `npx -y tinyfish-mcp-lite --stdio`). Same core, same filter; the client
  // owns the lifecycle (stdin closed ⇒ exit), so no PORT and no long-running
  // server. See src/stdio/adapter.ts and FORK.md.
  if (process.argv.includes("--stdio")) {
    const { runStdioTransport } = await import("./stdio/adapter.js");
    log.info(`stdio transport — upstream ${config.upstreamUrl} — v${VERSION}`);
    if (toolPolicy.mode === "allow") {
      log.info(
        `tool filter: exposing [${[...toolPolicy.allowed].join(", ")}] — set TINYFISH_TOOLS=* to expose every upstream tool`
      );
    } else {
      log.info("tool filter: off (TINYFISH_TOOLS=*) — exposing every upstream tool");
    }
    await runStdioTransport(core);
    for (const hook of shutdownHooks) {
      try {
        await hook();
      } catch (err) {
        log.error(`shutdown hook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    process.exit(0);
  }

  const handler = createAppHandler(createMcpAdapter(core));

  let server;
  try {
    server = await startHttpServer(config.port, handler);
  } catch (err) {
    if (isErrnoException(err) && err.code === "EADDRINUSE") {
      log.error(
        `Port ${config.port} is already in use — stop the other process or set PORT to a free port`
      );
      process.exit(1);
    }
    throw err;
  }

  // The one startup line. Never include config.apiKey here or in any other log call.
  log.info(
    `listening on http://127.0.0.1:${config.port} — upstream ${config.upstreamUrl} — v${VERSION}`
  );
  // FORK(lite): state the active tool policy so a "missing tool" is never a
  // mystery. Tool names only — never the API key.
  if (toolPolicy.mode === "allow") {
    log.info(
      `tool filter: exposing [${[...toolPolicy.allowed].join(", ")}] — set TINYFISH_TOOLS=* to expose every upstream tool`
    );
  } else {
    log.info("tool filter: off (TINYFISH_TOOLS=*) — exposing every upstream tool");
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    for (const hook of shutdownHooks) {
      try {
        await hook();
      } catch (err) {
        log.error(`shutdown hook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  log.error(`startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
