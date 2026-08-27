#!/usr/bin/env bash
# cc-broadcast.sh : Broadcasts what this session is working on.
# Triggered by: PostToolUse (Edit|Write|NotebookEdit|Read|Bash) and
# UserPromptSubmit
# Writes a status file to /dev/shm/cc-sessions/<project-hash>/<pid>.json
# Other sessions read these files to detect overlap.
#
# .state : "working" whenever this hook writes (a prompt arrived, or a tool
# just ran: either way the session has the turn). A Stop-event hook flips it to
# "waiting" when the turn is handed back. Readers (the status line's
# gallery of panes) use it to tell a pane that is thinking from one that is
# sitting on an answer nobody has read yet.
#
# Privacy note: on each prompt this records the first ~200 characters of your
# prompt locally as the session's "working on" label (in the status file above
# and the local session-activity log). It stays on your machine; nothing is
# sent anywhere by this hook.
set -euo pipefail

command -v jq &>/dev/null || exit 0

# Load shared config (dynamic paths, cleanup, /dev/shm)
source "$(dirname "$0")/config.sh"

INPUT=$(cat)

# Single parse of $INPUT for every top-level field this hook might need,
# regardless of which event fires : one jq fork instead of five. Fields
# irrelevant to the current $EVENT just come back empty and are unused.
# NUL-delimited so an embedded newline/tab in a user prompt can't shift
# later fields; each read defaults its var to "" on short/failed read.
EVENT="" SESSION_ID="" PROMPT="" TOOL_NAME="" FILE_PATH="" COMMAND=""
# jq on empty/all-whitespace input parses zero JSON values : the filter
# never runs, so it exits 0 with ZERO bytes of output (verified). Each of
# the original five per-field `jq` calls tolerated that silently (an empty
# $(...) capture is not a failure). A NUL-delimited read of that same zero-
# byte stream would misread it as a parse failure (EOF before the first
# delimiter), so skip the fork entirely for that case and leave the ""
# defaults above -- exactly what those five calls would have produced.
if [[ "$INPUT" != *[![:space:]]* ]]; then
    :
else
    {
        IFS= read -r -d '' EVENT
        IFS= read -r -d '' SESSION_ID
        IFS= read -r -d '' PROMPT
        IFS= read -r -d '' TOOL_NAME
        IFS= read -r -d '' FILE_PATH
        IFS= read -r -d '' COMMAND
    } < <(jq -j '(.hook_event_name // "") + "\u0000" + (.session_id // "") + "\u0000" + (.user_prompt // .tool_input.prompt // "") + "\u0000" + (.tool_name // "") + "\u0000" + (.tool_input.file_path // "") + "\u0000" + (.tool_input.command // "") + "\u0000"' <<<"$INPUT" 2>/dev/null)
fi

# Key state files by CC's stable session_id, NOT $PPID. Hooks fire from
# `bash -c '...'` shells whose $PPID is the ephemeral wrapper, not the
# long-lived CC process : so PID-keyed files were dead seconds after write.
# session_id is per-CC-session, stable for the entire run, and unique across
# concurrent sessions on the same host.
SESSION_ID=$(echo "$SESSION_ID" | tr -cd 'a-zA-Z0-9_-')
[ -z "$SESSION_ID" ] && { echo '{"continue":true}'; exit 0; }

CC_PID=$PPID
mkdir -p "$CC_STATUS_DIR"
NOW=$(date +%s)
ISO_NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
STATUS_FILE="$CC_STATUS_DIR/$SESSION_ID.json"
LOCK_FILE="$CC_STATUS_DIR/.lock"

