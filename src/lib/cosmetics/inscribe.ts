/**
 * Cosmetic inscription IO layer - atomic writes with marker
 * wrapping, idempotency, synced-volume refusal, and provenance
 * recording for unwire.
 *
 * Contract:
 *   - Every text-based insert is wrapped in handle-namespaced markers
 *     (`# BEGIN ALTER ~handle cosmetics ... # END`).
 *   - Re-inscribing the same handle into a file with an existing
 *     block is idempotent: we replace in place, preserving the
 *     surrounding content.
 *   - cc-statusline is special: writes a separate
 *     ~/.claude/alter-statusline.sh script and merges the
 *     statusLine.command key into ~/.claude/settings.json (JSON, not
 *     text - markers don't apply).
 *   - Synced volumes (Dropbox, iCloud, Google Drive, OneDrive) are
 *     refused via @truealter/sdk's detectSyncedVolume; the inscription
 *     is recorded as 'skipped' with reason for honest UX.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { detectSyncedVolume } from "@truealter/sdk";

import type { DetectedSurface } from "./detect.js";
import * as os from "os";
import {
  ALTER_HELPER_SCRIPT_PATH,
  PFETCH_EXTRAS_PATH,
  commentChar,
  findExistingBlock,
  makeMarkers,
  markerTag,
  renderBody,
  renderCcStatuslineScript,
  renderCcStatuslineFullScript,
  readDefaultStatuslineWardrobe,
  renderIdentityRowScript,
  renderNeofetchBody,
  renderPfetchExtrasScript,
  renderPfetchFishBody,
  renderPfetchShellrcBody,
  type SnippetCtx,
} from "./snippets.js";
import {
  type CosmeticState,
  type Inscription,
  type SurfaceId,
  COSMETIC_STATE_VERSION,
  readCosmeticState,
  writeCosmeticState,
} from "./state.js";

export interface InscribeResult {
  surface: SurfaceId;
  status: "written" | "replaced" | "skipped" | "failed";
  path: string;
  reason?: string;
}

export interface InscribeReport {
  results: InscribeResult[];
  state: CosmeticState;
}

export async function inscribeMany(
  surfaces: DetectedSurface[],
  ctx: SnippetCtx,
): Promise<InscribeReport> {
  const prior = readCosmeticState();
  const inscriptions: Inscription[] =
    prior?.handle === ctx.handle ? [...prior.inscriptions] : [];
  const results: InscribeResult[] = [];

  for (const surface of surfaces) {
    try {
      const result = await inscribeOne(surface, ctx);
      results.push(result);
      if (result.status === "written" || result.status === "replaced") {
        // Refresh inscription record (drop any prior for this surface).
        const filtered = inscriptions.filter((i) => i.surface !== surface.id);
        const markers = markersForSurface(surface.id, ctx.handle);
        filtered.push({
          surface: surface.id,
          path: result.path,
          markerStart: markers.start,
          markerEnd: markers.end,
          backupSha256: hashIfExists(surface.targetPath),
          inscribedAt: new Date().toISOString(),
        });
        // Splice back: assign-by-reuse pattern
        inscriptions.length = 0;
        inscriptions.push(...filtered);
      }
    } catch (err) {
      results.push({
        surface: surface.id,
        status: "failed",
        path: surface.targetPath,
        reason: (err as Error).message,
      });
    }
  }

  const state: CosmeticState = {
    version: COSMETIC_STATE_VERSION,
    handle: ctx.handle,
    inscriptions,
  };
  writeCosmeticState(state);

  return { results, state };
}

async function inscribeOne(
  surface: DetectedSurface,
  ctx: SnippetCtx,
): Promise<InscribeResult> {
  // Synced-volume refusal - never silently mutate a Dropbox-tracked
  // file (would propagate to other devices the user didn't consent to).
  const synced = detectSyncedVolume(surface.targetPath);
  if (synced) {
    return {
      surface: surface.id,
      status: "skipped",
      path: surface.targetPath,
      reason: `synced volume: ${synced.matchedPrefix}`,
    };
  }

  if (surface.id === "cc-statusline") {
    return inscribeCcStatusline(surface, ctx);
  }
  if (surface.id === "pfetch") {
    return inscribePfetch(surface, ctx);
  }
  if (surface.id === "neofetch") {
    return inscribeNeofetch(surface, ctx);
  }
  if (surface.id === "fastfetch") {
    // fastfetch's paste-snippet references the shared identity-row.sh
    // helper, so the helper must exist when the user follows the
    // instructions. Write it as a side-effect of fastfetch inscription
    // (idempotent - neofetch and fastfetch share the same file).
    writeIdentityRowHelper();
  }
  return inscribeTextSurface(surface, ctx);
}

function inscribeTextSurface(
  surface: DetectedSurface,
  ctx: SnippetCtx,
): InscribeResult {
  const target = surface.targetPath;
  const comment = commentChar(surface.id);
  const tag = markerTag(surface.id);
  const markers = makeMarkers(ctx.handle, comment, tag);
  const body = renderBody(surface.id, ctx);
  const block = `${markers.start}\n${body}\n${markers.end}\n`;

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

  const existed = fs.existsSync(target);
  const existing = existed ? fs.readFileSync(target, "utf-8") : "";

  let next: string;
  let status: "written" | "replaced";

  const found = findExistingBlock(existing, ctx.handle, comment, tag);
  if (found) {
    // Replace in place - same handle, same surface, fresh timestamp.
    next =
      existing.slice(0, found.startIdx) +
      block.replace(/\n$/, "") +
      existing.slice(found.endIdx);
    status = "replaced";
  } else {
    const sep =
      existing.length === 0 || existing.endsWith("\n\n")
        ? ""
        : existing.endsWith("\n")
          ? "\n"
          : "\n\n";
    next = existing + sep + block;
    status = "written";
  }

  atomicWrite(target, next);
  return { surface: surface.id, status, path: target };
}

// ---------------------------------------------------------------------------
// pfetch - two-file inscription:
//   1. ~/.config/alter/pfetch-extras.sh  (ALTER-owned get_alter script)
//   2. A pfetch-tagged marker block in the active shellrc defining a
//      pfetch() wrapper function that sets PF_SOURCE + PF_INFO
//      scoped to each invocation.
// ---------------------------------------------------------------------------

function inscribePfetch(
  surface: DetectedSurface,
  ctx: SnippetCtx,
): InscribeResult {
  const extrasPath = expandHome(PFETCH_EXTRAS_PATH);

  // 1. Write the extras script. Whole file is ALTER-owned so no markers.
  fs.mkdirSync(path.dirname(extrasPath), { recursive: true, mode: 0o700 });
  atomicWrite(extrasPath, renderPfetchExtrasScript() + "\n");

  // 2. Inscribe the wrapper function into the active shellrc with a
  //    pfetch-tagged marker so it can coexist with the generic shellrc
  //    block (which carries the default "cosmetics" tag).
  const shellrc = surface.targetPath;
  const shellKind = inferShellKind(shellrc);
  const body =
    shellKind === "fish" ? renderPfetchFishBody() : renderPfetchShellrcBody(shellKind);

  const comment = commentChar("pfetch");
  const tag = markerTag("pfetch");
  const markers = makeMarkers(ctx.handle, comment, tag);
  const block = `${markers.start}\n${body}\n${markers.end}\n`;

  fs.mkdirSync(path.dirname(shellrc), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(shellrc);
  const existing = existed ? fs.readFileSync(shellrc, "utf-8") : "";

  let next: string;
  let status: "written" | "replaced";
  const found = findExistingBlock(existing, ctx.handle, comment, tag);
  if (found) {
    next =
      existing.slice(0, found.startIdx) +
      block.replace(/\n$/, "") +
      existing.slice(found.endIdx);
    status = "replaced";
  } else {
    const sep =
      existing.length === 0 || existing.endsWith("\n\n")
        ? ""
        : existing.endsWith("\n")
          ? "\n"
          : "\n\n";
    next = existing + sep + block;
    status = "written";
  }
  atomicWrite(shellrc, next);
  return { surface: surface.id, status, path: shellrc };
}

// ---------------------------------------------------------------------------
// neofetch - two-file inscription:
//   1. ~/.config/alter/identity-row.sh  (shared helper: prints "~handle / Lx")
//   2. A paste-snippet marker block alongside config.conf (NOT inside
//      print_info() - that injection is fragile). The user pastes the
//      info() line the block comments point to.
// ---------------------------------------------------------------------------

function inscribeNeofetch(
  surface: DetectedSurface,
  ctx: SnippetCtx,
): InscribeResult {
  writeIdentityRowHelper();

  // Marker block in the neofetch config.conf, as a comment-only hint
  // (neofetch's config.conf is bash syntax; `#` comments are safe).
  const target = surface.targetPath;
  const comment = commentChar("neofetch");
  const tag = markerTag("neofetch");
  const markers = makeMarkers(ctx.handle, comment, tag);
  const body = renderNeofetchBody(ctx);
  const block = `${markers.start}\n${body}\n${markers.end}\n`;

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(target);
  const existing = existed ? fs.readFileSync(target, "utf-8") : "";

  let next: string;
  let status: "written" | "replaced";
  const found = findExistingBlock(existing, ctx.handle, comment, tag);
  if (found) {
    next =
      existing.slice(0, found.startIdx) +
      block.replace(/\n$/, "") +
      existing.slice(found.endIdx);
    status = "replaced";
  } else {
    const sep =
      existing.length === 0 || existing.endsWith("\n\n")
        ? ""
        : existing.endsWith("\n")
          ? "\n"
          : "\n\n";
    next = existing + sep + block;
    status = "written";
  }
  atomicWrite(target, next);
  return { surface: surface.id, status, path: target };
}

/**
 * Ensure the shared identity-row helper script exists. Idempotent:
 * re-running overwrites with current content, which stays stable
 * across runs (no handle-specific bits - reads session at invoke time).
 */
