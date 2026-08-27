/**
 * Shell-free `command -v` equivalent.
 *
 * Walks `$PATH` directories and `fs.accessSync` each candidate
 * (with platform-appropriate extensions). Never invokes a shell,
 * never passes user-controlled arguments to a child process.
 *
 * Extracted from `src/onboarding/signals.ts` so commands and the
 * cosmetic detector can share the same primitive without depending
 * on the larger signals module. The signals copy stays where it is
 * to avoid an import cycle with the onboarding flow.
 *
 * Security note: replaces every `execSync(\`command -v ${bin}\`)`
 * pattern in the CLI. The shelled-out form interpolated the binary
 * name into a shell command string, which (while only ever called
 * with hard-coded names today) was a foot-gun waiting to be
 * triggered by a future caller passing through env input.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Return true iff `binary` exists somewhere on `$PATH`.
 *
 * The check is bounded - one `accessSync` per directory per
 * extension - and does not follow symlinks past the first hit.
 */
export function which(binary: string): boolean {
  // Reject anything that looks like a shell metachar so a typo
  // upstream surfaces immediately rather than papering over a
  // broken caller.
  if (!/^[a-zA-Z0-9._+-]+$/.test(binary)) return false;
  const pathEnv = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const ext of extensions) {
      if (!dir) continue;
      const candidate = path.join(dir, binary + ext);
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
        return true;
      } catch {
        // try next
      }
    }
  }
  return false;
}