# Portable lock (GNU `flock` is absent on stock macOS). Every use in this file
# guards a real read-modify-write of shared state (this hook re-invoked
# concurrently for rapid tool calls, or the alter-runtime daemon's own
# fcntl.flock on $ACTIVE_SESSIONS_JSONL), so a silently-dropped lock would let
# two writers race and corrupt STATUS_FILE / the JSONL log. Where flock is
# present, behaviour is byte-for-byte unchanged. Where absent, this degrades
# to a directory-based lock (mkdir is an atomic test-and-set on every POSIX
# filesystem) polled once a second up to the same wait budget, which is a
# coarser but equally CORRECT mutual exclusion, never a no-op. SELF-HEALING:
# real flock releases itself when the holding process dies; this mkdir
# emulation must too, or a killed holder (SIGKILL/OOM/harness-timeout/
# terminal-close) wedges every later caller behind a lockdir nothing will
# ever rmdir. Two independent safeguards: (a) an EXIT/INT/TERM trap releases
# every lockdir this process still holds (belt); (b) a lockdir older than
# the wait ceiling is presumed abandoned and stolen outright (braces, the
# only thing that saves a SIGKILL, which runs no trap at all).
_HAVE_FLOCK=0
command -v flock >/dev/null 2>&1 && _HAVE_FLOCK=1
_LOCKDIRS_HELD=""
_lock_cleanup_trap() {
    local d
    for d in $_LOCKDIRS_HELD; do
        rmdir "$d" 2>/dev/null || true
    done
}
_lock_wait() {   # _lock_wait FD WAIT_SECS LOCKKEY
    local fd="$1" wait="$2" key="$3"
    if [ "$_HAVE_FLOCK" = "1" ]; then
        flock -w "$wait" "$fd"
        return $?
    fi
    local lockdir="${key}.lockdir" polls=0 stale_ceiling age
    stale_ceiling=$(( wait > 30 ? wait : 30 ))
    while ! mkdir "$lockdir" 2>/dev/null; do
        age=$(stat -c %Y "$lockdir" 2>/dev/null || stat -f %m "$lockdir" 2>/dev/null || echo "")
        if [ -n "$age" ]; then
            age=$(( $(date +%s) - age ))
            if [ "$age" -ge "$stale_ceiling" ]; then
                rmdir "$lockdir" 2>/dev/null || true
                continue
            fi
        fi
        [ "$polls" -ge "$wait" ] && return 1
        sleep 1
        polls=$(( polls + 1 ))
    done
    _LOCKDIRS_HELD="$_LOCKDIRS_HELD $lockdir"
    trap '_lock_cleanup_trap' EXIT INT TERM
    return 0
}
_lock_release() {   # _lock_release FD LOCKKEY
    local fd="$1" key="$2"
    if [ "$_HAVE_FLOCK" = "1" ]; then
        flock -u "$fd" 2>/dev/null || true
        return 0
    fi
    local lockdir="${key}.lockdir"
    rmdir "$lockdir" 2>/dev/null || true
    _LOCKDIRS_HELD="${_LOCKDIRS_HELD/ $lockdir/}"
}

# Cross-host presence emitter. The default is a no-op, so every call site is
# safe when no presence helper is installed alongside this hook.
emit_presence() { :; }

# Atomic write with flock
atomic_write() {
    local content="$1"
    exec 200>"$LOCK_FILE"
    _lock_wait 200 2 "$LOCK_FILE" || { echo '{"continue":true}'; exit 0; }
    echo "$content" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
    _lock_release 200 "$LOCK_FILE"
    exec 200>&-
}

