/**
 * alter skills install | uninstall - manage the curated portable set of
 * Claude Code skills and slash-commands bundled inside the CLI.
 *
 * Mirrors `alter hooks` but is simpler: Claude Code AUTO-DISCOVERS skill
 * files (`.claude/skills/<name>/SKILL.md`) and slash-command files
 * (`.claude/commands/<name>.md`) - there is NO settings.json merge or
 * registration step. Install is therefore an atomic-copy of bundled files
 * into the right target dirs; uninstall removes ONLY the files this command
 * installed, tracked via a receipt written at install time.
 *
 * Bundled asset layout (dist/assets/skills, copied from src/assets/skills):
 *   skills/<name>/SKILL.md   → installs to <target>/.claude/skills/<name>/SKILL.md
 *   commands/<name>.md       → installs to <target>/.claude/commands/<name>.md
 *   _verify.sh               → content-integrity tamper gate over the .md set
 *   manifest.sha256          → pinned hashes the tamper gate checks
 *
 * The asset subdir (skills/ vs commands/) IS the target-subdir map: a file
 * under skills/ lands in .claude/skills/, a file under commands/ lands in
 * .claude/commands/. This keeps the installer a straight structure-preserving
 * copy with no per-file routing table to drift.
 *
 * Install target:
 *   - project-local <repo>/.claude/ when the cwd is inside a git repo;
 *   - else user-scope ~/.claude/.
 *
 * Mechanism (mirrors hooks.ts):
 *   - run the bundled _verify.sh over the asset set FIRST (refuse on drift);
 *   - mkdir -p the target dirs, atomically write each bundled file at 0o644
 *     (.md) / 0o755 (.sh);
 *   - regenerate manifest.sha256 in the INSTALLED skills dir via the bundled
 *     _verify.sh --regen so the local tamper gate pins exactly what landed;
 *   - write a receipt (<target>/.claude/.alter-skills-installed.json) listing
 *     every file we wrote, so uninstall removes exactly those and nothing the
 *     user authored.
 *
 * Idempotent: a second install overwrites our own files in place and rewrites
 * the receipt; a second uninstall is a clean no-op. Uninstall never touches a
 * skill/command the receipt does not claim.
 *
 * Flags:
 *   --user      force user-scope (~/.claude) even inside a git repo
 *   --project   force project-scope (cwd repo root); errors if not a repo
 *   --json      emit a machine-readable report and exit
 *   --yes, -y   accepted for symmetry with `alter hooks` (non-interactive)
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Skill spec - the curated portable set. Each entry names a bundled asset
// (relative to the assets root) and the kind, which determines the target
// subdir under .claude/. The asset path's first segment (skills|commands)
// already encodes this, but we keep an explicit kind for clarity + validation.
// ---------------------------------------------------------------------------

type SkillKind = "skill" | "command";

interface SkillSpec {
  /** Path relative to the assets root, e.g. "skills/homework/SKILL.md". */
  asset: string;
  kind: SkillKind;
  /** Human label for help/report output. */
  name: string;
}

const SKILL_SPECS: SkillSpec[] = [
  { asset: "skills/homework/SKILL.md", kind: "skill", name: "homework" },
  { asset: "commands/go.md", kind: "command", name: "go" },
  { asset: "commands/handover.md", kind: "command", name: "handover" },
  { asset: "commands/lessons-audit.md", kind: "command", name: "lessons-audit" },
];

// Tamper-gate assets copied alongside the .md set and pinned by the manifest.
const GATE_ASSETS = ["_verify.sh", "manifest.sha256"] as const;

const RECEIPT_NAME = ".alter-skills-installed.json";

// ---------------------------------------------------------------------------
// Asset resolution - dist/commands/skills.js → ../assets/skills.
// ---------------------------------------------------------------------------

function assetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "assets", "skills");
}

// ---------------------------------------------------------------------------
// Target resolution.
// ---------------------------------------------------------------------------

interface Target {
  scope: "project" | "user";
  claudeDir: string; // <root>/.claude
  skillsDir: string; // <root>/.claude/skills
  commandsDir: string; // <root>/.claude/commands
  receiptPath: string; // <root>/.claude/.alter-skills-installed.json
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
    skillsDir: path.join(claudeDir, "skills"),
    commandsDir: path.join(claudeDir, "commands"),
    receiptPath: path.join(claudeDir, RECEIPT_NAME),
  };
}

