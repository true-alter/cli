/**
 * Cross-platform browser opener for the ALTER CLI.
 *
 * Windows note: uses `rundll32 url.dll,FileProtocolHandler <url>` rather than
 * `cmd.exe /c start "" <url>`. cmd's builtin `start` re-parses its argv
 * through cmd's own grammar - `&`, `|`, `<`, `>`, `^` are metacharacters -
 * so an OAuth URL (string of `key=value&...`) is truncated at the first `&`
 * even when execFileSync passes it as a single argv entry. rundll32 is a
 * plain executable and the URL reaches the protocol handler unparsed.
 */

import { spawn } from "child_process";

export interface BrowserCommand {
  file: string;
  args: string[];
}

/**
 * Pure mapping from (platform, url) to the exec call used to open a browser,
 * for platforms where a single canonical path applies. Returns `null` for
 * Linux - see `openBrowser` for the fallback chain.
 */
export function browserCommand(
  platform: NodeJS.Platform,
  url: string,
): BrowserCommand | null {
  if (platform === "darwin") {
    return { file: "open", args: [url] };
  }
  if (platform === "win32") {
    return { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return null;
}

// Spawn detached so the parent event loop isn't blocked while the browser
// process initialises - pre-fix execFileSync stalled stdout for ~100-500ms,
// pooling the surrounding "Opening your browser." + "waiting…" prints into
// one delayed burst (F18 from new-user login walkthrough, 2026-05-15).
function spawnDetached(file: string, args: string[]): boolean {
  try {
    const child = spawn(file, args, { stdio: "ignore", detached: true });
    if (child.pid !== undefined) {
      child.unref();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function openBrowser(url: string): void {
  const cmd = browserCommand(process.platform, url);
  if (cmd) {
    spawnDetached(cmd.file, cmd.args);
    return;
  }
  if (spawnDetached("xdg-open", [url])) return;
  spawnDetached("chromium", [url]);
  // Give up silently - callers print the URL for manual paste.
}
