#!/usr/bin/env bash
# Retention helper for the local stores this tool writes.
#
# Applies size-based rotation to local logs that grow unbounded without their
# own prune mechanism. Called from cc-handover-capture.sh (Stop hook) so it runs
# at natural session-end cadence without adding a new hook event.
#
# Logs managed here (rolling, 5MB cap, keep 2 rotated):
#   ~/.local/share/alter/wire-trace.jsonl
#   ~/.local/share/alter/cc/*/events.log
#   ~/.local/share/alter/*.log (hook logs)
#
# This script is called with a best-effort contract: failure is silent and
# never blocks the hook that called it. It acts on filesystem state only, with
# no network call.
set -eo pipefail

SHARE_DIR="${ALTER_LOG_DIR:-$HOME/.local/share/alter}"

# Dry-run: when ALTER_PRUNE_DRYRUN is non-empty, every primitive below PRINTS
# the action it would take (prefixed "[dry-run]") and performs NO deletion or
# rotation. Lets an operator preview the exact prune/rotate list for the whole
# hook before anything is ever removed. Portable: only printf and find -print,
# no bashism.
DRYRUN="${ALTER_PRUNE_DRYRUN:-}"

# ---------------------------------------------------------------------------
# _rotate_if_over <file> <max_bytes> <copies>
#
# If <file> exceeds <max_bytes>, rotate: rename to .1, shift .1→.2 … .N→drop.
# Atomic: rename is a single syscall; readers that have the file open continue
# to write to the renamed inode, the next open picks up the fresh empty file.
# ---------------------------------------------------------------------------
_rotate_if_over() {
    local f="$1" max="$2" copies="${3:-2}"
    [ -f "$f" ] || return 0
    local sz
    # GNU stat (-c) on Linux + Git Bash; BSD stat (-f) on macOS; 0 if neither.
    sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || echo 0)
    [ "$sz" -le "$max" ] && return 0

    if [ -n "$DRYRUN" ]; then
        printf '[dry-run] rotate: %s (%s bytes > %s cap) -> .1, keep %s copies\n' \
            "$f" "$sz" "$max" "$copies"
        return 0
    fi

    # Shift existing rotated copies down: .2→drop, .1→.2
    local i="$copies"
    while [ "$i" -gt 1 ]; do
        local prev=$((i - 1))
        [ -f "${f}.${prev}" ] && mv "${f}.${prev}" "${f}.${i}" 2>/dev/null || true
        i=$prev
    done
    # Rename current to .1 and leave an empty file in its place.
    mv "$f" "${f}.1" 2>/dev/null || true
    : > "$f" 2>/dev/null || true
}


# ---------------------------------------------------------------------------
# Rolling log rotation
# ---------------------------------------------------------------------------
MAX=5242880  # 5MB

# Wire-trace JSONL (written by alter-cli bridge, kinds 15-18)
_rotate_if_over "${SHARE_DIR}/wire-trace.jsonl" "$MAX" 2

# Gate event logs (canon-edit, canon-write-gate, destructive-gate)
for evlog in "${SHARE_DIR}/cc"/*/events.log; do
    [ -f "$evlog" ] || continue
    _rotate_if_over "$evlog" "$MAX" 2
done

# Hook operational logs
for hlog in "${SHARE_DIR}"/*.log; do
    [ -f "$hlog" ] || continue
    _rotate_if_over "$hlog" "$MAX" 2
done


exit 0