function writeIdentityRowHelper(): void {
  const p = expandHome(ALTER_HELPER_SCRIPT_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  atomicWrite(p, renderIdentityRowScript() + "\n", 0o755);
}

function expandHome(p: string): string {
  return p.replace(/^\$HOME/, os.homedir());
}

/** Path to the full-statusline wardrobe config (segment order/visibility). */
function ccStatuslineWardrobePath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "alter", "statusline-wardrobe.json");
}

function inferShellKind(targetPath: string): "bash" | "zsh" | "fish" {
  if (targetPath.includes("/fish/")) return "fish";
  if (targetPath.endsWith(".bashrc") || targetPath.endsWith(".bash_profile"))
    return "bash";
  return "zsh";
}

function inscribeCcStatusline(
  surface: DetectedSurface,
  ctx: SnippetCtx,
): InscribeResult {
  const settingsPath = surface.targetPath;
  const claudeDir = path.dirname(settingsPath);
  const shimPath = path.join(claudeDir, "alter-statusline.sh");

  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });

  const variant = ctx.statuslineVariant ?? "minimal";

  // Write the shim script - versioned by handle in a header comment so
  // multi-handle machines see whose script this is. The "full" variant
  // writes the bundled rich statusline; "minimal" the inline identity shim.
  // Both land at the same managed path so unwire is variant-agnostic.
  const scriptBody =
    variant === "full" ? renderCcStatuslineFullScript() : renderCcStatuslineScript();
  const shim =
    `# Inscribed by alter wire (${variant}) for ${ctx.handle} at ${new Date().toISOString()}\n` +
    scriptBody +
    "\n";
  atomicWrite(shimPath, shim, 0o755);

  // The full preset reads a wardrobe config for segment order/visibility.
  // Seed the shipped default only if the user has none - never clobber a
  // wardrobe they have customised. Reversed on unwire iff still unmodified.
  if (variant === "full") {
    const wardrobePath = ccStatuslineWardrobePath();
    if (!fs.existsSync(wardrobePath)) {
      fs.mkdirSync(path.dirname(wardrobePath), { recursive: true, mode: 0o700 });
      atomicWrite(wardrobePath, readDefaultStatuslineWardrobe());
    }
  }

  // Merge statusLine into settings.json. Do NOT overwrite a
  // user-curated statusLine - only set if empty/absent.
  const existed = fs.existsSync(settingsPath);
  const raw = existed ? fs.readFileSync(settingsPath, "utf-8") : "{}";
  let settings: Record<string, unknown>;
  try {
    settings = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {
      surface: surface.id,
      status: "failed",
      path: settingsPath,
      reason: "settings.json is not valid JSON; refusing to overwrite",
    };
  }

  const currentSL = settings.statusLine as
    | { command?: string; type?: string }
    | undefined;
  let status: "written" | "replaced" = "written";

  // Idempotency: detect our own shim by exact-path match.
  if (currentSL?.command && currentSL.command.includes("alter-statusline.sh")) {
    status = "replaced";
  } else if (currentSL?.command) {
    return {
      surface: surface.id,
      status: "skipped",
      path: settingsPath,
      reason: "settings.json statusLine.command already set; not overwriting",
    };
  }

  settings.statusLine = {
    type: "command",
    command: `bash ${shimPath}`,
    padding: 0,
  };

  atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { surface: surface.id, status, path: settingsPath };
}