/** Absolute install path for a spec's bundled asset under the target. */
function targetPathFor(target: Target, spec: SkillSpec): string {
  if (spec.kind === "skill") {
    // skills/<name>/SKILL.md → <skillsDir>/<name>/SKILL.md
    const rel = spec.asset.replace(/^skills\//, "");
    return path.join(target.skillsDir, rel);
  }
  // commands/<name>.md → <commandsDir>/<name>.md
  const rel = spec.asset.replace(/^commands\//, "");
  return path.join(target.commandsDir, rel);
}

// ---------------------------------------------------------------------------
// Atomic IO (mirrors hooks.ts / inscribe.ts).
// ---------------------------------------------------------------------------

function atomicWrite(target: string, content: string, mode = 0o600): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------------------
// Tamper gate over the bundled assets - run BEFORE copying so we never
// install a drifted bundle. Mirrors the _verify.sh chain in the hooks
// installer (there, _verify.sh gates each hook at runtime; here we gate the
// bundle at install time since CC reads, not executes, the .md files).
// ---------------------------------------------------------------------------

function verifyBundle(src: string): boolean {
  const verify = path.join(src, "_verify.sh");
  if (!fs.existsSync(verify)) return false;
  try {
    execFileSync("bash", [verify], {
      stdio: ["ignore", "ignore", "ignore"],
      cwd: src,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Manifest regen in the installed skills dir, so the local tamper gate pins
// exactly the installed subset (mirrors hooks.ts regenManifest).
// ---------------------------------------------------------------------------

function regenManifest(installedSkillsRoot: string): boolean {
  const verify = path.join(installedSkillsRoot, "_verify.sh");
  if (!fs.existsSync(verify)) return false;
  try {
    execFileSync("bash", [verify, "--regen"], {
      stdio: ["ignore", "ignore", "ignore"],
      cwd: installedSkillsRoot,
    });
    return fs.existsSync(path.join(installedSkillsRoot, "manifest.sha256"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Install.
// ---------------------------------------------------------------------------

interface Receipt {
  /** Schema marker so a future installer can recognise our receipt. */
  tool: "alter-skills";
  version: 1;
  /** Absolute paths of every file we wrote (skills + commands). */
  files: string[];
  /** Skill/command names installed, for reporting. */
  names: string[];
  installedAt: string;
}

interface InstallReport {
  scope: "project" | "user";
  claudeDir: string;
  filesWritten: string[];
  skillsInstalled: string[];
  commandsInstalled: string[];
  bundleVerified: boolean;
  manifestRegenerated: boolean;
  warnings: string[];
}

function readReceipt(receiptPath: string): Receipt | null {
  if (!fs.existsSync(receiptPath)) return null;
  try {
    const raw = fs.readFileSync(receiptPath, "utf-8");
    const obj = JSON.parse(raw) as Receipt;
    if (obj && obj.tool === "alter-skills" && Array.isArray(obj.files)) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

function doInstall(target: Target): InstallReport {
  const src = assetsDir();
  if (!fs.existsSync(src)) {
    throw new Error(
      `bundled skill assets not found at ${src}. The package build did not copy src/assets/skills into dist.`,
    );
  }

  const report: InstallReport = {
    scope: target.scope,
    claudeDir: target.claudeDir,
    filesWritten: [],
    skillsInstalled: [],
    commandsInstalled: [],
    bundleVerified: false,
    manifestRegenerated: false,
    warnings: [],
  };

  // 1. Verify the bundle before copying anything (refuse on drift).
  report.bundleVerified = verifyBundle(src);
  if (!report.bundleVerified) {
    // bash/_verify.sh may be unavailable on the host; warn but continue -
    // the source bundle ships pinned and CI-verified, so a missing local
    // bash is a degraded-but-safe path, not a tamper.
    report.warnings.push(
      "bundle tamper gate could not run (bash/_verify.sh unavailable); installing the shipped bundle without a local re-verify.",
    );
  }

  // 2. Copy each bundled file into its target subdir.
  const writtenFiles: string[] = [];
  for (const spec of SKILL_SPECS) {
    const from = path.join(src, spec.asset);
    if (!fs.existsSync(from)) {
      throw new Error(`bundled skill asset missing: ${spec.asset}`);
    }
    const to = targetPathFor(target, spec);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
    atomicWrite(to, fs.readFileSync(from, "utf-8"), 0o644);
    writtenFiles.push(to);
    report.filesWritten.push(to);
    if (spec.kind === "skill") report.skillsInstalled.push(spec.name);
    else report.commandsInstalled.push(spec.name);
  }

  // 3. Copy the tamper-gate assets into the installed skills dir and regen
  //    the manifest there so a post-install drift check pins what landed.
  fs.mkdirSync(target.skillsDir, { recursive: true, mode: 0o755 });
  for (const gate of GATE_ASSETS) {
    const from = path.join(src, gate);
    if (!fs.existsSync(from)) continue;
    const to = path.join(target.skillsDir, gate);
    atomicWrite(
      to,
      fs.readFileSync(from, "utf-8"),
      gate.endsWith(".sh") ? 0o755 : 0o644,
    );
    writtenFiles.push(to);
    report.filesWritten.push(to);
  }
  report.manifestRegenerated = regenManifest(target.skillsDir);
  // Re-pin the receipt's view of the manifest after regen (its hash changed).
  if (!report.manifestRegenerated) {
    report.warnings.push(
      "manifest.sha256 could not be regenerated in the installed skills dir (bash unavailable); the local drift check will use the shipped manifest.",
    );
  }

  // 4. Write the install receipt (every file we wrote → uninstall scope).
  const receipt: Receipt = {
    tool: "alter-skills",
    version: 1,
    files: writtenFiles,
    names: SKILL_SPECS.map((s) => s.name),
    installedAt: new Date().toISOString(),
  };
  fs.mkdirSync(target.claudeDir, { recursive: true, mode: 0o755 });
  atomicWrite(target.receiptPath, JSON.stringify(receipt, null, 2) + "\n", 0o644);
  report.filesWritten.push(target.receiptPath);

  return report;
}

// ---------------------------------------------------------------------------
// Uninstall - remove ONLY what the receipt claims. Never touch a
// user-authored skill/command we did not install.
// ---------------------------------------------------------------------------

interface UninstallReport {
  scope: "project" | "user";
  claudeDir: string;
  filesRemoved: string[];
  dirsPruned: string[];
  warnings: string[];
}

function doUninstall(target: Target): UninstallReport {
  const report: UninstallReport = {
    scope: target.scope,
    claudeDir: target.claudeDir,
    filesRemoved: [],
    dirsPruned: [],
    warnings: [],
  };

  const receipt = readReceipt(target.receiptPath);
  if (!receipt) {
    report.warnings.push(
      `no install receipt at ${target.receiptPath}; nothing to uninstall (or it was installed by a different tool/version).`,
    );
    return report;
  }

  // 1. Remove each file the receipt claims (skip the receipt itself for now).
  for (const f of receipt.files) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        report.filesRemoved.push(f);
      }
    } catch {
      report.warnings.push(`could not remove ${f}`);
    }
  }

  // 2. Prune now-empty dirs we plausibly created: each skill's own dir, and
  //    the skills/commands dirs if WE emptied them. Never rmdir a non-empty
  //    dir (a user-authored skill/command keeps its parent alive).
  const candidateDirs = new Set<string>();
  for (const f of receipt.files) {
    candidateDirs.add(path.dirname(f)); // e.g. .claude/skills/homework
  }
  // Deepest-first so a skill dir is pruned before its skills/ parent.
  const ordered = [...candidateDirs].sort((a, b) => b.length - a.length);
  for (const d of ordered) {
    pruneIfEmpty(d, report);
  }
  // Then attempt the top-level skills/ and commands/ dirs.
  pruneIfEmpty(target.skillsDir, report);
  pruneIfEmpty(target.commandsDir, report);

  // 3. Remove the receipt last.
  try {
    if (fs.existsSync(target.receiptPath)) {
      fs.unlinkSync(target.receiptPath);
      report.filesRemoved.push(target.receiptPath);
    }
  } catch {
    report.warnings.push("could not remove install receipt");
  }

  return report;
}

function pruneIfEmpty(dir: string, report: UninstallReport): void {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      report.dirsPruned.push(dir);
    }
  } catch {
    // non-fatal - leave it
  }
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
    "Usage: alter skills <install|uninstall> [--user|--project] [--json] [--yes|-y]\n" +
      "\n" +
      "Install or remove the curated set of Claude Code skills and slash-commands.\n" +
      "Claude Code auto-discovers them - no settings.json change is needed.\n" +
      "\n" +
      "Target:\n" +
      "  project (default in a git repo)  <repo>/.claude/{skills,commands}\n" +
      "  user    (default outside a repo) ~/.claude/{skills,commands}\n" +
      "\n" +
      "Flags:\n" +
      "  --user      force user scope (~/.claude) even inside a repo\n" +
      "  --project   force project scope (cwd repo root)\n" +
      "  --json      emit a machine-readable report\n" +
      "  --yes, -y   non-interactive (accepted for symmetry with `alter hooks`)\n" +
      "\n" +
      "Installed:\n" +
      "  skills/    homework (state pre-flight before asking you)\n" +
      "  commands/  go (continue from a handover), handover (session pointer),\n" +
      "             lessons-audit (lesson corpus audit)\n" +
      "\n" +
      "Uninstall removes only the files this command installed (tracked in\n" +
      "<target>/.claude/.alter-skills-installed.json); user-authored skills and\n" +
      "commands are never touched.\n",
  );
}

export async function skills(argv: string[] = []): Promise<void> {
  const sub = argv[0];

  if (sub === "--help" || sub === "-h" || sub === undefined) {
    printHelp();
    return;
  }

  if (sub !== "install" && sub !== "uninstall") {
    console.error(
      `alter skills: unknown sub-command "${sub}". Use install or uninstall.`,
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
    console.error(`alter skills: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let target: Target;
  try {
    target = resolveTarget(flags.scope);
  } catch (err) {
    console.error(`alter skills: ${(err as Error).message}`);
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
        console.error(`alter skills install: ${(err as Error).message}`);
      }
      process.exitCode = 1;
      return;
    }

    if (flags.json) {
      console.log(
        JSON.stringify({ ok: true, action: "install", ...report }, null, 2),
      );
      return;
    }

    console.log(
      `alter skills: installed ${report.skillsInstalled.length} skill(s) and ${report.commandsInstalled.length} command(s) into ${prettyPath(report.claudeDir)} (${report.scope} scope).`,
    );
    if (report.skillsInstalled.length) {
      console.log(`  skills:   ${report.skillsInstalled.join(", ")}`);
    }
    if (report.commandsInstalled.length) {
      console.log(`  commands: ${report.commandsInstalled.join(", ")}`);
    }
    console.log(
      `  bundle ${report.bundleVerified ? "verified" : "NOT re-verified locally"}; manifest ${report.manifestRegenerated ? "regenerated" : "not regenerated"}.`,
    );
    for (const w of report.warnings) console.log(`  WARNING: ${w}`);
    console.log(
      "  Start a fresh Claude Code session (or /reload) for the skills to be discovered.",
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
      console.error(`alter skills uninstall: ${(err as Error).message}`);
    }
    process.exitCode = 1;
    return;
  }

  if (flags.json) {
    console.log(
      JSON.stringify({ ok: true, action: "uninstall", ...report }, null, 2),
    );
    return;
  }

  console.log(
    `alter skills: removed ${report.filesRemoved.length} file(s) from ${prettyPath(report.claudeDir)} (${report.scope} scope).`,
  );
  if (report.dirsPruned.length) {
    console.log(`  pruned ${report.dirsPruned.length} now-empty dir(s).`);
  }
  for (const w of report.warnings) console.log(`  WARNING: ${w}`);
}

// Exported for tests.
export const __testing = {
  resolveTarget,
  targetPathFor,
  doInstall,
  doUninstall,
  readReceipt,
  parseFlags,
  SKILL_SPECS,
  GATE_ASSETS,
  RECEIPT_NAME,
};
