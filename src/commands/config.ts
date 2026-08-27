/**
 * `alter config` - inspect and edit the layered TOML configuration.
 *
 * Verbs:
 *   alter config get [key]       print a single key, or the whole
 *                                merged config if omitted
 *   alter config set <key> <val> write a scalar to the user layer
 *   alter config edit            open $EDITOR on ~/.config/alter/config.toml
 *   alter config path            print which file each layer resolves to
 *
 * `get` reads through all four layers (defaults → system → user →
 * session) and prints the merged result. `set` only writes to the user
 * layer; other layers are untouched. Missing user layer is created on
 * first `set` with the schema's `version` key pre-stamped.
 *
 * Key grammar is dotted (`palette`, `opener.line`, `opener.library`,
 * `sigil.primitives`). Unknown keys still set - the loader will
 * round-trip them via `_passthrough` so forward-compatible additions
 * survive an older CLI.
 */

import * as fs from "fs";
import { spawn } from "child_process";

import {
  SYSTEM_CONFIG_FILE,
  USER_CONFIG_DIR,
  USER_CONFIG_FILE,
  sessionConfigFile,
} from "../config/paths.js";
import { parseCommandString, CommandParseError } from "../lib/parse-cmd.js";
import { which } from "../lib/which.js";
import {
  loadConfig,
  projectRawConfig,
  serialiseUserConfig,
} from "../config/loader.js";
import {
  SCHEMA_VERSION,
  isPaletteVariant,
  isSigilAccentGlyph,
  isSigilBorderSet,
  isSigilWordmark,
  type ConfigV1,
  type CustomPaletteColors,
  type PaletteSelection,
  type SigilConfig,
} from "../config/schema.js";

export async function config(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "get":
      await cmdGet(args.slice(1));
      return;
    case "set":
      await cmdSet(args.slice(1));
      return;
    case "edit":
      await cmdEdit();
      return;
    case "path":
      cmdPath();
      return;
    default:
      console.error(`Unknown: alter config ${sub}`);
      printHelp();
      process.exitCode = 1;
      return;
  }
}

function printHelp(): void {
  console.log(`
alter config -- inspect and edit layered TOML configuration.

Verbs:
  alter config get [key]       Print a single key or the whole merged config
  alter config set <key> <val> Write a scalar to the user layer
  alter config edit            Open $EDITOR on the user config file
  alter config path            Print which file each layer resolves to

Keys:
  palette            muted-gold variant (gold-on-charcoal | gold-on-ivory |
                     gold-on-oxblood)
  opener.library     rotating opener library id (default: "default")
  opener.line        authored override -- verbatim, rotation disabled
  sigil.border_set   thin | thick | double | ascii  (or pick in the 'alter' menu)
  sigil.wordmark     ~alter | ~Alter | ALTER
  sigil.accent_glyph one of the glyph primitives

Layers (lowest -> highest precedence):
  defaults  built in       Alter brand floor
  system    $ALTER_SYSTEM_CONFIG or /etc/alter/config.toml (optional)
  user      ~/.config/alter/config.toml (written by 'alter config set')
  session   $ALTER_CONFIG_FILE (optional, process-scoped)
`);
}

async function cmdGet(args: string[]): Promise<void> {
  const key = args[0];
  const cfg = await loadConfig();

  if (!key) {
    const { stringify } = await import("smol-toml");
    const serialisable: Record<string, unknown> = {
      version: cfg.version,
    };
    if (cfg.palette !== undefined) serialisable.palette = cfg.palette;
    if (cfg.custom_palette !== undefined) {
      serialisable.custom_palette = cfg.custom_palette as unknown as Record<
        string,
        unknown
      >;
    }
    if (cfg.opener !== undefined) {
      serialisable.opener = cfg.opener as unknown as Record<string, unknown>;
    }
    if (cfg.sigil !== undefined) {
      const sigilOut: Record<string, unknown> = {};
      if (cfg.sigil.border_set !== undefined) sigilOut.border_set = cfg.sigil.border_set;
      if (cfg.sigil.wordmark !== undefined) sigilOut.wordmark = cfg.sigil.wordmark;
      if (cfg.sigil.accent_glyph !== undefined) sigilOut.accent_glyph = cfg.sigil.accent_glyph;
      if (Object.keys(sigilOut).length > 0) serialisable.sigil = sigilOut;
    }
    if (cfg.homepage !== undefined) {
      serialisable.homepage = cfg.homepage as unknown as Record<
        string,
        unknown
      >;
    }
    if (cfg._passthrough) {
      for (const [k, v] of Object.entries(cfg._passthrough)) {
        if (!(k in serialisable)) serialisable[k] = v;
      }
    }
    process.stdout.write(stringify(serialisable));
    process.stdout.write("\n");
    return;
  }

  const value = resolveKey(cfg, key);
  if (value === undefined) {
    console.error(`alter config: no such key: ${key}`);
    process.exitCode = 1;
    return;
  }
  if (typeof value === "string" || typeof value === "number") {
    console.log(String(value));
  } else {
    console.log(JSON.stringify(value));
  }
}

