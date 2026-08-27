/**
 * alter hooks install | uninstall - manage the curated portable set of
 * Claude Code substrate-observation hooks.
 *
 * Ships a small, audited subset of Claude Code substrate-observation
 * hooks inside the CLI package (`dist/assets/hooks/`) and registers them
 * in the relevant CC `settings.json` hook arrays.
 *
 * Install target:
 *   - project-local `<repo>/.claude/hooks/` + `<repo>/.claude/settings.json`
 *     when the cwd is inside a git repo;
 *   - else user-scope `~/.claude/hooks/` + `~/.claude/settings.json`.
 *
 * Mechanism:
 *   - mkdir -p the hooks dir, atomically write each `.sh` at 0o755;
 *   - regenerate `manifest.sha256` for exactly the shipped subset via the
 *     bundled `_verify.sh --regen` so the local tamper gate stays intact;
 *   - read settings.json (default "{}"), parse-or-refuse, merge each hook
 *     command into its event/matcher array ONLY if absent (dedupe by the
 *     hook-script basename substring), NEVER clobbering an existing user
 *     hook array;
 *   - write settings.json back atomically.
 *
 * `uninstall` mirrors the reverse: strip our entries from each array (and
 * prune now-empty arrays/events we created), then delete the shim scripts
 * and the manifest. A user-authored array we merged into is preserved with
 * only our entries removed.
 *
 * Idempotent: a second `install` adds no duplicates; a second `uninstall`
 * is a clean no-op.
 *
 * Flags:
 *   --user            force user-scope (~/.claude) even inside a git repo
 *   --project         force project-scope (cwd repo root); errors if not a repo
 *   --json            emit a machine-readable report and exit
 *   --yes, -y         skip the confirmation prompt (non-interactive)
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Hook spec - the curated portable subset. Each entry names the shim script
// and the CC events/matchers it registers under, plus how it is invoked
// (whether it reads the tool payload on stdin) and a per-hook timeout.
//
// Wiring mirrors the project `.claude/settings.json`. The registered
// command resolves the hooks dir by ABSOLUTE path (baked at install time)
// rather than `git rev-parse`, so it works for both project- and
// user-scope installs.
// ---------------------------------------------------------------------------

interface HookBinding {
  event: string;
  matcher: string; // "" for events that take no matcher (UserPromptSubmit, Stop)
  timeout: number;
}

interface HookSpec {
  /** Shim script basename, present in dist/assets/hooks. */
  script: string;
  /** Sub-verb passed to the script as $1, if any (e.g. sot-discipline log|summary). */
  arg?: string;
  /** Whether the hook reads the tool payload JSON from stdin. */
  stdin: boolean;
  bindings: HookBinding[];
}

// config.sh, _verify.sh, _stop-cache.sh and log-prune.sh are shared
// deps, copied + manifest-pinned but never registered as hooks directly.
// _stop-cache.sh is sourced by cc-handover-capture.sh; log-prune.sh is
// invoked by cc-handover-capture.sh from its own directory.
const SHARED_DEPS = [
  "config.sh",
  "_verify.sh",
  "_stop-cache.sh",
  "log-prune.sh",
] as const;