# ── Tool-neutral JSONL dual-write ──────────────────────────────────────────
# Emits one envelope (session_started | session_heartbeat | session_ended)
# to $ACTIVE_SESSIONS_JSONL using flock against the file FD itself so the
# alter-runtime daemon's fcntl.flock(LOCK_EX) on the same path serialises
# cross-process. This is a local session-activity log other tools can read.
#
# Skip conditions (silent + one log line, never blocks CC):
#   - no handle in ~/.config/alter/session.json
#   - flock timeout (2s)
#   - jq build failure
#
# Reads (when present):
#   - $STATUS_FILE.json  → started_at_iso, working_on, files_touched
#   - ~/.config/alter/session.json → handle, consent_tier
#
# consent_tier defaults to 2 when absent/invalid: don't skip the emit, default
# to L2, and the caller can opt up via session.json.
emit_jsonl() {
    local kind="$1"  # session_started | session_heartbeat | session_ended

    # Handle + consent_tier via shared resolver helper (enc store → human line
    # → legacy session.json fallback : never blocks hook execution).
    local _bcst_sess
    _bcst_sess=$(resolve_alter_session_json 2>/dev/null || true)
    # handle + tier in one jq fork (was two): NUL-delimited so either
    # field can never shift the other.
    local handle="" _tier_label=""
    {
        IFS= read -r -d '' handle || true
        IFS= read -r -d '' _tier_label || true
    } < <(printf '%s' "$_bcst_sess" | jq -j '(.handle // "") + "\u0000" + (.tier // "") + "\u0000"' 2>/dev/null || true)
    if [ -z "$handle" ] || [ "$handle" = "null" ]; then
        _log_emit_skip "$kind" "no_handle"
        return 0
    fi
    # The resolver normalises handles to bare (no leading ~) for its shared
    # internal contract, but the active-sessions JSONL schema requires the
    # canonical ~-prefixed form (pattern ^~[a-z0-9_-]+$). Re-prefix exactly
    # one ~ so emitted envelopes validate. POSIX-portable expansion.
    handle="~${handle#\~}"

    # consent_tier: derive int from tier label emitted by the resolver.
    local consent_tier
    case "$_tier_label" in
        L1) consent_tier=1 ;;
        L2) consent_tier=2 ;;
        L3) consent_tier=3 ;;
        L4) consent_tier=4 ;;
        *)  consent_tier=2 ;;
    esac

    # Resolve started_at : first invocation caches ISO in status file; later
    # invocations read it back. session_started inserts the value mid-flock
    # below if missing (covers concurrent first-write).
    # started_at_iso + working_on + files_touched in one jq fork against
    # $STATUS_FILE (was three). files_touched bounded to last 16 (schema
    # MAX_FILES_TOUCHED) inside the same query : daemon also enforces this;
    # bounding here keeps line length sane.
    #
    # The emitted files_touched MERGES the two lists the status file keeps
    # apart. The schema defines the field as "paths edited or read" and forbids
    # additional properties, so reads cannot ride their own JSONL field; they
    # are folded in here instead. Reads are placed FIRST and writes LAST so the
    # .[-16:] bound evicts reads before writes : a path this session MUTATED is
    # the stronger ownership signal and must survive truncation, while reads
    # fill whatever budget is left. Without the read half a session that only
    # diagnoses (reads, greps, runs validators) reports an empty files_touched
    # and is invisible to the sibling-ownership check, which is the gap this
    # closes.
    local started_at_iso="" working_on="" files_json="[]"
    # -s (exists AND nonzero size): an existing-but-EMPTY $STATUS_FILE hits
    # the same zero-JSON-values case as the $INPUT guard above (jq exits 0,
    # zero bytes out, filter never runs). Original's three independent $(...)
    # calls against that file each stayed "" there too (including files_json,
    # since jq exiting 0 means its `|| echo '[]'` fallback never fires) : match
    # that exactly rather than the [] default used for a wholly-absent file.
    if [ -f "$STATUS_FILE" ] && [ ! -s "$STATUS_FILE" ]; then
        files_json=""
    elif [ -s "$STATUS_FILE" ]; then
        {
            IFS= read -r -d '' started_at_iso
            IFS= read -r -d '' working_on
            IFS= read -r -d '' files_json
        } < <(jq -j '(.started_at_iso // "") + "\u0000" + (.working_on // "") + "\u0000" + ((try (((((.files_read // []) - (.files_touched // [])) + (.files_touched // [])) | .[-16:])) catch []) | tojson) + "\u0000"' "$STATUS_FILE" 2>/dev/null)
    fi
    if [ -z "$started_at_iso" ] || [ "$started_at_iso" = "null" ]; then
        started_at_iso="$ISO_NOW"
    fi

    # Git branch for same-branch overlap detection.
    # Silent no-op when cwd is not a git repo : null flows through to record.
    local branch=""
    branch=$(git -C "$PWD" branch --show-current 2>/dev/null || echo "")

    local status
    case "$kind" in
        session_ended) status="complete" ;;
        *)             status="active"   ;;
    esac

    local machine_id env_id
    machine_id=$(_cc_machine_id)
    env_id=$(_cc_active_session_uuid)

    # Version: monotonic per session_id. Use the sidecar helper : it
    # already mutates atomically under move-rename.
    local version
    version=$(_cc_record_version "$STATUS_FILE")

    # Build the envelope. jq emits compact JSON (one line) which is the
    # JSONL contract. files_touched + working_on are optional in schema;
    # only emit when present.
    local line
    if [ -n "$working_on" ] && [ "$working_on" != "null" ]; then
        line=$(jq -nc \
            --arg id "$env_id" \
            --argjson version "$version" \
            --arg kind "$kind" \
            --arg handle "$handle" \
            --arg session_id "$SESSION_ID" \
            --arg machine_id "$machine_id" \
            --arg started_at "$started_at_iso" \
            --arg last_activity "$ISO_NOW" \
            --arg working_on "$working_on" \
            --argjson files_touched "$files_json" \
            --arg branch "$branch" \
            --arg status "$status" \
            --argjson consent_tier "$consent_tier" \
            '{
                id: $id,
                version: $version,
                kind: $kind,
                handle: $handle,
                tool: "cc",
                session_id: $session_id,
                machine_id: $machine_id,
                started_at: $started_at,
                last_activity: $last_activity,
                working_on: $working_on,
                files_touched: $files_touched,
                branch: ($branch | if . == "" then null else . end),
                status: $status,
                provenance_class: "active_composition",
                consent_tier: $consent_tier
            }' 2>/dev/null)
    else
        line=$(jq -nc \
            --arg id "$env_id" \
            --argjson version "$version" \
            --arg kind "$kind" \
            --arg handle "$handle" \
            --arg session_id "$SESSION_ID" \
            --arg machine_id "$machine_id" \
            --arg started_at "$started_at_iso" \
            --arg last_activity "$ISO_NOW" \
            --argjson files_touched "$files_json" \
            --arg branch "$branch" \
            --arg status "$status" \
            --argjson consent_tier "$consent_tier" \
            '{
                id: $id,
                version: $version,
                kind: $kind,
                handle: $handle,
                tool: "cc",
                session_id: $session_id,
                machine_id: $machine_id,
                started_at: $started_at,
                last_activity: $last_activity,
                files_touched: $files_touched,
                branch: ($branch | if . == "" then null else . end),
                status: $status,
                provenance_class: "active_composition",
                consent_tier: $consent_tier
            }' 2>/dev/null)
    fi
    if [ -z "$line" ]; then
        _log_emit_skip "$kind" "jq_build_failed"
        return 0
    fi

    # Ensure parent dir exists (daemon also creates, but CC may emit first).
    mkdir -p "$(dirname "$ACTIVE_SESSIONS_JSONL")" 2>/dev/null || true

    # flock against the file FD itself : matches daemon's
    # fcntl.flock(fd, LOCK_EX). 2s timeout = silent skip.
    if ! exec 201>>"$ACTIVE_SESSIONS_JSONL"; then
        _log_emit_skip "$kind" "open_failed"
        return 0
    fi
    if ! _lock_wait 201 2 "$ACTIVE_SESSIONS_JSONL"; then
        exec 201>&-
        _log_emit_skip "$kind" "flock_timeout"
        return 0
    fi
    printf '%s\n' "$line" >&201
    _lock_release 201 "$ACTIVE_SESSIONS_JSONL"
    exec 201>&-

    # Cache started_at_iso into status file on first emit so subsequent
    # heartbeats reuse the same wall-clock anchor. Read-modify-write under
    # the legacy lock so it stays consistent with files_touched / working_on.
    if [ "$kind" = "session_started" ] && [ -f "$STATUS_FILE" ]; then
        exec 202>"$LOCK_FILE"
        if _lock_wait 202 2 "$LOCK_FILE" 2>/dev/null; then
            local merged
            merged=$(jq --arg sa "$started_at_iso" \
                'if .started_at_iso then . else .started_at_iso = $sa end' \
                "$STATUS_FILE" 2>/dev/null) || merged=""
            if [ -n "$merged" ]; then
                echo "$merged" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
            fi
            _lock_release 202 "$LOCK_FILE"
        fi
        exec 202>&-
    fi
}

