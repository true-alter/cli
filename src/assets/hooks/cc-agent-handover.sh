#!/usr/bin/env bash
# cc-agent-handover.sh - PreCompact hook: emit agent_handover frame.
#
# Retires the copy-paste handover pattern by snapshotting the
# about-to-be-compressed context slice to disk and emitting an `agent_handover`
# frame to the caller's own ~handle (self-fan-out). A successor CC session can
# read the frame inline at startup.
#
# Local drop: alongside the wire frame, the hook drops a local agent_handover
# frame into ~/.local/share/alter/agent-handovers/ addressed at its own session
# id. The UserPromptSubmit receiver (cc-agent-handover-poll.sh) claims it on the
# session's next prompt - a wire-independent recovery path for the compaction
# case.
#
# Triggered by: PreCompact (CC harness fires before context compaction).
# Receives:     pre-compact context slice on stdin (CC convention - same shape
#               as other lifecycle hooks: a JSON object carrying session_id
#               and a transcript/text field).
# Returns:      {"continue":true} immediately so compaction is not stalled.
#               Frame emission runs asynchronously (background subshell).
#
# Design notes:
#
#   - Anti-double-fire: composite key host_pseudonym + session_id + unix_minute.
#     Multiple sibling worktrees observing the same session_id at the same
#     minute land on one lock; the loser exits silently. No canonical
#     reconciler - physics of atomic mkdir, which works on every POSIX
#     filesystem and on Windows Git Bash. The host pseudonym is hook-local and
#     never leaves the machine.
#
#   - The hook reads the pre-compact slice (filesystem / stdin) and writes a
#     frame; it does NOT consult any cached narrative for truth. Every
#     diagnostic emission notes where its data came from.
#
#   - Worktree-aware: the composite key includes the worktree path so two
#     sessions on different worktrees but the same session_id each emit
#     independently.
#
#   - CLI-only emission: `alter agent handover` is the ONLY wire path - it owns
#     session read + bearer attach internally, so no token ever enters this
#     shell. If the CLI is missing or fails, the local drop + snapshot still
#     preserve the handover for same-machine recovery; the wire frame is
#     skipped. Failure NEVER blocks compaction - the hook is best-effort.
#
#   - Timing: the snapshot is written synchronously (small, fast); the CLI
#     shell-out runs in a `( ... ) &` background subshell with `disown`. The
#     hook returns {"continue":true} within milliseconds.
#
# Dry-run mode: set ALTER_AGENT_DRYRUN=1 to print the CLI invocation instead
# of executing it. Snapshot is still written so the body can be inspected.

set -euo pipefail

# ---------------------------------------------------------------------------
# Best-effort contract: never block compaction. Every failure path emits
# {"continue":true} via log_skip and exits 0.
# ---------------------------------------------------------------------------
LOG_DIR="${ALTER_LOG_DIR:-$HOME/.local/share/alter}"
LOG_FILE="$LOG_DIR/cc-agent-handover.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

log_skip() {
    local reason="$1"
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '{"ts":"%s","event":"skip","reason":"%s","session":"%s"}\n' \
        "$ts" "$reason" "${SESSION_ID:-}" >>"$LOG_FILE" 2>/dev/null || true
    echo '{"continue":true}'
    exit 0
}

log_event() {
    local event="$1"; local detail="$2"
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '{"ts":"%s","event":"%s","session":"%s","detail":"%s"}\n' \
        "$ts" "$event" "${SESSION_ID:-}" "$detail" >>"$LOG_FILE" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Diagnostic annotations. Every one of these is defined here with a plain
# default so no later line can reference an undefined name; the block below
# overrides them with the richer provenance-tagged forms.
# ---------------------------------------------------------------------------
_PV_MKDIR=""
_PV_STAT=""
_PV_WRITE=""
_PV_CLI=""
_PV_WHICH=""
_PV_DRYRUN=""
_PV_SNAP_LINE='- source: PreCompact stdin slice + git log of the worktree HEAD'
_PV_BODY_LINE='source: PreCompact stdin'

command -v jq &>/dev/null || log_skip "no_jq"

# ---------------------------------------------------------------------------
# Portable helpers.
#
# Both of these replaced `command -v <gnu-binary> || log_skip` guards on flock
# and sha256sum. Both binaries are GNU: flock is absent on stock macOS and on
# Windows Git Bash, sha256sum is absent on stock macOS. So on two of the three
# platforms this hook exited having done nothing, on every invocation, while
# printing {"continue":true} and logging a skip nobody read. A probe whose
# degrade path is "do nothing at all" is not portability; it is a silent no-op
# wearing a guard's clothes, and a failure is legible where a silent skip is
# indistinguishable from a clean run.
# ---------------------------------------------------------------------------

# Mtime in unix seconds. `stat -c` is GNU, `stat -f` is BSD/macOS; chain both
# and fall back to 0 (which reads as "ancient", so a caller treats the lock as
# stale and breaks it rather than wedging on an unreadable stat).
_mtime_secs() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

# Digest, stdin to hex on stdout. `sha256sum` is GNU coreutils: present on
# Linux and on Windows Git Bash, ABSENT on stock macOS, which ships `shasum`.
_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 | awk '{print $1}'
    else
        printf ''
    fi
}
[ -n "$(printf 'x' | _sha256)" ] || log_skip "no_sha256"