const HOOK_SPECS: HookSpec[] = [
  {
    script: "sot-discipline.sh",
    arg: "log",
    stdin: true,
    bindings: [{ event: "PostToolUse", matcher: "*", timeout: 3 }],
  },
  {
    script: "sot-discipline.sh",
    arg: "summary",
    stdin: true,
    bindings: [{ event: "Stop", matcher: "", timeout: 3 }],
  },
  {
    script: "auto-format.sh",
    stdin: true,
    bindings: [{ event: "PostToolUse", matcher: "Edit|Write", timeout: 10 }],
  },
  {
    script: "destructive-bash-gate.sh",
    stdin: true,
    bindings: [
      { event: "PreToolUse", matcher: "Bash", timeout: 5 },
    ],
  },
  {
    script: "homework-preflight-gate.sh",
    stdin: true,
    bindings: [{ event: "PreToolUse", matcher: "AskUserQuestion", timeout: 3 }],
  },
  {
    script: "environment-intent-gate.sh",
    stdin: true,
    bindings: [{ event: "PreToolUse", matcher: "Skill", timeout: 3 }],
  },
  {
    script: "agent-substrate-prologue.sh",
    stdin: true,
    bindings: [{ event: "PreToolUse", matcher: "Agent|Task", timeout: 3 }],
  },
  {
    script: "cc-broadcast.sh",
    stdin: true,
    bindings: [
      { event: "UserPromptSubmit", matcher: "", timeout: 3 },
      { event: "PostToolUse", matcher: "Edit|Write", timeout: 3 },
    ],
  },
  {
    // Optional local-model upgrade for the full statusline's session-label
    // descriptor: summarises the prompt into a 2-4 word slug via ollama.
    // Self-no-ops when ollama is down (1s liveness probe), leaving the
    // cc-broadcast.sh prompt-head as the descriptor source - so installing
    // it is safe even without a local model.
    script: "cc-label-summarise.sh",
    stdin: true,
    bindings: [{ event: "UserPromptSubmit", matcher: "", timeout: 5 }],
  },
  {
    script: "cc-awareness.sh",
    stdin: true,
    bindings: [
      { event: "UserPromptSubmit", matcher: "", timeout: 3 },
      { event: "PreToolUse", matcher: "Read|Edit|Write", timeout: 3 },
    ],
  },
  {
    script: "cc-lesson-capture.sh",
    stdin: true,
    bindings: [{ event: "Stop", matcher: "", timeout: 5 }],
  },
  {
    script: "session-lesson-reconcile.sh",
    stdin: true,
    bindings: [{ event: "UserPromptSubmit", matcher: "", timeout: 3 }],
  },
  {
    script: "cc-handover-capture.sh",
    stdin: true,
    bindings: [{ event: "Stop", matcher: "", timeout: 5 }],
  },
  {
    script: "cc-agent-handover-poll.sh",
    stdin: true,
    bindings: [{ event: "UserPromptSubmit", matcher: "", timeout: 3 }],
  },
  {
    script: "cc-agent-handover.sh",
    stdin: true,
    bindings: [{ event: "PreCompact", matcher: "", timeout: 5 }],
  },
];

// All script basenames we install (shims + shared deps), for copy + dedupe.
const ALL_SHIPPED_SCRIPTS = [
  ...new Set([...HOOK_SPECS.map((s) => s.script), ...SHARED_DEPS]),
];

// ---------------------------------------------------------------------------
// Asset resolution - find the bundled hooks at dist/assets/hooks relative to
// this module (dist/commands/hooks.js → ../assets/hooks).
// ---------------------------------------------------------------------------

function assetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "assets", "hooks");
}

// ---------------------------------------------------------------------------
// Target resolution.
// ---------------------------------------------------------------------------

interface Target {
  scope: "project" | "user";
  claudeDir: string; // <root>/.claude
  hooksDir: string; // <root>/.claude/hooks
  settingsPath: string; // <root>/.claude/settings.json
}

function gitToplevel(): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

function resolveTarget(force: "project" | "user" | null): Target {
  let root: string;
  let scope: "project" | "user";

  if (force === "user") {
    root = os.homedir();
    scope = "user";
  } else if (force === "project") {
    const top = gitToplevel();
    if (!top) {
      throw new Error(
        "--project requires the cwd to be inside a git repository.",
      );
    }
    root = top;
    scope = "project";
  } else {
    const top = gitToplevel();
    if (top) {
      root = top;
      scope = "project";
    } else {
      root = os.homedir();
      scope = "user";
    }
  }

  const claudeDir = path.join(root, ".claude");
  return {
    scope,
    claudeDir,
    hooksDir: path.join(claudeDir, "hooks"),
    settingsPath: path.join(claudeDir, "settings.json"),
  };
}

