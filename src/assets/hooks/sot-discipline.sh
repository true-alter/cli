#!/usr/bin/env bash
# sot-discipline.sh - verification-source logging.
#
# Records where an answer came from: the codebase via grep/Read, git (log /
# diff / show), the network, or a stored note.
#
# The rule it makes visible: a stored note is a durable RULE, never the source
# of truth for state that CHANGES over time. Volatile state is observed live;
# a cached summary is one observation among many that needs cross-checking.
#
# This hook does NOT block. It classifies each tool call by that source and
# appends a line to a local log so the pattern can be reviewed. It prints one
# note per session the first time an answer comes from a stored note with no
# check against a live source in the same session.
#
# Modes:
#   log      - PostToolUse, matcher "*": classify one tool call, append to log
#   summary  - Stop: append a per-session tally line, rotate the log
#
# Always exits 0. A broken hook must never break a session.

set -uo pipefail

# flock is GNU/Linux-only and absent on stock macOS; mkdir is atomic on every
# POSIX filesystem and is the portable substitute (same idiom as
# belt-refresh.sh / cc-label-summarise.sh). Unlike flock's fd, a mkdir lock
# does not self-release when the holder crashes, so a lock dir older than
# STALE_S is presumed abandoned and broken rather than wedging every future
# log append forever. $1 = lock dir, $2 = max wait seconds (matches the
# previous `flock -w N` semantics).
_sd_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
_sd_lock_acquire() {
    local dir="$1" wait_s="${2:-1}" waited=0 stale_s=5
    while ! mkdir "$dir" 2>/dev/null; do
        # mkdir can fail for reasons other than the dir existing (ENOENT on a
        # missing parent, EACCES, EROFS, ENOSPC). Those are unrecoverable here,
        # and the stale-break below cannot see them: an absent dir reads mtime
        # 0, so it always looks stale and rmdir always fails. Bail rather than
        # spin.
        [ -d "$dir" ] || return 1
        if [ $(( $(date +%s) - $(_sd_mtime "$dir") )) -gt "$stale_s" ]; then
            rmdir "$dir" 2>/dev/null || true
        fi
        [ "$waited" -ge "$wait_s" ] && return 1
        sleep 1
        waited=$(( waited + 1 ))
    done
    return 0
}
_sd_lock_release() { rmdir "$1" 2>/dev/null || true; }

MODE="${1:-log}"
LOG_DIR="$HOME/.local/share/alter"
LOG="$LOG_DIR/sot-discipline.log"
mkdir -p "$LOG_DIR" 2>/dev/null

INPUT="$(cat 2>/dev/null)"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TAB=$'\t'

# jq missing → degrade silently, never break the session
if ! command -v jq >/dev/null 2>&1; then
  echo '{"continue":true}'; exit 0
fi

SID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null | cut -c1-8)"
[ -z "$SID" ] && SID="unknown"
# Full session_id, kept as a trailing column so a later reader can attribute a
# summary line to its session. Sanitised to a safe charset before it is logged.
FULL_SID="$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null | tr -cd 'a-zA-Z0-9_-')"
[ -z "$FULL_SID" ] && FULL_SID="unknown"