function markersForSurface(
  id: SurfaceId,
  handle: string,
): { start: string; end: string } {
  if (id === "cc-statusline") {
    // No in-file markers for CC - the whole statusLine.command field is
    // the marker. Record the script path so unwire can find it.
    return {
      start: `(json) statusLine.command -> alter-statusline.sh for ${handle}`,
      end: `(json) end`,
    };
  }
  return makeMarkers(handle, commentChar(id), markerTag(id));
}

function atomicWrite(target: string, content: string, mode = 0o600): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, target);
}

function hashIfExists(p: string): string | null {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Reverse: unwire-cosmetics
// ----------------------------------------------------------------------------

export interface UninscribeResult {
  surface: SurfaceId;
  status: "removed" | "skipped" | "failed";
  path: string;
  reason?: string;
}

export function uninscribeAll(): UninscribeResult[] {
  const state = readCosmeticState();
  if (!state) return [];

  const results: UninscribeResult[] = [];
  for (const insc of state.inscriptions) {
    try {
      results.push(uninscribeOne(insc, state.handle));
    } catch (err) {
      results.push({
        surface: insc.surface,
        status: "failed",
        path: insc.path,
        reason: (err as Error).message,
      });
    }
  }
  return results;
}

function uninscribeOne(insc: Inscription, handle: string): UninscribeResult {
  if (insc.surface === "cc-statusline") {
    return uninscribeCcStatusline(insc);
  }

  if (!fs.existsSync(insc.path)) {
    return {
      surface: insc.surface,
      status: "skipped",
      path: insc.path,
      reason: "file no longer exists",
    };
  }
  const body = fs.readFileSync(insc.path, "utf-8");
  const tag = markerTag(insc.surface);
  const found = findExistingBlock(body, handle, commentChar(insc.surface), tag);
  if (!found) {
    return {
      surface: insc.surface,
      status: "skipped",
      path: insc.path,
      reason: "marker block not present (already removed?)",
    };
  }

  // Strip block + one trailing newline if the result has a double-blank.
  let next = body.slice(0, found.startIdx) + body.slice(found.endIdx);
  next = next.replace(/\n{3,}/g, "\n\n");
  atomicWrite(insc.path, next);

  // pfetch owns the ALTER-side extras script; remove it on unwire so
  // re-inscription is fully reversible. neofetch's helper is shared
  // with fastfetch - leave it in place unless fastfetch is also
  // being unwired (handled at the uninscribeAll level elsewhere if
  // that contract is added; for now leaving the helper is safe).
  if (insc.surface === "pfetch") {
    const extrasPath = expandHome(PFETCH_EXTRAS_PATH);
    try {
      fs.unlinkSync(extrasPath);
    } catch {
      // already gone - fine
    }
  }

  return { surface: insc.surface, status: "removed", path: insc.path };
}

function uninscribeCcStatusline(insc: Inscription): UninscribeResult {
  const settingsPath = insc.path;
  if (!fs.existsSync(settingsPath)) {
    return {
      surface: insc.surface,
      status: "skipped",
      path: settingsPath,
      reason: "settings.json gone",
    };
  }
  const raw = fs.readFileSync(settingsPath, "utf-8");
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      surface: insc.surface,
      status: "failed",
      path: settingsPath,
      reason: "settings.json is not valid JSON; manual cleanup required",
    };
  }
  const sl = settings.statusLine as { command?: string } | undefined;
  if (!sl?.command || !sl.command.includes("alter-statusline.sh")) {
    return {
      surface: insc.surface,
      status: "skipped",
      path: settingsPath,
      reason: "statusLine no longer points at alter shim",
    };
  }
  delete settings.statusLine;
  atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // Best-effort: remove the shim script.
  const shimPath = path.join(path.dirname(settingsPath), "alter-statusline.sh");
  try {
    fs.unlinkSync(shimPath);
  } catch {
    // already gone
  }

  // Full-preset only: remove the seeded wardrobe config iff it still matches
  // the shipped default byte-for-byte. If the user edited it, leave it - we
  // never destroy their customisation.
  try {
    const wardrobePath = ccStatuslineWardrobePath();
    if (fs.existsSync(wardrobePath)) {
      const current = fs.readFileSync(wardrobePath, "utf-8");
      if (current === readDefaultStatuslineWardrobe()) {
        fs.unlinkSync(wardrobePath);
      }
    }
  } catch {
    // best-effort; leave the wardrobe in place on any error
  }

  return { surface: insc.surface, status: "removed", path: settingsPath };
}

export const __testing = { atomicWrite, hashIfExists, markersForSurface };
