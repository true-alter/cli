#!/usr/bin/env bash
# _verify.sh: Hook manifest pin verifier.
#
# Threat model: a hook script is edited to read local credentials (e.g.
# ~/.config/alter/session.json) the next time a hook fires, and every prompt
# fires these hooks, so checking out someone else's branch and typing once is
# all it takes. As a defence, this verifier is sourced by each hook and fails
# closed if any script currently on disk has drifted from its pinned hash in the
# sibling `manifest.sha256`. It catches accidental drift and makes an unexpected
# change a loud signal rather than a silent read.
#
# IMPORTANT: this local check is ONE layer, not a standalone defence. A change
# that edits a hook can also edit the verifier call out of that hook, so a
# review gate on the hooks directory is the real adversarial control. This file
# exists so the gate is ALSO enforced at execution time for local runs.
set -euo pipefail

# Portable sha256 front-end, a DROP-IN for `sha256sum` including `--status -c`.
# `sha256sum` is GNU coreutils and absent on stock macOS, which ships `shasum`.
# This verifier fronts the WHOLE hook chain, and unguarded it did not merely stop
# working there: the bulk `-c` call failed for want of a binary and the failure was
# reported as "manifest drift detected", i.e. an operator on macOS was told his
# hooks had been TAMPERED WITH when the truth was that the checker could not run.
# A control that misreports its own unavailability as a positive detection is worse
# than one that is merely absent. Output and `-c` semantics are byte-identical
# between the two tools, so each verifies the other's manifest.
if command -v sha256sum >/dev/null 2>&1; then
    _v_sha256() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then
    _v_sha256() { shasum -a 256 "$@"; }
else
    _v_sha256() { echo "no sha256 tool (sha256sum or shasum) on PATH" >&2; return 127; }
fi

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
MANIFEST="$HOOKS_DIR/manifest.sha256"

# Fail closed helper. Prints a visible warning to stderr so that a broken
# hook doesn't silently masquerade as "everything fine". CC hooks swallow
# stderr in some configurations but `exit 2` still prevents the hook body
# from running.
_verify_fail() {
    _verify_outcome="fail"
    printf '~Alter hook verifier: %s\n' "$1" >&2
    printf '~Alter hook verifier: refusing to execute hook. If this is a\n' >&2
    printf '~Alter hook verifier: legitimate change, regenerate manifest:\n' >&2
    printf '~Alter hook verifier:   bash "%s" --regen\n' "${BASH_SOURCE[0]:-$0}" >&2
    # Emit a benign JSON response so CC keeps going (we refuse to execute
    # the hook body, we do NOT want to wedge the whole session).
    printf '{"continue":true}\n'
    exit 2
}

_verify_hash_one() {
    # $1 = expected hex, $2 = absolute path
    local expected="$1" path="$2"
    [ -f "$path" ] || { _verify_fail "missing pinned script: $path"; }
    local actual
    actual=$(_v_sha256 "$path" 2>/dev/null | awk '{print $1}') || {
        _verify_fail "could not hash $path"
    }
    [ "$actual" = "$expected" ] || {
        _verify_fail "hash mismatch on $(basename "$path"), expected $expected got $actual"
    }
}