# ---------------------------------------------------------------------------
# Read PreCompact stdin. CC harness convention for lifecycle hooks: JSON with
# at least .session_id, plus an event-specific transcript payload. Field naming
# for PreCompact varies across CC versions - probe several keys defensively.
# Fall back to env vars where the harness exposes session_id outside stdin.
# ---------------------------------------------------------------------------
INPUT=$(cat 2>/dev/null || printf '{}')

# Session id resolution: stdin -> env var -> harness state file fallback.
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || printf '')
if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
    SESSION_ID="${CLAUDE_SESSION_ID:-}"
fi
if [ -z "$SESSION_ID" ]; then
    log_skip "no_session_id"
fi
# Normalise to alnum/dash/underscore (defence against accidental path injection).
SESSION_ID=$(printf '%s' "$SESSION_ID" | tr -cd 'a-zA-Z0-9_-')
[ -n "$SESSION_ID" ] || log_skip "session_id_normalise_empty"

# Pre-compact slice: probe several plausible field names. CC harness has
# shipped the about-to-be-compressed text under .transcript / .messages /
# .pre_compact_text / .text at various points. Concatenate whichever exists.
SLICE=$(printf '%s' "$INPUT" | jq -r '
    if .transcript? then (.transcript | if type=="array" then map(.text // tostring) | join("\n") else tostring end)
    elif .messages? then (.messages | if type=="array" then map(.content // .text // tostring) | join("\n") else tostring end)
    elif .pre_compact_text? then .pre_compact_text
    elif .text? then .text
    else "" end' 2>/dev/null || printf '')

# If stdin carried nothing usable, still emit a pointer-only handover - the
# successor session can read the snapshot file (which will be near-empty) plus
# branch + worktree + git log. Better than no signal at all.
if [ -z "$SLICE" ]; then
    SLICE="(no pre-compact transcript received via stdin; snapshot is metadata only)"
fi

# ---------------------------------------------------------------------------
# Anti-double-fire guard. composite_key = host_pseudonym:session:minute:worktree
# Multiple worktrees on the same machine each get their own lock (worktree in
# the key); same worktree firing twice in the same minute coalesces to one.
# host_pseudonym = sha256(machine_id + minute-rotated salt) truncated, never
# persisted.
# ---------------------------------------------------------------------------
MACHINE_ID=""
[ -r /etc/machine-id ] && MACHINE_ID=$(cat /etc/machine-id 2>/dev/null || true)
[ -z "$MACHINE_ID" ] && MACHINE_ID=$(hostname 2>/dev/null || printf 'unknown')

UNIX_MINUTE=$(( $(date +%s) / 60 ))
SALT_SUFFIX="agent-handover-${UNIX_MINUTE}"
HOST_PSEUDONYM=$(printf '%s\n%s\n' "$MACHINE_ID" "$SALT_SUFFIX" \
    | _sha256 | cut -c1-16)

WORKTREE_PATH=$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")
WORKTREE_HASH=$(printf '%s' "$WORKTREE_PATH" | _sha256 | cut -c1-8)

COMPOSITE_KEY="${HOST_PSEUDONYM}-${SESSION_ID:0:12}-${UNIX_MINUTE}-${WORKTREE_HASH}"
LOCK_DIR="${TMPDIR:-/tmp}/cc-agent-handover.lock.${COMPOSITE_KEY}"
STAMP_FILE="${TMPDIR:-/tmp}/cc-agent-handover.stamp.${COMPOSITE_KEY}"

# ---------------------------------------------------------------------------
# Dedup lock. `mkdir` is atomic on every POSIX filesystem AND on Windows Git
# Bash; GNU `flock` is neither, and this hook previously skipped outright when
# flock was missing, so on two of the three platforms it had never run at all
# while every wrapper still exited 0 and said nothing.
#
# Semantics are unchanged from the flock version. Exactly one caller creates
# the directory and proceeds; every racing sibling on the same composite key
# fails the mkdir and exits silently, with NO canonical reconciler. The EXIT
# trap releases it, mirroring flock's release-on-close. A caller killed before
# the trap runs leaves the directory behind, so a lock older than the key's own
# minute window is broken rather than allowed to wedge the channel: the
# composite key already carries the unix minute, so nothing outside that window
# can legitimately still hold it.
# ---------------------------------------------------------------------------
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    _lock_age=$(( $(date +%s) - $(_mtime_secs "$LOCK_DIR") ))
    if [ "$_lock_age" -lt 120 ]; then
        # Another sibling-session is racing the same composite key. Exit silently.
        log_event "deduped_lock" "composite_key=${COMPOSITE_KEY}${_PV_MKDIR}"
        echo '{"continue":true}'
        exit 0
    fi
    # Older than the dedup window, so its owner is gone. Break it, then
    # re-acquire; losing that race is itself a legitimate dedup, so treat a
    # second failure as the loser path.
    log_event "lock_broken_stale" "composite_key=$COMPOSITE_KEY age=${_lock_age}s"
    rmdir "$LOCK_DIR" 2>/dev/null || true
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        log_event "deduped_lock" "composite_key=${COMPOSITE_KEY}${_PV_MKDIR}"
        echo '{"continue":true}'
        exit 0
    fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
# Stamp file persists past the lock so a SECOND invocation in the same minute
# (e.g. two PreCompact events within 60s on the same session+worktree) also
# coalesces. Stamp files are tmpfs-style ephemeral - auto-cleaned at reboot,
# fine for a minute-scoped dedup window.
if [ -f "$STAMP_FILE" ]; then
    log_event "deduped_stamp" "composite_key=${COMPOSITE_KEY}${_PV_STAT}"
    echo '{"continue":true}'
    exit 0
fi
: > "$STAMP_FILE" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Snapshot the pre-compact slice synchronously. ~/.cache/alter/pre-compact-
# snapshots/ is created lazily. Pointer-shape filename so subscribers can grep
# by session_id.
# ---------------------------------------------------------------------------
SNAPSHOT_DIR="$HOME/.cache/alter/pre-compact-snapshots"
mkdir -p "$SNAPSHOT_DIR" 2>/dev/null || log_skip "snapshot_dir_unwritable"

UNIX_TS=$(date +%s)
SNAPSHOT_PATH="${SNAPSHOT_DIR}/${SESSION_ID}-${UNIX_TS}.md"

ISO_NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BRANCH=$(git -C "$WORKTREE_PATH" branch --show-current 2>/dev/null || printf 'unknown')
GIT_LOG_TAIL=$(git -C "$WORKTREE_PATH" log -n 5 --pretty=format:'%h %s' 2>/dev/null || printf '')

# Write the snapshot. Idempotent (atomic move via tempfile).
TMP_SNAPSHOT=$(mktemp "${SNAPSHOT_PATH}.XXXXXX" 2>/dev/null) || log_skip "snapshot_tmp_failed"
{
    printf '# PreCompact snapshot - session %s\n' "$SESSION_ID"
    printf '\n'
    # `--` separator: bash builtin printf parses a leading `-` in the format
    # string as an option (e.g. `- captured_at` -> invalid option `- `). Use
    # `--` to terminate option parsing for any format starting with a dash.
    printf -- '- captured_at: %s\n' "$ISO_NOW"
    printf -- '- worktree: %s\n' "$WORKTREE_PATH"
    printf -- '- branch: %s\n' "$BRANCH"
    printf -- '%s\n' "$_PV_SNAP_LINE"
    printf '\n## Last 5 commits\n\n'
    printf '%s\n' "$GIT_LOG_TAIL"
    printf '\n## Pre-compact transcript slice\n\n'
    printf '%s\n' "$SLICE"
} > "$TMP_SNAPSHOT" 2>/dev/null

if ! mv "$TMP_SNAPSHOT" "$SNAPSHOT_PATH" 2>/dev/null; then
    rm -f "$TMP_SNAPSHOT" 2>/dev/null
    log_skip "snapshot_promote_failed"
fi
chmod 600 "$SNAPSHOT_PATH" 2>/dev/null || true

# Retention discipline: keep the newest 10 snapshots.
# Pre-compact snapshots are intermediate context; once the compacted session
# resumes and picks up the frame, the snapshot is redundant. Keep 10 as
# recovery headroom.
{
    ls -t "$SNAPSHOT_DIR"/*.md 2>/dev/null | tail -n +11 | xargs -r rm -f 2>/dev/null
} || true

# ---------------------------------------------------------------------------
# Build a concise handover body. Target ≤2000 chars. Prefer a local Ollama
# summary if present (CLI binary `ollama` + a tagged model); fall back to
# `head -50` of the snapshot when Ollama isn't reachable.
# ---------------------------------------------------------------------------
SUMMARY=""
# The local drop below runs AFTER this block, so anything unbounded here is not
# paid for in summary quality: it is paid for with the whole handover. This hook
# is registered with a short timeout and a kill at that timeout loses the drop
# frame entirely, at the one moment PreCompact exists to preserve it.
# `timeout` is GNU-only and absent on stock macOS, so without it the summarising
# is unbounded and the kill is the only thing that ends it. Skip Ollama in that
# case and take the head fallback, which costs a worse summary and saves the
# handover. A summarising attempt is worth strictly less than the drop it delays.
if command -v ollama >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 \
   && [ "${ALTER_AGENT_SKIP_OLLAMA:-0}" != "1" ]; then
    SUMMARY=$(timeout "${ALTER_AGENT_SUMMARISE_BUDGET:-2}" \
        ollama run "${ALTER_AGENT_SUMMARISE_MODEL:-qwen2.5:14b-instruct}" \
        "Summarise this pre-compact transcript slice in <=1500 chars, preserve session intent + open loops + next-step pointers:" \
        <"$SNAPSHOT_PATH" 2>/dev/null || printf '')
fi
if [ -z "$SUMMARY" ]; then
    # Fallback: first 50 lines of the snapshot transcript section.
    SUMMARY=$(head -n 50 "$SNAPSHOT_PATH" 2>/dev/null || printf '')
fi

# Trim body to a safe ceiling (≤2000 chars target).
BODY_HEADER=$(printf 'PreCompact-emitted handover. Source session about to compress.\n\n%s\nbranch: %s\nworktree: %s\nsnapshot: %s\nsession_id: %s\n\n--- summary ---\n' \
    "$_PV_BODY_LINE" "$BRANCH" "$WORKTREE_PATH" "$SNAPSHOT_PATH" "$SESSION_ID")
BODY=$(printf '%s\n%s\n' "$BODY_HEADER" "$SUMMARY")
# POSIX-safe ceiling at ~2000 chars; cut works on bytes here which is fine for
# the diagnostic body (oversized handovers degrade gracefully via the snapshot
# pointer the receiver can read directly).
BODY=$(printf '%s' "$BODY" | cut -c1-2000)

# ---------------------------------------------------------------------------
# Local drop. Also write the handover as an agent_handover frame into the
# shared drop dir so the UserPromptSubmit receiver
# (cc-agent-handover-poll.sh) picks it up without the wire. target = self: a
# compacted session recovers its own pre-compact slice on the next prompt.
# Synchronous but tiny (one small file); best-effort, never blocks compaction.
# ---------------------------------------------------------------------------
HANDOVER_DROP_DIR="${ALTER_AGENT_HANDOVER_DIR:-$HOME/.local/share/alter/agent-handovers}"
if mkdir -p "$HANDOVER_DROP_DIR" 2>/dev/null; then
    FRAME_HASH=$(printf '%s' "$BODY" | _sha256 | cut -c1-8)
    # Content-hash dedup - same body already dropped (live or consumed) -> skip.
    if ! ls "$HANDOVER_DROP_DIR"/*-"${FRAME_HASH}".json \
            "$HANDOVER_DROP_DIR"/*-"${FRAME_HASH}".json.consumed \
            >/dev/null 2>&1; then
        FRAME_FILE="$HANDOVER_DROP_DIR/$(date +%s)-${SESSION_ID:0:8}-${FRAME_HASH}.json"
        FRAME_JSON=$(jq -nc \
            --arg kind "agent_handover" \
            --arg from "$SESSION_ID" \
            --arg body "$BODY" \
            --arg created "$ISO_NOW" \
            --arg source "cc-agent-handover" \
            '{kind:$kind, from_session:$from, target_session_id:$from,
              body_md:$body, created_at:$created, source:$source}' 2>/dev/null) \
            || FRAME_JSON=""
        if [ -n "$FRAME_JSON" ]; then
            TMP_FRAME=$(mktemp "${FRAME_FILE}.XXXXXX" 2>/dev/null) \
                && printf '%s\n' "$FRAME_JSON" >"$TMP_FRAME" 2>/dev/null \
                && mv "$TMP_FRAME" "$FRAME_FILE" 2>/dev/null \
                && log_event "local_drop" "frame=$(basename "$FRAME_FILE")${_PV_WRITE}" \
                || { rm -f "$TMP_FRAME" 2>/dev/null || true; \
                     log_event "local_drop_failed" "hash=$FRAME_HASH"; }
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Async emission. Background subshell + disown so PreCompact returns instantly.
# `alter agent handover` is the only wire path - the CLI owns session + bearer
# internally; no session file read, no curl.
# ---------------------------------------------------------------------------

# Dry-run: print the CLI invocation we WOULD run, write nothing to the wire.
if [ "${ALTER_AGENT_DRYRUN:-0}" = "1" ]; then
    {
        printf '[cc-agent-handover] DRY-RUN%s\n' "$_PV_DRYRUN"
        printf '  snapshot: %s\n' "$SNAPSHOT_PATH"
        printf '  branch:   %s\n' "$BRANCH"
        printf '  worktree: %s\n' "$WORKTREE_PATH"
        printf '  session:  %s\n' "$SESSION_ID"
        printf '  cli:      alter agent handover --previous-session-id %q --body <%d chars> --pointer snapshot:%s --pointer branch:%s --pointer worktree:%s\n' \
            "$SESSION_ID" "${#BODY}" "$SNAPSHOT_PATH" "$BRANCH" "$WORKTREE_PATH"
        printf '  body_preview:\n'
        printf '%s\n' "$BODY" | head -n 6 | sed 's/^/    /'
    } >&2
    log_event "dryrun" "snapshot=$SNAPSHOT_PATH composite_key=$COMPOSITE_KEY"
    echo '{"continue":true}'
    exit 0
fi

# Real emission - async so we don't stall PreCompact.
(
    if command -v alter >/dev/null 2>&1; then
        CLI_OUT=$(alter agent handover \
            --previous-session-id "$SESSION_ID" \
            --body "$BODY" \
            --pointer "snapshot:$SNAPSHOT_PATH" \
            --pointer "branch:$BRANCH" \
            --pointer "worktree:$WORKTREE_PATH" 2>&1) || CLI_OUT="cli_failed:$CLI_OUT"
        case "$CLI_OUT" in
            handover\ sent*)
                FRAME_ID=$(printf '%s' "$CLI_OUT" | sed -n 's/.*frame=\([A-Za-z0-9_-]*\).*/\1/p')
                printf '[cc-agent-handover] frame=%s -> self%s\n' \
                    "${FRAME_ID:-unknown}" "$_PV_CLI" >&2
                log_event "cli_ok" "frame=${FRAME_ID:-unknown} composite_key=$COMPOSITE_KEY"
                ;;
            *)
                # No wire fallback: the local drop + snapshot above already
                # preserve the handover for same-machine recovery.
                printf '[cc-agent-handover] CLI failed - wire frame skipped, local drop holds: %s%s\n' \
                    "$CLI_OUT" "$_PV_CLI" >&2
                log_event "cli_failed_local_drop_only" "composite_key=$COMPOSITE_KEY"
                ;;
        esac
    else
        printf '[cc-agent-handover] alter CLI not on PATH - wire frame skipped, local drop holds%s\n' "$_PV_WHICH" >&2
        log_event "cli_missing_local_drop_only" "composite_key=$COMPOSITE_KEY"
    fi
) &
disown 2>/dev/null || true

echo '{"continue":true}'
exit 0
