#!/usr/bin/env bash
# _verify.sh - Skills/commands manifest pin verifier.
#
# Companion to the hooks-bundle verifier. Where the hooks verifier pins
# executable *.sh shims, this one pins the bundled Claude Code skill and
# slash-command markdown files (skills/<name>/SKILL.md, commands/<name>.md)
# so a tampered or extra file in the installed set is caught.
#
# Unlike the hooks bundle, skill/command files are NOT executed by the
# shell - Claude Code reads them as instructions. So this gate is a content
# integrity check (did an installed skill drift, or did an unpinned file
# appear), run by `alter skills install` at install time via --regen, and
# runnable any time as a drift check.
#
# Threat model: an installed skill body is edited after install (locally or
# by a malicious sync) to inject instructions the user never reviewed.
# `bash _verify.sh` from the asset root re-hashes every pinned .md against
# manifest.sha256 and fails closed on drift or on any unpinned .md present.
set -euo pipefail

ASSET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
MANIFEST="$ASSET_DIR/manifest.sha256"

# Portable SHA-256 selection (mirrors hooks/config.sh + hooks/_verify.sh).
# Stock macOS ships `shasum` but NOT GNU `sha256sum`; Linux ships `sha256sum`.
# This is a content-integrity gate, so it MUST fail CLOSED when NEITHER tool is
# present rather than silently regenerate or pass with no verification.
if command -v sha256sum >/dev/null 2>&1; then
    _SHA_KIND="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
    _SHA_KIND="shasum"
else
    _SHA_KIND=""
fi

# Single-file -> bare hex hash on stdout (empty + non-zero on failure).
_verify_hash_file() {
    case "$_SHA_KIND" in
        sha256sum) sha256sum "$1" 2>/dev/null | awk '{print $1}' ;;
        shasum)    shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' ;;
        *)         return 1 ;;
    esac
}

# Manifest check (`-c --status`); returns non-zero on any drift.
_verify_check_manifest() {
    case "$_SHA_KIND" in
        sha256sum) sha256sum --status -c "$1" ;;
        shasum)    shasum -a 256 --status -c "$1" ;;
        *)         return 1 ;;
    esac
}

_verify_fail() {
    printf '~Alter skills verifier: %s\n' "$1" >&2
    printf '~Alter skills verifier: refusing - content integrity check failed.\n' >&2
    printf '~Alter skills verifier: if this is a legitimate change, regenerate:\n' >&2
    printf '~Alter skills verifier:   bash _verify.sh --regen\n' >&2
    exit 2
}

# Hard fail-closed when no SHA tool exists: the gate cannot run, so refuse.
_verify_no_tool() {
    printf '~Alter skills verifier: no SHA-256 tool found (need sha256sum or shasum).\n' >&2
    printf '~Alter skills verifier: cannot verify content integrity; failing CLOSED.\n' >&2
    printf '~Alter skills verifier: install coreutils (sha256sum) or ensure shasum is on PATH.\n' >&2
    exit 2
}

# --- Regen mode -----------------------------------------------------------
# `bash _verify.sh --regen` rewrites manifest.sha256 from the current tree.
# Pins every bundled .md file (skills + commands) by path relative to the
# asset dir, sorted for determinism.
if [ "${1:-}" = "--regen" ]; then
    [ -n "$_SHA_KIND" ] || _verify_no_tool
    (
        cd "$ASSET_DIR"
        find . -type f -name '*.md' | LC_ALL=C sort | while read -r f; do
            # Normalise the leading ./ so the manifest paths are stable.
            rel="${f#./}"
            printf '%s  %s\n' "$(_verify_hash_file "$rel")" "$rel"
        done
    ) > "$MANIFEST.tmp"
    mv "$MANIFEST.tmp" "$MANIFEST"
    printf 'skills manifest regenerated: %s\n' "$MANIFEST" >&2
    exit 0
fi

# --- Verify mode ----------------------------------------------------------
# Fail CLOSED if no hash tool is available: an integrity gate that cannot run
# must refuse, never silently pass.
[ -n "$_SHA_KIND" ] || _verify_no_tool
[ -f "$MANIFEST" ] || _verify_fail "manifest missing at $MANIFEST"

# 1. Every pinned file must match its hash.
(cd "$ASSET_DIR" && _verify_check_manifest "$MANIFEST") || _verify_fail "skills manifest drift detected"

# 2. Reject any on-disk .md the manifest doesn't pin (closes the
#    "drop an unreviewed skill into the set" path).
#
# Portability: stock macOS /bin/bash is 3.2 with no `declare -A` (bash 4+).
# This is a content-integrity gate that must not silently fail on macOS, so
# the pinned-set membership test compares the manifest's second column (the
# relative path) with awk's literal string compare instead of an associative
# array.
while IFS= read -r f; do
    rel="${f#./}"
    if [ "$(awk -v n="$rel" '$2==n{print "1"; exit}' "$MANIFEST" 2>/dev/null)" != "1" ]; then
        _verify_fail "unpinned file present in skills set: $rel"
    fi
done < <(cd "$ASSET_DIR" && find . -type f -name '*.md')

exit 0