# ---------------------------------------------------------------- summary mode
if [ "$MODE" = "summary" ]; then
  if [ -f "$LOG" ]; then
    mem=$(grep -cF "${TAB}${SID}${TAB}MEMORY-CACHE${TAB}"   "$LOG" 2>/dev/null); mem=${mem:-0}
    alt=$(grep -cF "${TAB}${SID}${TAB}ALTER-SoT${TAB}"      "$LOG" 2>/dev/null); alt=${alt:-0}
    sub=$(grep -cF "${TAB}${SID}${TAB}LIVE-SUBSTRATE${TAB}" "$LOG" 2>/dev/null); sub=${sub:-0}
    # Optional trailing counter fields, appended verbatim to the summary line.
    # Declared EMPTY here so the printf below always has the name defined; the
    # block that fills it is removable as a whole unit.
    extra=""
    verdict="ok"
    [ "$mem" -gt 0 ] && [ "$alt" -eq 0 ] && [ "$sub" -eq 0 ] && verdict="REVIEW-memory-without-verification"
    # Trailing col: full session_id, so a summary line can be keyed to a session.
    printf '%s\t%s\tSESSION-SUMMARY\tmemory=%s\talter-sot=%s\tlive-substrate=%s%s\t%s\t%s\n' \
      "$TS" "$SID" "$mem" "$alt" "$sub" "$extra" "$verdict" "$FULL_SID" >> "$LOG"
    # rotate: keep the log bounded
    lines=$(wc -l < "$LOG" 2>/dev/null); lines=${lines:-0}
    if [ "$lines" -gt 6000 ]; then
      tail -n 4000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null
    fi
  fi
  echo '{"continue":true}'; exit 0
fi

# -------------------------------------------------------------------- log mode
TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)"
CLASS=""
TARGET=""

case "$TOOL" in
  Read)
    fp="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)"
    case "$fp" in
      */.claude/memory/*|*/memory/MEMORY.md|*/projects/*/memory/*)
        CLASS="MEMORY-CACHE"; TARGET="$fp" ;;
    esac
    ;;
  mcp__*__read_memory)
    CLASS="MEMORY-CACHE"
    TARGET="$(printf '%s' "$INPUT" | jq -r '.tool_input.memory_file_name // "mcp-memory"' 2>/dev/null)"
    ;;
  mcp__*__alter_*)
    # Identity-field query - matches the available scopes; the rule does not
    # privilege one scope over another.
    CLASS="ALTER-SoT"; TARGET="$TOOL" ;;
  WebFetch)
    CLASS="LIVE-SUBSTRATE"
    TARGET="$(printf '%s' "$INPUT" | jq -r '.tool_input.url // ""' 2>/dev/null)"
    ;;
  Bash)
    cmd="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)"
    case "$cmd" in
      *"git log"*|*"git rev-parse"*|*"git status"*|*"git diff"*|*"git show"*|*"git branch"*|*"git fetch"*)
        CLASS="LIVE-SUBSTRATE"; TARGET="git" ;;
    esac
    ;;
esac

# not SoT-relevant → log nothing, pass through
if [ -z "$CLASS" ]; then
  echo '{"continue":true}'; exit 0
fi

TARGET="$(printf '%s' "$TARGET" | tr -d '\n\t' | cut -c1-200)"
# Serialise the append. Parallel-tool-call workloads (CC dispatches 2+ Bash
# tools in one turn) used to tear lines and break the summary grep. mkdir is
# the portable lock (see _sd_lock_acquire above); a failed acquire skips this
# one append, the same best-effort contract flock had.
if _sd_lock_acquire "$LOG.lock.d" 1; then
  # session_id appended as trailing col 6 so a line can be keyed to its session.
  # Existing readers grep on cols 1-5 and are unaffected by the new column.
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$TS" "$SID" "$CLASS" "$TOOL" "$TARGET" "$FULL_SID" >> "$LOG"
  _sd_lock_release "$LOG.lock.d"
fi

# say so once per session, the first time an answer comes from a stored note
if [ "$CLASS" = "MEMORY-CACHE" ]; then
  marker="/tmp/sot-discipline-warned-$SID"
  if [ ! -f "$marker" ]; then
    : > "$marker" 2>/dev/null
    # Generic default. The block below overrides it in full; the name is always
    # defined either way, and the jq call reads it via --arg so no quoting in
    # the message text can break the JSON.
    NOTE="[sot-discipline] That answer came from a stored note. For state that changes over time, check a live source too: the codebase (grep / Read), git (log / diff / show), or the network. Logged to ~/.local/share/alter/sot-discipline.log."
    jq -cn --arg m "$NOTE" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
    exit 0
  fi
fi

echo '{"continue":true}'
exit 0
