/**
 * alter mcp-bridge - stdio ↔ HTTP MCP bridge (machine-only verb).
 *
 * Spawned by the SDK's wire system as a fallback when the bridge script
 * isn't found in the SDK dist. Not user-facing - deliberately omitted
 * from `alter --help` and the interactive menu.
 *
 * Resolves the zero-dependency bridge from @truealter/sdk's dist and
 * execs it with inherited stdio so the parent process (Claude Code)
 * talks directly to the bridge.
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { trustedBinPrefixes } from "../lib/mcp-config.js";

/**
 * MCP-GTM2-H-5 / W-2: only exec a bridge that resolves inside a trusted
 * prefix. `findBridge()` previously returned any path `require.resolve`
 * produced and exec'd it with the full environment (session JWT visible) -
 * a shadowed or supply-chain-tampered `@truealter/sdk` in a world-writable
 * location became arbitrary code execution. We mirror `resolveOrgAlterBin`'s
 * guard: trust user-owned prefixes (home / XDG / npm root) plus this CLI's
 * own enclosing `node_modules` tree (a co-installed SDK is exactly as
 * trustworthy as the CLI itself), and reject anything else.
 */
function isTrustedBridgePath(candidate: string): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const prefixes = [...trustedBinPrefixes()];
  // Trust the CLI's own enclosing node_modules tree.
  const nmIdx = here.lastIndexOf("node_modules");
  if (nmIdx !== -1) {
    prefixes.push(here.slice(0, nmIdx + "node_modules".length));
  }
  // Trust the CLI package root itself (covers local/dev checkouts).
  prefixes.push(resolve(here, ".."));
  return prefixes.some(
    (p) =>
      candidate === p ||
      candidate.startsWith(p + "/") ||
      candidate.startsWith(p + "\\"),
  );
}

function findBridge(): string | null {
  const require = createRequire(import.meta.url);
  try {
    const sdkEntry = require.resolve("@truealter/sdk");
    const sdkDir = dirname(sdkEntry);
    const candidate = resolve(sdkDir, "mcp-bridge.js");
    if (existsSync(candidate) && isTrustedBridgePath(candidate)) return candidate;
    const binCandidate = resolve(sdkDir, "bin", "mcp-bridge.js");
    if (existsSync(binCandidate) && isTrustedBridgePath(binCandidate))
      return binCandidate;
  } catch {
    // SDK not resolvable - try sibling dist path
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const localCandidate = resolve(here, "..", "node_modules", "@truealter", "sdk", "dist", "mcp-bridge.js");
  if (existsSync(localCandidate) && isTrustedBridgePath(localCandidate))
    return localCandidate;

  return null;
}

export function mcpBridge(): void {
  const bridgePath = findBridge();
  if (!bridgePath) {
    process.stderr.write(
      "alter mcp-bridge: bridge not found. Reinstall @truealter/sdk.\n",
    );
    // Soft exit: set exit code and return so the event loop drains cleanly
    // on Windows rather than racing libuv handle teardown.
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, [bridgePath], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (err) => {
    process.stderr.write(`alter mcp-bridge: ${err.message}\n`);
    // Soft exit inside event callback: set exitCode so the process exits
    // after the event loop drains. No return needed; callback ends here.
    process.exitCode = 1;
  });

  child.on("exit", (code) => {
    // Forward child exit code without a hard process.exit() call.
    // The event loop is idle once the child exits, so this drains immediately.
    process.exitCode = code ?? 1;
  });
}