// ---------------------------------------------------------------------------
// Settings.json hook command construction + identification.
//
// The registered command is an absolute-path variant of the project wiring:
//   bash -c 'INPUT=$(cat); D="<hooksDir>"; [ -x "$D/_verify.sh" ] && \
//            bash "$D/_verify.sh" >/dev/null && [ -x "$D/<hook>" ] && \
//            printf "%s" "$INPUT" | bash "$D/<hook>" [arg]; exit 0'
//
// Hooks that do not consume stdin omit the INPUT capture/pipe. The
// `_verify.sh && <hook>` chain preserves the local tamper gate.
//
// Each command embeds a stable marker substring `# alter-hooks:<script>` so
// install dedupe and uninstall removal can identify our entries unambiguously
// without clobbering user-authored entries that happen to reference the same
// script path.
// ---------------------------------------------------------------------------

function markerFor(script: string, arg?: string): string {
  return arg ? `# alter-hooks:${script}:${arg}` : `# alter-hooks:${script}`;
}

function buildCommand(
  hooksDir: string,
  spec: HookSpec,
  binding: HookBinding,
): string {
  const marker = markerFor(spec.script, spec.arg);
  const scriptPath = `"$D/${spec.script}"`;
  const argSuffix = spec.arg ? ` ${spec.arg}` : "";
  // Shell-quote the hooks dir for the inner single-quoted -c body. We embed it
  // via a double-quoted assignment so spaces in the path are tolerated; any
  // single quote in the path would break the -c wrapper, so reject those.
  if (hooksDir.includes("'")) {
    throw new Error(
      `hooks dir path contains a single quote, which cannot be safely embedded: ${hooksDir}`,
    );
  }
  const body = spec.stdin
    ? `INPUT=$(cat); D="${hooksDir}"; [ -x "$D/_verify.sh" ] && bash "$D/_verify.sh" >/dev/null && [ -x ${scriptPath} ] && printf "%s" "$INPUT" | bash ${scriptPath}${argSuffix}; exit 0`
    : `D="${hooksDir}"; [ -x "$D/_verify.sh" ] && bash "$D/_verify.sh" >/dev/null && [ -x ${scriptPath} ] && bash ${scriptPath}${argSuffix}; exit 0`;
  // The marker rides as a trailing shell comment inside the -c body - inert at
  // runtime, but a stable identifier for dedupe/removal.
  return `bash -c '${body} ${marker}'`;
}

function isOurCommand(command: unknown, script: string, arg?: string): boolean {
  if (typeof command !== "string") return false;
  return command.includes(markerFor(script, arg));
}

// CC settings hook shapes (intentionally permissive - we only touch our own).
interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}
interface MatcherGroup {
  matcher?: string;
  hooks: HookEntry[];
}
type HooksSection = Record<string, MatcherGroup[]>;

// ---------------------------------------------------------------------------
// Atomic IO.
// ---------------------------------------------------------------------------

function atomicWrite(target: string, content: string, mode = 0o600): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, target);
}

function readSettings(settingsPath: string): {
  settings: Record<string, unknown>;
  existed: boolean;
} | null {
  const existed = fs.existsSync(settingsPath);
  const raw = existed ? fs.readFileSync(settingsPath, "utf-8") : "{}";
  try {
    const settings = raw.trim()
      ? (JSON.parse(raw) as Record<string, unknown>)
      : {};
    return { settings, existed };
  } catch {
    return null; // not valid JSON - caller refuses
  }
}

// ---------------------------------------------------------------------------
// Manifest regen - run the bundled _verify.sh --regen in the target hooks dir
// so the manifest pins exactly the installed subset.
// ---------------------------------------------------------------------------

