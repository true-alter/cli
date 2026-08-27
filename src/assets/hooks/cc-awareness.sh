#!/usr/bin/env bash
# cc-awareness.sh: Gives this session automatic awareness of all other active CC sessions.
# Triggered by:
#   UserPromptSubmit: inject full sitrep of all other sessions before processing each prompt
#   PreToolUse (Edit|Write), warn about specific file/directory overlap before editing
set -euo pipefail

command -v jq &>/dev/null || exit 0

# Load shared config (dynamic paths, /dev/shm)
source "$(dirname "$0")/config.sh"

INPUT=$(cat)

# Perf: parse the stdin payload ONCE via a single jq call instead of forking
# one jq process per field. hook_event_name/session_id/tool_name/
# tool_input.file_path were previously up to 4 separate jq calls (tool_name
# and file_path forked much later, only on PreToolUse); they're cheap to
# pull out here alongside the rest since unused vars cost nothing on other
# event branches. Fields are unit-separator (0x1f) delimited; the separator
# is passed via --arg so no literal control byte/escape sits in the jq
# program text.
_CC_SEP_FIELD=$'\x1f'
_RAW_INPUT_FIELDS=$(echo "$INPUT" | jq -r --arg fs "$_CC_SEP_FIELD" '
    [(.hook_event_name // ""), (.session_id // ""), (.tool_name // ""), (.tool_input.file_path // "")]
    | join($fs)
' 2>/dev/null)
IFS="$_CC_SEP_FIELD" read -r EVENT SESSION_ID TOOL_NAME FILE_PATH <<< "$_RAW_INPUT_FIELDS"

# Self-identification: session_id is stable for the entire CC run; $PPID is
# the ephemeral hook-wrapper shell and is NOT a reliable session identifier.
SESSION_ID=$(echo "$SESSION_ID" | tr -cd 'a-zA-Z0-9_-')

# Session-claim heartbeat refresh (cross-session coordination).
# cc-awareness.sh refreshes the claim on every UserPromptSubmit and
# PreToolUse, gated by the TTL-third cadence helper. cc-broadcast.sh covers
# UserPromptSubmit + PostToolUse(Edit|Write); this call extends the cadence
# to the remaining PreToolUse branches so heavy tool-driven sessions still
# heartbeat at 30s. Silent on every failure, and it never blocks the
# awareness path.
if [ -n "$SESSION_ID" ] && [ -d "$CC_STATUS_DIR" ]; then
    _claim_status_file="$CC_STATUS_DIR/$SESSION_ID.json"
    if _cc_session_claim_should_refresh "$_claim_status_file"; then
        _cc_emit_session_claim "$SESSION_ID" "$_claim_status_file" || true
    fi
    unset _claim_status_file
fi

[ -d "$CC_STATUS_DIR" ] || { echo '{"continue":true}'; exit 0; }

NOW=$(date +%s)
LOCK_FILE="$CC_STATUS_DIR/.lock"

# ── Collect all live sibling sessions (with flock for safe reads) ─────────
# "Live" = last_activity within CC_IDLE_TIMEOUT. We no longer use `kill -0`
# because hook PIDs were never long-lived CC PIDs in the first place.
# Legacy numeric-keyed files (pre-session_id refactor) are purged on sight.
collect_siblings() {
    local siblings="[]"
    exec 200>"$LOCK_FILE"
    # flock is GNU-only and absent on stock macOS. Guard it: when unavailable,
    # degrade to an unlocked read (best-effort sibling-awareness read, not a
    # correctness-critical write path) rather than hard-failing the whole hook.
    local _have_flock=0
    command -v flock >/dev/null 2>&1 && _have_flock=1
    if [ "$_have_flock" -eq 1 ]; then
        flock -s -w 2 200 || { echo "[]"; return; }
    fi

    for f in "$CC_STATUS_DIR"/*.json; do
        [ ! -f "$f" ] && continue

        local other_id
        other_id=$(basename "$f" .json)

        # Purge legacy PID-keyed files from before the session_id refactor.
        if [[ "$other_id" =~ ^[0-9]+$ ]]; then
            rm -f "$f"
            continue
        fi

        # Validate JSON before parsing.
        jq empty < "$f" 2>/dev/null || { rm -f "$f"; continue; }

        # Skip self.
        [ -n "$SESSION_ID" ] && [ "$other_id" = "$SESSION_ID" ] && continue

        local other_ts
        other_ts=$(jq -r '.last_activity // 0' "$f" 2>/dev/null)
        local age=$(( NOW - other_ts ))

        # Ignore sessions idle beyond configured timeout.
        [ "$age" -gt "$CC_IDLE_TIMEOUT" ] && continue

        siblings=$(echo "$siblings" | jq --arg sid "$other_id" --arg age "$age" \
            --slurpfile s "$f" \
            '. + [($s[0] + {age: ($age | tonumber)})]')
    done

    if [ "$_have_flock" -eq 1 ]; then
        flock -u 200
    fi
    exec 200>&-
    echo "$siblings"
}

SIBLINGS=$(collect_siblings)

# ── Merge cross-host CC presence from the alter-runtime daemon cache ──────
# alter-runtime's SessionPresenceWriter polls /queries/presence and writes
# this file on a ~30s cadence. If the daemon isn't running, the file is
# absent and we surface only same-host /dev/shm siblings (Phase A behaviour).
# Same-host rows always win on session_id collision because they carry the
# richer working_on / files_touched fields the bash hook tracks locally.
collect_remote_siblings() {
    local cache="${ORG_ALTER_STATE_DIR:-$HOME/.local/share/org-alter}/state/sessions.json"
    [ -f "$cache" ] || { echo "[]"; return; }

    local mtime
    mtime=$(stat -c %Y "$cache" 2>/dev/null || stat -f %m "$cache" 2>/dev/null || echo 0)
    [ $(( NOW - mtime )) -gt "$CC_IDLE_TIMEOUT" ] && { echo "[]"; return; }

    local known_ids
    known_ids=$(echo "$SIBLINGS" | jq -r '[.[].session_id // empty]' 2>/dev/null) || known_ids="[]"

    # jq's fromdateiso8601 only parses the ``%Y-%m-%dT%H:%M:%SZ`` shape (UTC
    # with literal Z). The Worker is supposed to emit exactly that on
    # session_presence rows, but other producers writing to this same cache
    # have leaked microsecond + ``+00:00`` shapes before, so we normalise
    # defensively. ``epoch`` strips fractional seconds and rewrites a
    # trailing ``+00:00`` to ``Z`` before parsing; rows that still fail
    # parse return 0 and get age-gated out by the filter below.
    jq --arg sid "$SESSION_ID" --arg now "$NOW" --arg timeout "$CC_IDLE_TIMEOUT" \
       --argjson known "$known_ids" '
       def epoch: (. // "") | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601? // 0;
       (.presence // [])
       | map(select(
           .tool == "cc"
           and (.state != "stop")
           and (.session_id != $sid)
           and (.session_id as $s | ($known | index($s)) == null)
       ))
       | map(
           (.last_seen | epoch) as $seen
           | select($seen > 0)
           | (($now | tonumber) - $seen) as $age
           | select($age <= ($timeout | tonumber))
           | {
               session_id: .session_id,
               age: ($age | floor),
               working_on: ("(remote " + (.actor // "?") + ")"),
               files_touched: [],
               last_file: "",
               _remote: true
           }
       )
       ' "$cache" 2>/dev/null || echo "[]"
}

# ── Collect JSONL siblings from alter-runtime active-sessions stream ──────────
# Reads the tool-neutral JSONL written by cc-broadcast.sh + alter-runtime daemon.
# Deduplicates on (tool, session_id) keeping newest last_activity. Filters to:
#   - branch field present (any tool that emits a branch joins
#     same-branch overlap detection: was previously hardcoded `tool == "cc"`)
#   - status != "complete"
#   - age within CC_IDLE_TIMEOUT
#   - session_id not already in $SIBLINGS (shm rows win on collision)
# Preserves branch + started_at fields for the same-branch overlap gate.
collect_local_jsonl_siblings() {
    local jsonl="${ACTIVE_SESSIONS_JSONL:-$HOME/.local/share/alter-runtime/active-sessions.jsonl}"
    [ -f "$jsonl" ] || { echo "[]"; return; }

    local known_ids
    known_ids=$(echo "$SIBLINGS" | jq -r '[.[].session_id // empty]' 2>/dev/null) || known_ids="[]"

    jq -Rs \
        --arg sid "$SESSION_ID" \
        --arg now "$NOW" \
        --arg timeout "$CC_IDLE_TIMEOUT" \
        --argjson known "$known_ids" '
        # Normalise mixed timestamp shapes (alter-runtime writes both
        # microsecond `+00:00` and second `Z` forms to this JSONL stream).
        def epoch: (. // "") | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601? // 0;
        # Parse JSONL: split on newlines, drop empties, parse each line.
        split("\n")
        | map(select(length > 0) | try fromjson catch null)
        | map(select(. != null))
        # Any emitter with a `branch` field participates in
        # same-branch overlap detection (Cursor / Codex / alter-cli /
        # future tools). Was previously gated on `tool == "cc"`; that
        # filter is lifted so other tools join without further hook
        # changes once they start emitting the branch field.
        | map(select(.branch != null))
        # Exclude self and already-known shm rows.
        | map(select(
            .session_id != $sid
            and (.session_id as $s | ($known | index($s)) == null)
        ))
        # Exclude tombstones.
        | map(select(.status != "complete"))
        # Dedup on session_id: keep highest version (newest row).
        | group_by(.session_id)
        | map(sort_by(.version // 0) | last)
        # Age-gate.
        | map(
            (.last_activity | epoch) as $la
            | select($la > 0)
            | (($now | tonumber) - $la) as $age
            | select($age <= ($timeout | tonumber))
            | {
                session_id: .session_id,
                age: ($age | floor),
                working_on: (.working_on // ""),
                files_touched: (.files_touched // []),
                branch: .branch,
                started_at: .started_at,
                last_activity: .last_activity,
                _jsonl: true
            }
        )
        ' "$jsonl" 2>/dev/null || echo "[]"
}

REMOTE_SIBLINGS=$(collect_remote_siblings)
JSONL_SIBLINGS=$(collect_local_jsonl_siblings)

# Advisory text appended to the UserPromptSubmit sitrep. Empty unless the
# block below populates it.
CONE_INTERSECTIONS=""


SIBLINGS=$(jq -s 'add' <(echo "$SIBLINGS") <(echo "$REMOTE_SIBLINGS") <(echo "$JSONL_SIBLINGS") 2>/dev/null) || SIBLINGS="$SIBLINGS"
COUNT=$(echo "$SIBLINGS" | jq 'length')

# ── Cross-host substrate health hint ───────────────────────────────────────
# Any login should yield coordination by default.
# The cross-host path requires the alter-runtime
# daemon to be writing the presence cache. Surface a one-time hint per 6h
# when the user is logged in (session.json with handle) but the cache
# never appeared: this turns the silent gap into a visible breadcrumb
# without adding curl/MCP latency to every prompt.
build_daemon_hint() {
    local _sess_json
    # Handle is read via _cc_session_info_cached, the TTL cache in front of
    # resolve_alter_session_json (enc-store-first; session.json is the
    # last-resort fallback, never the primary read).
    _sess_json=$(_cc_session_info_cached "${SESSION_ID:-}" 2>/dev/null || true)
    local handle
    handle=$(printf '%s' "$_sess_json" | jq -r '.handle // ""' 2>/dev/null || true)
    [ -z "$handle" ] || [ "$handle" = "null" ] && return 0

    local cache="${ORG_ALTER_STATE_DIR:-$HOME/.local/share/org-alter}/state/sessions.json"
    [ -f "$cache" ] && return 0

    local sentinel="$HOME/.cache/alter/cc-awareness-daemon-hint"
    local sentinel_age=999999
    if [ -f "$sentinel" ]; then
        local stamp
        stamp=$(stat -c %Y "$sentinel" 2>/dev/null || stat -f %m "$sentinel" 2>/dev/null || echo 0)
        sentinel_age=$(( NOW - stamp ))
    fi
    [ "$sentinel_age" -le 21600 ] && return 0

    mkdir -p "$(dirname "$sentinel")" 2>/dev/null || true
    touch "$sentinel" 2>/dev/null || true

    printf '\nNOTE: cross-host CC awareness is OFF for %s: alter-runtime daemon is not running, so siblings on other machines are invisible. Same-host /dev/shm path still active. To close the gap (one-time): alter-runtime init && alter-runtime start' "$handle" # portlint: allow linux-only-path - human-readable message text, not a filesystem path reference
}
DAEMON_HINT=$(build_daemon_hint)

# ── UserPromptSubmit: full sitrep ──────────────────────────────────────────
if [ "$EVENT" = "UserPromptSubmit" ]; then
    # Compact pointer line that can stand in for the full inline advisory
    # text, and the flag that says whether it did. Both default to the
    # full-text path; the block below can raise them.
    SHARED_REF=""
    ADVISORY_CUT_ACTIVE=0

    SUMMARY=""
    WT_INVENTORY=""
    if [ "$ADVISORY_CUT_ACTIVE" -eq 0 ]; then
        if [ "$COUNT" -gt 0 ]; then
            # files_touched can run to dozens of absolute paths per sibling; that
            # bloats every prompt's context for no gain. Strip directories, keep
            # up to 5 basenames, and append "(+N more)" when truncated.
            SUMMARY=$(echo "$SIBLINGS" | jq -r '.[] |
                "- session \(.session_id[0:8] // "?") (\(.age)s ago): \(.working_on // "no task description")" +
                ((.files_touched // []) as $ft
                 | if ($ft | length) > 0 then
                     " | files: " +
                     (($ft | map(split("/") | last)) as $names
                      | if ($names | length) <= 5
                        then ($names | join(", "))
                        else (($names[0:5] | join(", ")) + " (+" + (($names | length) - 5 | tostring) + " more)")
                        end)
                   else "" end)
            ')
        fi

        # ── Worktree inventory: substrate-observe all git worktrees ──────────
        # Enumerates every worktree so the session sees branches in play, dirty
        # state, and avoids duplicating work a sibling worktree already covers.
        # Rendered and cached in config.sh (_cc_worktree_inventory_cached, TTL 45s)
        # so the O(worktrees) `git status` scan is not re-run on every prompt; a
        # newly-added worktree still surfaces within the TTL. Output byte-identical
        # to the prior inline producer.
        WT_INVENTORY=$(_cc_worktree_inventory_cached "$SESSION_ID")
    fi

    FULL_MSG=""
    if [ -n "$SUMMARY" ]; then
        FULL_MSG="ACTIVE SIBLING SESSIONS ($COUNT other CC session(s) on this project):\n$SUMMARY\nIf your current task depends on or overlaps with another session's work, coordinate, tell the user and consider waiting for the other session to finish first."
    fi
    if [ -n "$WT_INVENTORY" ]; then
        [ -n "$FULL_MSG" ] && FULL_MSG="${FULL_MSG}\n\n"
        FULL_MSG="${FULL_MSG}${WT_INVENTORY}"
    fi
    if [ -n "$DAEMON_HINT" ]; then
        FULL_MSG="${FULL_MSG}${DAEMON_HINT}"
    fi


    [ -z "$FULL_MSG" ] && { echo '{"continue":true}'; exit 0; }


    MSG=$(printf '%s' "$FULL_MSG" | jq -Rs '.')
    echo "{\"continue\":true,\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":$MSG}}"
    exit 0
fi

# ── PreToolUse (Edit|Write): file-specific conflict warning ────────────────
# TOOL_NAME / FILE_PATH were already parsed once, up top, alongside EVENT/SESSION_ID.
case "$TOOL_NAME" in Edit|Write) ;; *) echo '{"continue":true}'; exit 0 ;; esac

[ "$COUNT" -eq 0 ] && { echo '{"continue":true}'; exit 0; }

[ -z "$FILE_PATH" ] && { echo '{"continue":true}'; exit 0; }

REL="${FILE_PATH#$PWD/}"
TARGET_DIR=$(dirname "$REL")
WARNINGS=""

# First sibling that produces a FILE_HIT, captured for auto-worktree gate below.
OVERLAP_SIBLING_STARTED_AT=""
OVERLAP_SIBLING_BRANCH=""

# Perf: the producing jq call extracts ALL per-row fields (session_id, age,
# working_on, started_at, branch, files_touched) in ONE pass and emits them
# delimited: row-separator (0x1d) between siblings, field-separator (0x1f)
# between fields, list-separator (0x1e) joining the files_touched array.
# The loop body below then forks NO jq process per row (previously 4 jq
# forks per sibling). Separators are passed via --arg, never as literal
# control bytes/escapes in the jq program text.
_CC_SEP_ROW=$'\x1d'
_CC_SEP_LIST=$'\x1e'
# Every numeric field needs an explicit tostring before the `+` concatenation:
# jq throws on number + string, `// ""` never rescues it (a number is truthy, so
# the default never fires), and stderr is discarded below, so the only symptom is
# the whole hook dying rc=5 under `set -e` on any Edit/Write with a sibling live.
# `.age` and `.started_at` are both numbers; keep any field added here the same way.
_SIBLING_ROWS=$(echo "$SIBLINGS" | jq -j \
    --arg fs "$_CC_SEP_FIELD" --arg ls "$_CC_SEP_LIST" --arg rs "$_CC_SEP_ROW" '
    .[] |
    ((.session_id // "?")) + $fs +
    ((.age | tostring)) + $fs +
    ((.working_on // "")) + $fs +
    ((.started_at // 0 | tostring)) + $fs +
    ((.branch // "")) + $fs +
    ((.files_touched // []) | join($ls)) + $rs
' 2>/dev/null)

while IFS= read -r -d "$_CC_SEP_ROW" row; do
    [ -z "$row" ] && continue
    IFS="$_CC_SEP_FIELD" read -r local_sid local_age local_task local_started_at local_branch _local_files_joined <<< "$row"
    local_sid_short="${local_sid:0:8}"
    local_files="${_local_files_joined//$_CC_SEP_LIST/$'\n'}"

    TASK_INFO=""
    [ -n "$local_task" ] && TASK_INFO=" Task: '${local_task:0:120}'"

    # Conflict-freshness gate. files_touched carries no per-file timestamp, so
    # the only freshness proxy is the sibling's own last_activity age. A sibling
    # alive within CC_IDLE_TIMEOUT but quiet beyond CC_CONFLICT_FRESH (touched
    # the file minutes ago, no activity since, or now heartbeating on other work)
    # is NOT a live conflict: the file-association is stale. Skip the conflict
    # assertion for such a sibling, killing the false-positive "conflicting
    # sibling session" warning while preserving the true positive (a sibling
    # genuinely active on the file within the fresh window). Non-numeric or
    # missing age defaults to stale (skip), failing safe toward fewer false
    # positives. The auto-worktree gate below is reached only via a fresh hit,
    # so a stale association no longer triggers it either.
    case "${local_age}" in
        ''|*[!0-9]*) continue ;;
    esac
    [ "$local_age" -gt "$CC_CONFLICT_FRESH" ] && continue

    # Exact file match
    FILE_HIT=""
    while IFS= read -r of; do
        [ "$of" = "$REL" ] && FILE_HIT=1
    done <<< "$local_files"

    if [ -n "$FILE_HIT" ]; then
        WARNINGS="${WARNINGS}\n- session $local_sid_short edited THIS SAME FILE ($REL) ${local_age}s ago.${TASK_INFO}"
        # Capture first-mover data for auto-worktree gate (first overlap wins).
        if [ -z "$OVERLAP_SIBLING_STARTED_AT" ]; then
            OVERLAP_SIBLING_STARTED_AT="$local_started_at"
            OVERLAP_SIBLING_BRANCH="$local_branch"
        fi
        continue
    fi

    # Same-directory match
    while IFS= read -r of; do
        if [ "$(dirname "$of")" = "$TARGET_DIR" ]; then
            WARNINGS="${WARNINGS}\n- session $local_sid_short is working in the same directory ($TARGET_DIR) ${local_age}s ago.${TASK_INFO}"
            break
        fi
    done <<< "$local_files"
done < <(printf '%s' "$_SIBLING_ROWS")

# ── Auto-worktree on same-branch overlap ─────────────────────────────────────
# Six-condition gate (all must pass):
#   1. FILE_HIT: same file overlap detected in the loop above
#   2. opt-out env unset
#   3. second-mover: this session started after the overlapping sibling
#   4. same branch: current branch matches sibling's branch field
#   5. uncommitted changes exist: something to protect
#   6. not already worktreed this session (idempotency sentinel)
if [ -n "$OVERLAP_SIBLING_STARTED_AT" ] && [ -z "${ALTER_NO_AUTO_WORKTREE:-}" ]; then
    CURRENT_BRANCH=$(git -C "$PWD" branch --show-current 2>/dev/null || echo "")
    OWN_STARTED_AT=$(jq -r '.started_at_iso // ""' "${CC_STATUS_DIR}/${SESSION_ID}.json" 2>/dev/null || echo "")
    WT_SENTINEL="$HOME/.cache/alter/worktrees/${SESSION_ID:0:16}/.worktreed"

    # Condition 3: second-mover (own start > sibling start).
    #
    # Normalise both sides to epoch seconds via `date -d`. An earlier
    # implementation lexicographically compared ISO strings, which
    # is correct for two UTC `Z` timestamps but loses ordering across
    # timezone offsets: e.g. `2026-05-15T23:00:00+00:00` (same moment as
    # `2026-05-16T08:00:00+10:00`) string-compares LESS than the second
    # despite being identical. `date -d <iso> +%s` collapses TZ to a
    # single integer so the > test is unambiguous.
    IS_SECOND_MOVER=0
    if [ -n "$OWN_STARTED_AT" ] && [ -n "$OVERLAP_SIBLING_STARTED_AT" ]; then
        # started_at_iso is always written as %Y-%m-%dT%H:%M:%SZ (see
        # session-summary.sh); the BSD -j -f fallback parses that exact
        # format so this stays portable on stock macOS, which lacks
        # GNU `date -d`.
        OWN_EPOCH=$(date -d "$OWN_STARTED_AT" +%s 2>/dev/null \
            || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$OWN_STARTED_AT" +%s 2>/dev/null \
            || echo "")
        SIB_EPOCH=$(date -d "$OVERLAP_SIBLING_STARTED_AT" +%s 2>/dev/null \
            || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$OVERLAP_SIBLING_STARTED_AT" +%s 2>/dev/null \
            || echo "")
        if [ -n "$OWN_EPOCH" ] && [ -n "$SIB_EPOCH" ] \
            && [ "$OWN_EPOCH" -gt "$SIB_EPOCH" ]; then
            IS_SECOND_MOVER=1
        fi
    fi

    # Condition 4: branch match (both non-empty and equal)
    BRANCH_MATCH=0
    if [ -n "$CURRENT_BRANCH" ] && [ -n "$OVERLAP_SIBLING_BRANCH" ] \
        && [ "$CURRENT_BRANCH" = "$OVERLAP_SIBLING_BRANCH" ]; then
        BRANCH_MATCH=1
    fi

    # Condition 5: uncommitted changes
    DIRTY=0
    if [ "$(git -C "$PWD" status --porcelain 2>/dev/null | wc -l)" -gt 0 ]; then
        DIRTY=1
    fi

    # Condition 6: sentinel absent
    NOT_WORKTREED=0
    [ ! -f "$WT_SENTINEL" ] && NOT_WORKTREED=1

    if [ "$IS_SECOND_MOVER" -eq 1 ] && [ "$BRANCH_MATCH" -eq 1 ] \
        && [ "$DIRTY" -eq 1 ] && [ "$NOT_WORKTREED" -eq 1 ]; then
        WT_DIR="$HOME/.cache/alter/worktrees/${SESSION_ID:0:16}"
        mkdir -p "$(dirname "$WT_DIR")"
        git -C "$PWD" worktree add --detach "$WT_DIR" HEAD 2>/dev/null || true
        touch "$WT_SENTINEL"
        WT_MSG="AUTO-WORKTREE: same-branch file overlap detected. A worktree for this session has been created at ${WT_DIR}. Run: cd ${WT_DIR}, then continue your work there to avoid clobbering the first-mover session's uncommitted edits."
        WT_MSG=$(printf '%s' "$WT_MSG" | jq -Rs '.')
        echo "{\"continue\":true,\"systemMessage\":$WT_MSG}"
        exit 0
    fi
fi

# Optional extra advisory text, appended to the base file-conflict warning
# below. Empty unless the block that follows populates it.
EXTRA_ADVISORIES=""

if [ -n "$WARNINGS" ] || [ -n "$EXTRA_ADVISORIES" ]; then
    FULL_WARNING=""
    if [ -n "$WARNINGS" ]; then
        FULL_WARNING="FILE CONFLICT WARNING before editing $REL:$(echo -e "$WARNINGS")\nTell the user about this overlap. If the other session is doing prerequisite work, suggest waiting."
    fi
    if [ -n "$EXTRA_ADVISORIES" ]; then
        if [ -n "$FULL_WARNING" ]; then
            FULL_WARNING="${FULL_WARNING}\n\n${EXTRA_ADVISORIES}"
        else
            FULL_WARNING="$EXTRA_ADVISORIES"
        fi
    fi
    MSG=$(printf '%s' "$FULL_WARNING" | jq -Rs '.')
    echo "{\"continue\":true,\"systemMessage\":$MSG}"
else
    echo '{"continue":true}'
fi