# _log_emit_skip : one-line JSON record per skip.
_log_emit_skip() {
    local kind="$1"
    local reason="$2"
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    mkdir -p "$(dirname "$ACTIVE_SESSIONS_EMIT_LOG")" 2>/dev/null || true
    printf '{"ts":"%s","event":"skip","reason":"%s","kind":"%s","session":"%s"}\n' \
        "$ts" "$reason" "$kind" "${SESSION_ID:-}" \
        >>"$ACTIVE_SESSIONS_EMIT_LOG" 2>/dev/null || true
}

# ── UserPromptSubmit: capture what the user asked as "working_on" ──────────
if [ "$EVENT" = "UserPromptSubmit" ]; then
    # Host-wide "a CC session is active right now" marker. Consumers that poll
    # the inbox may tighten their cache TTL while this exists and is fresh : a
    # foreground session wants near-real-time inbox without a persistent SSE
    # daemon.
    # Not per-session; any active session keeps it warm. Self-expires
    # (the reader only honours it for 900s) so a crashed session can't pin it.
    touch "$CC_STATUS_DIR/.session-active" 2>/dev/null || true

    # PROMPT already parsed from $INPUT at top of script; just truncate.
    PROMPT=$(printf '%s' "$PROMPT" | head -c 200)
    [ -z "$PROMPT" ] && { echo '{"continue":true}'; exit 0; }

    if [ -f "$STATUS_FILE" ]; then
        exec 200>"$LOCK_FILE"
        _lock_wait 200 2 "$LOCK_FILE" || { echo '{"continue":true}'; exit 0; }
        CONTENT=$(jq --arg wo "$PROMPT" --arg ts "$NOW" \
            '.working_on = $wo | .last_activity = ($ts | tonumber) | .state = "working"' \
            "$STATUS_FILE" 2>/dev/null) || CONTENT=""
        if [ -n "$CONTENT" ]; then
            echo "$CONTENT" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
        fi
        _lock_release 200 "$LOCK_FILE"
        exec 200>&-
        emit_presence heartbeat
        emit_jsonl session_heartbeat
    else
        CONTENT=$(jq -n --arg pid "$CC_PID" --arg sid "$SESSION_ID" --arg ts "$NOW" \
            --arg wo "$PROMPT" \
            '{pid:$pid, session_id:$sid, started_at:($ts|tonumber), last_activity:($ts|tonumber), working_on:$wo, files_touched:[], last_file:"", state:"working"}')
        atomic_write "$CONTENT"
        emit_presence start
        emit_jsonl session_started
    fi
    # Claim this session on the shared substrate: a first-touch write, or a
    # refresh once the TTL is a third gone. The helper decides whether to
    # write; we always call. Silent on every failure path.
    if _cc_session_claim_should_refresh "$STATUS_FILE"; then
        _cc_emit_session_claim "$SESSION_ID" "$STATUS_FILE"
    fi
    echo '{"continue":true}'
    exit 0