# --- Regen mode -----------------------------------------------------------
# `bash _verify.sh --regen` rewrites manifest.sha256 from the current dir.
# Intended for a legitimate contributor who has modified a hook and wants
# the manifest updated. CI will still re-compute independently; this is a
# developer convenience, not a trust root.
#
#
# EXECUTE-BIT PINS. Content hashing says nothing about mode, and mode decides
# whether a hook runs at all: a registration guarded with `[ -x <path> ]` and
# then invoked through an interpreter is skipped entirely, in silence, when the
# bit is missing.
# So each pinned entry also gets a `#mode  <path> exec` or
# `#mode  <path> noexec` line.
#
# THE BIT, NEVER THE OCTAL. On-disk mode is umask-dependent (this tree reads
# 775 where git records 100755), so pinning the full octal would go red on any
# clone with a different umask, and a guard that fires on routine housekeeping
# is a guard that gets ignored. The execute BIT is what git tracks, what
# survives a clone, and precisely what `[ -x ]` tests, so it is the whole of
# what is worth pinning.
#
# `#`-prefixed lines are skipped by `sha256sum -c` and by the pinned-set reader
# below, so this rides inside the existing file rather than adding a sidecar
# that nothing would remember to check. The path sits in field 2, the same
# field the hash lines key on, so `LC_ALL=C sort -k2` puts each mode line
# directly beneath its own hash line and the canonical-sort check in CI still
# passes unchanged.
if [ "${1:-}" = "--regen" ]; then
    # A regen with no hasher would emit an EMPTY manifest and pin nothing, so
    # refuse rather than write one.
    if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
        printf '~Alter hook verifier: no sha256 tool (sha256sum or shasum) on PATH.\n' >&2
        printf '~Alter hook verifier: cannot regenerate the manifest; refusing.\n' >&2
        exit 2
    fi
    (
        cd "$HOOKS_DIR"
        # Pin every *.sh file in the hooks dir (excluding the manifest itself
        # and any nondeterministic state files).
        _v_sha256 *.sh
        for f in *.sh; do
            [ -f "$f" ] || continue
            if [ -x "$f" ]; then printf '#mode  %s exec\n' "$f"
            else printf '#mode  %s noexec\n' "$f"; fi
        done
    ) | LC_ALL=C sort -k2 > "$MANIFEST.tmp"
    mv "$MANIFEST.tmp" "$MANIFEST"
    printf 'manifest regenerated: %s\n' "$MANIFEST" >&2
    exit 0
fi

# --- Verify mode ----------------------------------------------------------
[ -f "$MANIFEST" ] || _verify_fail "manifest missing at $MANIFEST"

# No hasher at all: this is a SECURITY gate, so refuse rather than pass
# unverified. Checked HERE, before anything else, and not only at the bulk
# verify further down: the cache-key computation below is a pipeline under
# `set -o pipefail`, so with neither tool present it aborts the whole script
# with 127 before the later check is ever reached. That still fails closed
# (the wrapper runs no hook on a non-zero verifier) but it fails closed
# WITHOUT A WORD, which reads to an operator as "the hooks just do nothing".
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    _verify_fail "no sha256 tool (sha256sum or shasum) on PATH: cannot verify the hook manifest"
fi

# Per-process memoise. A single prompt cycle fires many hooks; each used to
# re-hash the whole hooks directory. Once a given hooks tree has been verified,
# subsequent hooks against THAT SAME TREE in the same session reuse the verdict
# for 5 minutes. Drift inside a live session is detectable on the next
# prompt-cycle after the TTL.
#
# THE VERDICT IS ABOUT A TREE, SO THE KEY NAMES THE TREE.
# This cache was keyed by session id alone, in a cache dir global to the whole
# machine. A verdict about tree A was therefore stored under a key that did not
# mention A, and any other tree the same session touched read it as its own.
# Anyone using git worktrees has many trees, so a session that verified a clean
# worktree and then touched a DRIFTED one got exit 0 and ran the drifted hooks,
# for five minutes, silently: the exact failure this file's own header says it
# exists to prevent.
if [ -d /dev/shm ]; then
    _verify_cache_dir="/dev/shm/cc-verify"
else
    _verify_cache_dir="/tmp/cc-verify"
fi
mkdir -p "$_verify_cache_dir" 2>/dev/null || _verify_cache_dir="/tmp/cc-verify"
mkdir -p "$_verify_cache_dir" 2>/dev/null || true
# Janitor: prune sentinels older than the TTL on every entry. Without this the
# dir accumulates one file per wrapper PPID forever (observed: 24,913 stale
# files wedged tmpfs inodes, causing intermittent mkdir failures and Stop-chain
# dropouts). One backgrounded find per call is cheap and self-limiting.
find "$_verify_cache_dir" -maxdepth 1 -type f -name '*.ok' -mmin +5 -delete 2>/dev/null &
# Key the sentinel on the CC session id when available, PPID rotates on every
# new wrapper subshell and rarely hits the cache. The harness exposes the
# session id as CLAUDE_CODE_SESSION_ID (the legacy CLAUDE_SESSION_ID name is no
# longer set, so reading only that silently defeated the cache, every hook paid
# the full ~40ms cold manifest re-hash instead of the ~5ms cached return).
# Prefer the real var, keep the legacy name + PPID as fallbacks so older
# harnesses and pre-session-id callers still work.
_verify_key="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-$PPID}}"