function regenManifest(hooksDir: string): boolean {
  const verify = path.join(hooksDir, "_verify.sh");
  if (!fs.existsSync(verify)) return false;
  try {
    execFileSync("bash", [verify, "--regen"], {
      stdio: ["ignore", "ignore", "ignore"],
      cwd: hooksDir,
    });
    return fs.existsSync(path.join(hooksDir, "manifest.sha256"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Install.
// ---------------------------------------------------------------------------

interface InstallReport {
  scope: "project" | "user";
  hooksDir: string;
  settingsPath: string;
  scriptsWritten: string[];
  bindingsAdded: number;
  bindingsAlreadyPresent: number;
  manifestRegenerated: boolean;
  warnings: string[];
}

function doInstall(target: Target): InstallReport {
  const src = assetsDir();
  if (!fs.existsSync(src)) {
    throw new Error(
      `bundled hook assets not found at ${src}. The package build did not copy src/assets/hooks into dist.`,
    );
  }

  const report: InstallReport = {
    scope: target.scope,
    hooksDir: target.hooksDir,
    settingsPath: target.settingsPath,
    scriptsWritten: [],
    bindingsAdded: 0,
    bindingsAlreadyPresent: 0,
    manifestRegenerated: false,
    warnings: [],
  };

  // 1. Copy the shim scripts (0o755) into the target hooks dir.
  fs.mkdirSync(target.hooksDir, { recursive: true, mode: 0o700 });
  for (const script of ALL_SHIPPED_SCRIPTS) {
    const from = path.join(src, script);
    if (!fs.existsSync(from)) {
      throw new Error(`bundled hook missing from assets: ${script}`);
    }
    const to = path.join(target.hooksDir, script);
    atomicWrite(to, fs.readFileSync(from, "utf-8"), 0o755);
    report.scriptsWritten.push(script);
  }

  // 2. Regenerate the manifest for exactly the installed subset.
  report.manifestRegenerated = regenManifest(target.hooksDir);
  if (!report.manifestRegenerated) {
    report.warnings.push(
      "manifest.sha256 could not be regenerated (bash/_verify.sh unavailable); the local tamper gate will fail-closed until regenerated.",
    );
  }

  // 3. Merge settings.json hook arrays (append-if-absent, never clobber).
  const read = readSettings(target.settingsPath);
  if (read === null) {
    throw new Error(
      `${target.settingsPath} is not valid JSON; refusing to modify it. Fix the file and re-run.`,
    );
  }
  const settings = read.settings;
  const hooksSection: HooksSection =
    (settings.hooks as HooksSection | undefined) ?? {};

  for (const spec of HOOK_SPECS) {
    for (const binding of spec.bindings) {
      const command = buildCommand(target.hooksDir, spec, binding);
      const entry: HookEntry = {
        type: "command",
        command,
        timeout: binding.timeout,
      };

      const groups: MatcherGroup[] = hooksSection[binding.event] ?? [];
      // Find a group with a matching matcher (treat undefined and "" alike).
      const wantMatcher = binding.matcher;
      let group = groups.find(
        (g) => (g.matcher ?? "") === wantMatcher,
      );
      if (!group) {
        group = wantMatcher
          ? { matcher: wantMatcher, hooks: [] }
          : { matcher: "", hooks: [] };
        groups.push(group);
      }
      if (!Array.isArray(group.hooks)) group.hooks = [];

      const already = group.hooks.some((h) =>
        isOurCommand(h?.command, spec.script, spec.arg),
      );
      if (already) {
        report.bindingsAlreadyPresent++;
      } else {
        group.hooks.push(entry);
        report.bindingsAdded++;
      }
      hooksSection[binding.event] = groups;
    }
  }

  settings.hooks = hooksSection;
  atomicWrite(target.settingsPath, JSON.stringify(settings, null, 2) + "\n");

  return report;
}

// ---------------------------------------------------------------------------
// Uninstall.
// ---------------------------------------------------------------------------

interface UninstallReport {
  scope: "project" | "user";
  hooksDir: string;
  settingsPath: string;
  bindingsRemoved: number;
  scriptsRemoved: string[];
  manifestRemoved: boolean;
  warnings: string[];
}

function doUninstall(target: Target): UninstallReport {
  const report: UninstallReport = {
    scope: target.scope,
    hooksDir: target.hooksDir,
    settingsPath: target.settingsPath,
    bindingsRemoved: 0,
    scriptsRemoved: [],
    manifestRemoved: false,
    warnings: [],
  };

  // 1. Strip our entries from settings.json (preserve user arrays).
  const read = readSettings(target.settingsPath);
  if (read === null) {
    report.warnings.push(
      `${target.settingsPath} is not valid JSON; left untouched. Remove alter-hooks entries manually.`,
    );
  } else if (read.existed) {
    const settings = read.settings;
    const hooksSection = settings.hooks as HooksSection | undefined;
    if (hooksSection) {
      const ourScripts = new Set(HOOK_SPECS.map((s) => markerFor(s.script, s.arg)));
      for (const event of Object.keys(hooksSection)) {
        const groups = hooksSection[event];
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          if (!Array.isArray(group.hooks)) continue;
          const before = group.hooks.length;
          group.hooks = group.hooks.filter((h) => {
            const cmd = h?.command;
            if (typeof cmd !== "string") return true;
            // Remove only entries carrying one of OUR markers.
            for (const marker of ourScripts) {
              if (cmd.includes(marker)) return false;
            }
            return true;
          });
          report.bindingsRemoved += before - group.hooks.length;
        }
        // Prune now-empty groups, then prune the event if it has no groups.
        hooksSection[event] = groups.filter(
          (g) => Array.isArray(g.hooks) && g.hooks.length > 0,
        );
        if (hooksSection[event].length === 0) {
          delete hooksSection[event];
        }
      }
      if (Object.keys(hooksSection).length === 0) {
        delete settings.hooks;
      } else {
        settings.hooks = hooksSection;
      }
      atomicWrite(
        target.settingsPath,
        JSON.stringify(settings, null, 2) + "\n",
      );
    }
  }

  // 2. Delete the shim scripts + manifest we installed.
  for (const script of ALL_SHIPPED_SCRIPTS) {
    const p = path.join(target.hooksDir, script);
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        report.scriptsRemoved.push(script);
      }
    } catch {
      report.warnings.push(`could not remove ${script}`);
    }
  }
  const manifest = path.join(target.hooksDir, "manifest.sha256");
  try {
    if (fs.existsSync(manifest)) {
      fs.unlinkSync(manifest);
      report.manifestRemoved = true;
    }
  } catch {
    report.warnings.push("could not remove manifest.sha256");
  }

  // 3. Best-effort: remove the hooks dir if now empty.
  try {
    if (
      fs.existsSync(target.hooksDir) &&
      fs.readdirSync(target.hooksDir).length === 0
    ) {
      fs.rmdirSync(target.hooksDir);
    }
  } catch {
    // leave it - non-fatal
  }

  return report;
}

// ---------------------------------------------------------------------------
// CLI surface.
// ---------------------------------------------------------------------------

interface ParsedFlags {
  scope: "project" | "user" | null;
  json: boolean;
  yes: boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  let scope: "project" | "user" | null = null;
  let json = false;
  let yes = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--user") scope = "user";
    else if (a === "--project") scope = "project";
    else throw new Error(`Unknown flag: ${a}`);
  }
  return { scope, json, yes };
}

function prettyPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function printHelp(): void {
  console.log(
    "Usage: alter hooks <install|uninstall> [--user|--project] [--json] [--yes|-y]\n" +
      "\n" +
      "Install or remove the curated set of Claude Code state-awareness\n" +
      "hooks and register them in settings.json.\n" +
      "\n" +
      "Target:\n" +
      "  project (default in a git repo)  <repo>/.claude/hooks + settings.json\n" +
      "  user    (default outside a repo) ~/.claude/hooks + settings.json\n" +
      "\n" +
      "Flags:\n" +
      "  --user      force user scope (~/.claude) even inside a repo\n" +
      "  --project   force project scope (cwd repo root)\n" +
      "  --json      emit a machine-readable report\n" +
      "  --yes, -y   skip the confirmation prompt\n" +
      "\n" +
      "Installs a curated set of local hooks: verification-source logging,\n" +
      "auto-formatting, a destructive-command guard, session awareness between\n" +
      "concurrent sessions, lesson capture, and handover continuity.\n" +
      "All are local-compute, need no login, and stay silent when they have\n" +
      "nothing to do. A tamper-check manifest pins what was installed; uninstall\n" +
      "removes only what install added.\n",
  );
}

export async function hooks(argv: string[] = []): Promise<void> {
  // B5 fix: hooks install/uninstall shells out bash and installs .sh scripts
  // that are not valid on Windows. Fail honestly on win32 rather than
  // reporting success while doing nothing.
  if (process.platform === "win32") {
    console.error(
      "alter hooks: hooks install is not supported on Windows yet.\n" +
      "  The hook scripts require bash, which is not available on this platform.\n" +
      "  Claude Code hooks must be configured manually on Windows.",
    );
    process.exitCode = 1;
    return;
  }

  const sub = argv[0];

  if (sub === "--help" || sub === "-h" || sub === undefined) {
    printHelp();
    return;
  }

  if (sub !== "install" && sub !== "uninstall") {
    console.error(
      `alter hooks: unknown sub-command "${sub}". Use install or uninstall.`,
    );
    process.exitCode = 1;
    return;
  }

  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    printHelp();
    return;
  }

  let flags: ParsedFlags;
  try {
    flags = parseFlags(rest);
  } catch (err) {
    console.error(`alter hooks: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let target: Target;
  try {
    target = resolveTarget(flags.scope);
  } catch (err) {
    console.error(`alter hooks: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  if (sub === "install") {
    let report: InstallReport;
    try {
      report = doInstall(target);
    } catch (err) {
      if (flags.json) {
        console.log(
          JSON.stringify({ ok: false, error: (err as Error).message }, null, 2),
        );
      } else {
        console.error(`alter hooks install: ${(err as Error).message}`);
      }
      process.exitCode = 1;
      return;
    }

    if (flags.json) {
      console.log(JSON.stringify({ ok: true, action: "install", ...report }, null, 2));
      return;
    }

    console.log(
      `alter hooks: installed ${report.scriptsWritten.length} scripts into ${prettyPath(report.hooksDir)} (${report.scope} scope).`,
    );
    console.log(
      `  ${report.bindingsAdded} hook binding(s) added, ${report.bindingsAlreadyPresent} already present.`,
    );
    console.log(
      `  manifest.sha256 ${report.manifestRegenerated ? "regenerated" : "NOT regenerated"}.`,
    );
    console.log(`  settings: ${prettyPath(report.settingsPath)}`);
    for (const w of report.warnings) console.log(`  WARNING: ${w}`);
    console.log(
      "  Restart Claude Code (or start a fresh session) for the hooks to take effect.",
    );
    return;
  }

  // uninstall
  let report: UninstallReport;
  try {
    report = doUninstall(target);
  } catch (err) {
    if (flags.json) {
      console.log(
        JSON.stringify({ ok: false, error: (err as Error).message }, null, 2),
      );
    } else {
      console.error(`alter hooks uninstall: ${(err as Error).message}`);
    }
    process.exitCode = 1;
    return;
  }

  if (flags.json) {
    console.log(JSON.stringify({ ok: true, action: "uninstall", ...report }, null, 2));
    return;
  }

  console.log(
    `alter hooks: removed ${report.bindingsRemoved} hook binding(s) and ${report.scriptsRemoved.length} script(s) from ${prettyPath(report.hooksDir)} (${report.scope} scope).`,
  );
  console.log(
    `  manifest.sha256 ${report.manifestRemoved ? "removed" : "not present"}.`,
  );
  console.log(`  settings: ${prettyPath(report.settingsPath)}`);
  for (const w of report.warnings) console.log(`  WARNING: ${w}`);
}

// Exported for tests.
export const __testing = {
  buildCommand,
  markerFor,
  isOurCommand,
  resolveTarget,
  doInstall,
  doUninstall,
  HOOK_SPECS,
  ALL_SHIPPED_SCRIPTS,
};