fi

# ── PostToolUse: track files touched ──────────────────────────────────────
# TOOL_NAME + FILE_PATH already parsed from $INPUT at top of script.
#
# WRITE-CLASS vs READ-CLASS. Edit/Write/NotebookEdit MUTATE and land in
# .files_touched; Read only OBSERVES and lands in .files_read. The two are kept
# in separate arrays here and merged only at JSONL-emit time (see emit_jsonl),
# so the write signal can be preferred when the emitted list is truncated.
#
# Read is included because the gate this hook feeds asks "is a sibling already
# on this work item", and a session that has so far only READ the files is
# every bit as much on the item as one that has already edited them. Restricted
# to Edit|Write, a session diagnosing a problem reported zero files and no
# sibling check could see it.
WRITE_CLASS=0
case "$TOOL_NAME" in
    Edit|Write|NotebookEdit) WRITE_CLASS=1 ;;
    Read)                    WRITE_CLASS=0 ;;
    Bash)                    WRITE_CLASS=2 ;;
    *) echo '{"continue":true}'; exit 0 ;;
esac

# VALIDATOR RUNS. A session that has spent its whole turn running the test
# suite, the linter or a project validator has touched no file and, before this,
# reported nothing at all. It carries no path to record and inventing one would
# poison the file-overlap check, whose entries are resolved as real paths. So a
# validator run records no file: it refreshes last_activity and .state instead,
# which is what keeps the session in the live set the ownership check reads,
# and its working_on says what it is validating. Every other Bash call exits
# here without doing any work, so the common case stays as cheap as before.
#
# Matched on the command's leading verb, deliberately narrow. A wider net over
# arbitrary shell would fire on every grep and ls in the session and turn this
# into a heartbeat on literally every tool call.
_validator_run_heartbeat() {
    if [ -f "$STATUS_FILE" ]; then
        exec 200>"$LOCK_FILE"
        _lock_wait 200 2 "$LOCK_FILE" || { echo '{"continue":true}'; exit 0; }
        CONTENT=$(jq --arg ts "$NOW" \
            '.last_activity = ($ts | tonumber) | .state = "working"' \
            "$STATUS_FILE" 2>/dev/null) || CONTENT=""
        if [ -n "$CONTENT" ]; then
            echo "$CONTENT" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
        fi
        _lock_release 200 "$LOCK_FILE"
        exec 200>&-
        emit_presence heartbeat
        emit_jsonl session_heartbeat
    fi
}