async function cmdSet(args: string[]): Promise<void> {
  const key = args[0];
  const value = args[1];
  if (!key || value === undefined) {
    console.error("Usage: alter config set <key> <value>");
    process.exitCode = 1;
    return;
  }

  const existing = await readUserConfigOrDefault();
  const updated = applyScalarKey(existing, key, value);
  await writeUserConfig(updated);
  console.log(`alter config: ${key} = ${value}`);
}

async function cmdEdit(): Promise<void> {
  await ensureUserConfigExists();
  const editor =
    process.env.VISUAL ?? process.env.EDITOR ?? fallbackEditor();
  if (!editor) {
    console.error(
      "alter config edit: no $VISUAL or $EDITOR set and no fallback found.",
    );
    console.error(`File is at ${USER_CONFIG_FILE}`);
    process.exitCode = 1;
    return;
  }

  // Parse the editor command without invoking a shell. Rejects values
  // that smuggle in `;`, `|`, `$()` etc., so a hostile `$EDITOR` can't
  // turn a config-edit invocation into arbitrary command execution.
  let bin: string;
  let editorArgs: string[];
  try {
    const tokens = parseCommandString(editor);
    [bin, ...editorArgs] = tokens as [string, ...string[]];
  } catch (err) {
    const message =
      err instanceof CommandParseError ? err.message : String(err);
    console.error(
      `alter config edit: refusing to launch editor - ${message}. ` +
        "Set $EDITOR to a plain command (e.g. 'nano' or '/usr/bin/code -w').",
    );
    process.exitCode = 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin!, [...editorArgs, USER_CONFIG_FILE], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited ${code}`));
    });
  });

  // Re-parse so the user sees any syntax error immediately rather than
  // on next invocation.
  try {
    await loadConfig();
  } catch (err) {
    const e = err as Error;
    console.error(`alter config: ${e.message}`);
    process.exitCode = 1;
    return;
  }
}

function cmdPath(): void {
  const lines: string[] = [];
  lines.push(`user     ${USER_CONFIG_FILE}`);
  lines.push(`system   ${SYSTEM_CONFIG_FILE}`);
  const sess = sessionConfigFile();
  lines.push(`session  ${sess ?? "(unset)"}`);
  console.log(lines.join("\n"));
}

function fallbackEditor(): string | null {
  for (const candidate of ["nano", "vi"]) {
    if (which(candidate)) return candidate;
  }
  return null;
}

async function readUserConfigOrDefault(): Promise<ConfigV1> {
  if (!fs.existsSync(USER_CONFIG_FILE)) {
    return { version: SCHEMA_VERSION };
  }
  const contents = fs.readFileSync(USER_CONFIG_FILE, "utf8");
  const { parse } = await import("smol-toml");
  const raw = parse(contents) as Record<string, unknown>;
  // Full projection (not an ad-hoc field list): the loader's projector
  // carries homepage AND `_passthrough`, so a `config set` round-trip
  // never destroys tables this CLI version doesn't type. The previous
  // hand-rolled version dropped both - any `set` silently deleted a
  // hand-authored [homepage] table and every forward-compatible key.
  return projectRawConfig(raw);
}

async function writeUserConfig(cfg: ConfigV1): Promise<void> {
  await ensureUserConfigDir();
  const body = await serialiseUserConfig(cfg);
  // Atomic write: tmp + rename stops a ^C mid-write from corrupting the
  // file. The user config is user-authored state - never silently lose
  // it; you cannot take permission back once given.
  const tmp = `${USER_CONFIG_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, USER_CONFIG_FILE);
}

/**
 * Atomically write palette and/or sigil into the user config layer.
 * Used by the Customise menu flows - the Palette picker (palette only),
 * the Sigil composer (sigil only), and "Restore the default look"
 * (both). An omitted slot preserves whatever is on disk; existing
 * opener / passthrough / unrelated keys are always preserved.
 */
export async function setUserTheme(theme: {
  palette?: PaletteSelection;
  custom_palette?: CustomPaletteColors;
  sigil?: SigilConfig;
}): Promise<void> {
  const existing = await readUserConfigOrDefault();
  const next: ConfigV1 = {
    ...existing,
    version: SCHEMA_VERSION,
    ...(theme.palette !== undefined ? { palette: theme.palette } : {}),
    ...(theme.custom_palette !== undefined
      ? { custom_palette: { ...theme.custom_palette } }
      : {}),
    ...(theme.sigil !== undefined ? { sigil: { ...theme.sigil } } : {}),
  };
  await writeUserConfig(next);
}

/**
 * Persist the OTP-verified contact email into the user-layer config as a
 * local display cache. The backend record (set via the verify ceremony in
 * the menu's Account › Contact email flow) is the source of truth - this
 * is the ONLY sanctioned write path for `homepage.contact_email`; the
 * `config set` path rejects the key so an unverified address can never
 * enter the cache. Pass `null` to clear (after a backend DELETE).
 */
export async function writeContactEmailCache(
  email: string | null,
  verifiedAt: string | null,
): Promise<void> {
  const existing = await readUserConfigOrDefault();
  const next: ConfigV1 = { ...existing, version: SCHEMA_VERSION };
  const homepage = { ...(next.homepage ?? {}) };
  if (email === null) {
    delete homepage.contact_email;
    delete homepage.contact_email_verified_at;
  } else {
    homepage.contact_email = email;
    if (verifiedAt) homepage.contact_email_verified_at = verifiedAt;
    else delete homepage.contact_email_verified_at;
  }
  if (Object.keys(homepage).length > 0) next.homepage = homepage;
  else delete next.homepage;
  await writeUserConfig(next);
}

async function ensureUserConfigDir(): Promise<void> {
  fs.mkdirSync(USER_CONFIG_DIR, { recursive: true, mode: 0o700 });
}

async function ensureUserConfigExists(): Promise<void> {
  await ensureUserConfigDir();
  if (!fs.existsSync(USER_CONFIG_FILE)) {
    await writeUserConfig({ version: SCHEMA_VERSION });
  }
}

function resolveKey(cfg: ConfigV1, key: string): unknown {
  const parts = key.split(".");
  let node: unknown = cfg as unknown as Record<string, unknown>;
  for (const p of parts) {
    if (node === null || typeof node !== "object") return undefined;
    const rec = node as Record<string, unknown>;
    if (!(p in rec)) return undefined;
    node = rec[p];
  }
  return node;
}

export function applyScalarKey(
  cfg: ConfigV1,
  key: string,
  raw: string,
): ConfigV1 {
  const parsed = parseScalar(raw);
  const next: ConfigV1 = { ...cfg, version: SCHEMA_VERSION };

  switch (key) {
    case "palette":
      // `config set` only sets presets. "custom" needs the per-role hex
      // map, which is authored in the menu (Me › Customise › Custom
      // colours), never via a bare scalar set.
      if (parsed === "custom") {
        throw new Error(
          `palette "custom" is built in the menu: Me -> Customise -> Custom colours`,
        );
      }
      if (typeof parsed !== "string" || !isPaletteVariant(parsed)) {
        throw new Error(
          `palette must be one of: gold-on-charcoal, gold-on-ivory, gold-on-oxblood`,
        );
      }
      next.palette = parsed;
      return next;
    case "opener.library":
      if (typeof parsed !== "string") {
        throw new Error(`opener.library must be a string`);
      }
      next.opener = { library: parsed };
      return next;
    case "opener.line":
      if (typeof parsed !== "string") {
        throw new Error(`opener.line must be a string`);
      }
      next.opener = { line: parsed };
      return next;
    case "sigil.border_set":
      if (!isSigilBorderSet(parsed)) {
        throw new Error(
          `sigil.border_set must be one of: thin, thick, double, ascii`,
        );
      }
      next.sigil = { ...(next.sigil ?? {}), border_set: parsed };
      return next;
    case "sigil.wordmark":
      if (!isSigilWordmark(parsed)) {
        throw new Error(
          `sigil.wordmark must be one of: ~alter, ~Alter, ALTER`,
        );
      }
      next.sigil = { ...(next.sigil ?? {}), wordmark: parsed };
      return next;
    case "sigil.accent_glyph":
      if (!isSigilAccentGlyph(parsed)) {
        throw new Error(
          `sigil.accent_glyph must be one of the catalog primitives (see 'alter sigil compose')`,
        );
      }
      next.sigil = { ...(next.sigil ?? {}), accent_glyph: parsed };
      return next;
    case "homepage.contact_email":
    case "homepage.contact_email_verified_at":
      // Managed field: the contact email is shown on your handle, so the
      // address must prove control (OTP ceremony) before it is set. A raw
      // `config set` would bypass that verification.
      throw new Error(
        `homepage.contact_email is verified before it's set - use the 'alter' menu: Account -> Contact email`,
      );
    default: {
      // Unknown key - preserve it via _passthrough so a newer CLI's
      // additions survive round-trips through an older CLI.
      const pass = { ...(next._passthrough ?? {}) };
      setDotted(pass, key, parsed);
      next._passthrough = pass;
      return next;
    }
  }
}

function parseScalar(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

function setDotted(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const parts = key.split(".");
  let node: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i]!;
    const existing = node[p];
    if (existing && typeof existing === "object") {
      node = existing as Record<string, unknown>;
    } else {
      const fresh: Record<string, unknown> = {};
      node[p] = fresh;
      node = fresh;
    }
  }
  node[parts[parts.length - 1]!] = value;
}

// Exported for unit tests without re-exposing every private helper at
// the module surface.
export const __testing = {
  resolveKey,
  applyScalarKey,
  parseScalar,
  readUserConfigOrDefault,
  writeUserConfig,
};