# Scope: every input the verdict actually depends on, so a hit can only ever
# be this tree's own verdict about this tree's own manifest.
#   HOOKS_DIR: the tree. Without it, any other checkout answers for this one.
#   manifest: the pin set. Regenerating the manifest must invalidate the
#             verdict immediately rather than serve a stale pass for the rest
#             of the TTL, which is exactly the window a `--regen` lands in.
# The TTL bounds staleness of the FILES; it is not, and never was, a
# substitute for naming the inputs in the key.
#
# Falls back to a path-only scope if the manifest cannot be hashed. Failing
# open to the OLD unscoped key would reinstate the cross-tree bug, so the
# degraded key stays tree-scoped and simply re-verifies more often.
_verify_scope=$(
    { sha256sum "$MANIFEST" 2>/dev/null || shasum -a 256 "$MANIFEST" 2>/dev/null; } |
        awk '{print $1}'
)
_verify_scope=$(
    printf '%s\n%s\n' "$HOOKS_DIR" "${_verify_scope:-nomanifest}" |
        { sha256sum 2>/dev/null || shasum -a 256 2>/dev/null; } | cut -c1-16
)
# No hasher at all (stock macOS lacks sha256sum; shasum covers it, but guard
# anyway): no sentinel, so every call re-verifies cold. Slower, never wrong.
if [ -n "${_verify_scope:-}" ]; then
    _verify_sentinel="$_verify_cache_dir/${_verify_key}-${_verify_scope}.ok"
else
    _verify_sentinel=""
fi

# --- Opt-in self-timing telemetry (off by default → near-zero cost) -------
# Set CC_HOOK_TIMING=1 to append one JSONL line per verifier invocation to
# CC_HOOK_TIMING_LOG (default <cache-dir>/timing.jsonl): wall-time in
# microseconds, cache outcome (hit/miss/fail), and which env var supplied the
# cache key. This is how a live session confirms the session-id cache fix
# landed: expect exactly one "miss" then a "hit" for every subsequent hook in
# the session; a string of "miss" lines means the key is still unstable. It
# also surfaces residual verifier stalls (e.g. tmpfs inode pressure slowing the
# bulk hash). Scope is the verifier's own cost only: it runs as a standalone
# subprocess ahead of each hook, so whole-hook-body timing would mean editing
# the settings.json wrapper or every hook body, deliberately out of scope to
# keep this change's blast radius to a single file. Uses the EPOCHREALTIME
# builtin (no fork); skipped silently on bash < 5. The radix char is stripped
# locale-safely via the [.,] bracket glob so microseconds parse on both '.' and
# ',' locales.
_verify_outcome="unknown"
if [ "${CC_HOOK_TIMING:-}" = "1" ] && [ -n "${EPOCHREALTIME:-}" ]; then
    _verify_t0="${EPOCHREALTIME/[.,]/}"
    _verify_timing_log="${CC_HOOK_TIMING_LOG:-$_verify_cache_dir/timing.jsonl}"
    if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then _verify_key_src="session"
    elif [ -n "${CLAUDE_SESSION_ID:-}" ]; then _verify_key_src="legacy"
    else _verify_key_src="ppid"; fi
    _verify_emit_timing() {
        local end="${EPOCHREALTIME/[.,]/}"
        printf '{"ts":%s,"us":%s,"key_src":"%s","outcome":"%s"}\n' \
            "$end" "$(( end - _verify_t0 ))" "$_verify_key_src" \
            "${_verify_outcome:-unknown}" >> "$_verify_timing_log" 2>/dev/null || true
    }
    trap _verify_emit_timing EXIT
fi

if [ -f "$_verify_sentinel" ]; then
    _verify_age=$(( $(date +%s) - $(stat -c %Y "$_verify_sentinel" 2>/dev/null || stat -f %m "$_verify_sentinel" 2>/dev/null || echo 0) ))
    if [ "$_verify_age" -lt 300 ]; then
        _verify_outcome="hit"
        return 0 2>/dev/null || exit 0
    fi
fi

# Bulk hash verify: single subprocess covers every pinned entry.
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    _verify_fail "no sha256 tool (sha256sum or shasum) on PATH: cannot verify the hook manifest"
fi
(cd "$HOOKS_DIR" && _v_sha256 --status -c "$MANIFEST") || _verify_fail "manifest drift detected"