if [ "$WRITE_CLASS" = "2" ]; then
    case "$COMMAND" in
        *pytest*|*"npm test"*|*"npm run test"*|\
        *"npm run lint"*|*"npm run typecheck"*|*ruff*|*mypy*|*tsc\ *|*jest*|*eslint*)
            _validator_run_heartbeat
            ;;
    esac
    echo '{"continue":true}'
    exit 0
fi

[ -z "$FILE_PATH" ] && { echo '{"continue":true}'; exit 0; }

REL="${FILE_PATH#$PWD/}"

# Read-class fast path. Reads outnumber writes heavily, and re-recording a path
# already on the list changes nothing while costing a lock plus a jq fork. A
# plain fixed-string match on the status file skips that entirely for the
# repeat case. grep -F, never a regex: a path containing regex metacharacters
# would otherwise match the wrong entry or none at all. The quoting is
# deliberately exact ("path") so a path that is a prefix of another does not
# suppress the longer one's first record.
if [ "$WRITE_CLASS" = "0" ] && [ -s "$STATUS_FILE" ] \
   && grep -qF "\"$REL\"" "$STATUS_FILE" 2>/dev/null; then
    echo '{"continue":true}'
    exit 0
fi

# Which array this tool's path lands in. Read-class paths are kept apart from
# write-class ones so emit_jsonl can prefer writes when it truncates.
if [ "$WRITE_CLASS" = "1" ]; then
    TRACK_FIELD="files_touched"
else
    TRACK_FIELD="files_read"
fi

if [ -f "$STATUS_FILE" ]; then
    exec 200>"$LOCK_FILE"
    _lock_wait 200 2 "$LOCK_FILE" || { echo '{"continue":true}'; exit 0; }
    # Append MOST-RECENT-LAST, deduped by removing any earlier occurrence
    # before appending. The previous `unique | .[-20:]` sorted the array
    # alphabetically and then kept the last 20, so the retained set was the 20
    # lexicographically-highest paths rather than the 20 most recent : a
    # session working under a/ had its real files evicted by anything under z/,
    # and the field's own schema says "bounded to most-recent N". Only
    # .last_file is set from a write-class tool, so it keeps meaning the last
    # file MUTATED rather than the last one merely looked at.
    CONTENT=$(jq --arg f "$REL" --arg ts "$NOW" --arg fld "$TRACK_FIELD" \
        --argjson w "$WRITE_CLASS" \
        '.[$fld] = (((.[$fld] // []) - [$f]) + [$f] | .[-20:])
         | (if $w == 1 then .last_file = $f else . end)
         | .last_activity = ($ts | tonumber) | .state = "working"' \
        "$STATUS_FILE" 2>/dev/null) || CONTENT=""
    if [ -n "$CONTENT" ]; then
        echo "$CONTENT" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
    fi
    _lock_release 200 "$LOCK_FILE"
    exec 200>&-
    emit_presence heartbeat
    emit_jsonl session_heartbeat
else
    CONTENT=$(jq -n --arg pid "$CC_PID" --arg sid "$SESSION_ID" --arg ts "$NOW" \
        --arg f "$REL" --arg fld "$TRACK_FIELD" --argjson w "$WRITE_CLASS" \
        '{pid:$pid, session_id:$sid, started_at:($ts|tonumber), last_activity:($ts|tonumber), working_on:"", files_touched:[], files_read:[], last_file:(if $w == 1 then $f else "" end), state:"working"}
         | .[$fld] = [$f]')
    atomic_write "$CONTENT"
    emit_presence start
    emit_jsonl session_started
fi

# Refresh the session claim after every tracked edit, gated by the same
# TTL-third cadence so a busy pane does not rewrite it on every tool call.
if _cc_session_claim_should_refresh "$STATUS_FILE"; then
    _cc_emit_session_claim "$SESSION_ID" "$STATUS_FILE"
fi

echo '{"continue":true}'
