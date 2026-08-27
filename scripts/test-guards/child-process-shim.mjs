/**
 * A drop-in child_process whose service-manager mutations refuse.
 *
 * Every `import ... from "node:child_process"` inside a test process resolves
 * here instead, via the loader hook in hooks.mjs. Everything the real module
 * exports is re-exported untouched; only the spawn family is wrapped, and only
 * a mutating verb against a service manager is refused.
 *
 * Why a loader hook and not a monkeypatch: assigning over
 * `childProcess.spawnSync` after import does NOT reach a module that did
 * `import { spawnSync } from "node:child_process"`. Node snapshots the named
 * export binding when the builtin's ESM facade is first instantiated, so the
 * patched property is never seen and the gate passes while catching nothing.
 * Verified empirically before this was written; a gate that renders as silence
 * is the failure this whole file exists to prevent.
 */
import * as real from "node:child_process";
import { offendingVerb, refusal } from "./policy.mjs";

/** Wrap an argv-style API (spawn, spawnSync, execFile, execFileSync). */
function guardArgv(original) {
  if (typeof original !== "function") return original;
  return function guarded(cmd, ...rest) {
    const args = Array.isArray(rest[0]) ? rest[0] : undefined;
    const verb = offendingVerb(cmd, args);
    if (verb) throw refusal(cmd, verb);
    return original.call(this, cmd, ...rest);
  };
}

/** Wrap a shell-string API (exec, execSync), which has no argv to inspect. */
function guardShell(original) {
  if (typeof original !== "function") return original;
  return function guarded(command, ...rest) {
    const line = String(command ?? "");
    const words = line.trim().split(/\s+/);
    const verb = offendingVerb(words[0], words);
    if (verb) throw refusal(words[0], verb);
    return original.call(this, command, ...rest);
  };
}

// Explicit local exports shadow the star re-export, so the guarded versions
// win for every importer while the rest of the module surface stays real.
export * from "node:child_process";

export const spawn = guardArgv(real.spawn);
export const spawnSync = guardArgv(real.spawnSync);
export const execFile = guardArgv(real.execFile);
export const execFileSync = guardArgv(real.execFileSync);
export const exec = guardShell(real.exec);
export const execSync = guardShell(real.execSync);

export default {
  ...real,
  spawn,
  spawnSync,
  execFile,
  execFileSync,
  exec,
  execSync,
};