# Execute-bit verify. A hook whose content is pinned but whose mode has drifted
# is skipped by its own `[ -x ]` registration guard while every hash check
# passes, so it sits dead behind a green manifest. See the regen block above for
# why the bit and not the octal.
#
# OPT-IN ON THE MANIFEST: a manifest carrying no `#mode` lines is an older one,
# or a hand-rolled partial manifest. Absence means "not pinned here", never
# "everything is fine", so it is skipped rather than failed, and no existing
# install gets wedged by a pin it never adopted.
#
# DOMAIN OF VALIDITY, stated rather than assumed. This check fails closed, and
# this file is sourced ahead of every registered hook, so one wrong verdict here
# takes the whole chain down. The bit is only meaningful on a filesystem that
# carries it: a Windows checkout, a FAT or NTFS mount, or an archive extracted
# without permissions reports every file the same way, and enforcing there would
# mismatch every pin at once and wedge every session on the machine. So the pass
# below first asks whether the bit means anything HERE. Pins say some files are
# executable and the filesystem reports not one of them as executable: that is
# a filesystem that does not track the bit, never a whole tree tampered with at
# once, and the check stands down. Any mixture proves the bit is live and real drift
# is enforced. Deliberately not a uname test, which would guess at the platform
# instead of observing the property actually depended on.
_verify_mode_pinned=0
_verify_mode_live=0
while read -r _verify_tag _verify_mpath _verify_mbit; do
    [ "${_verify_tag:-}" = "#mode" ] || continue
    [ "${_verify_mbit:-}" = "exec" ] || continue
    _verify_mode_pinned=$(( _verify_mode_pinned + 1 ))
    [ -x "$HOOKS_DIR/$_verify_mpath" ] && _verify_mode_live=$(( _verify_mode_live + 1 ))
done < "$MANIFEST"

if [ "$_verify_mode_pinned" -gt 0 ] && [ "$_verify_mode_live" -gt 0 ]; then
    while read -r _verify_tag _verify_mpath _verify_mbit; do
        [ "${_verify_tag:-}" = "#mode" ] || continue
        [ -n "${_verify_mpath:-}" ] || continue
        if [ -x "$HOOKS_DIR/$_verify_mpath" ]; then _verify_mnow="exec"; else _verify_mnow="noexec"; fi
        [ "$_verify_mnow" = "$_verify_mbit" ] || _verify_fail \
            "execute bit drift on $_verify_mpath: pinned $_verify_mbit, on disk $_verify_mnow"
    done < "$MANIFEST"
fi

# Reject any on-disk script that the manifest doesn't pin. Closes the
# "add a new malicious hook then reference it from settings.json" path.
#
# Portable set: `declare -A` is bash 4+ and macOS ships /bin/bash 3.2, so this
# used to hard-fail-to-parse there under `set -euo pipefail`, taking down every
# hook on the machine, since this file is sourced ahead of all of them. The
# pinned set is instead a
# newline-delimited string with a sentinel newline at both ends; membership
# is a fixed-string `case` match (`_verify_is_pinned`), which is exact (no
# regex metacharacter risk from a name) and needs nothing beyond bash 2.x
# builtins.
_verify_pinned=$'\n'
while read -r hash name; do
    [ -z "${hash:-}" ] && continue
    [ "${hash:0:1}" = "#" ] && continue
    _verify_pinned="${_verify_pinned}${name}
"
done < "$MANIFEST"

_verify_is_pinned() {
    case "$_verify_pinned" in
        *$'\n'"$1"$'\n'*) return 0 ;;
        *) return 1 ;;
    esac
}

while IFS= read -r -d '' f; do
    _verify_name="$(basename "$f")"
    if ! _verify_is_pinned "$_verify_name"; then
        _verify_fail "unpinned script present on disk: $_verify_name"
    fi
done < <(find "$HOOKS_DIR" -maxdepth 1 -type f -name '*.sh' -print0)


# Empty when no hasher was available to build a tree-scoped key. Writing an
# unscoped sentinel there is the bug this file just fixed, so write nothing
# and re-verify cold next call. An `if` rather than a `&&` list: this file
# runs under `set -e`, and a false `&&` list here would return 1 from the
# verifier, which every wrapper reads as "refuse to run the hook".
if [ -n "$_verify_sentinel" ]; then
    touch "$_verify_sentinel" 2>/dev/null || true
fi
_verify_outcome="miss"
return 0 2>/dev/null || exit 0
