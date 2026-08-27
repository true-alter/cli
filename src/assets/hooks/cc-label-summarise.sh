#!/usr/bin/env bash
# cc-label-summarise.sh: Backgrounded hermes3:8b summary of the user's prompt.
#
# Triggered by: UserPromptSubmit (global ~/.claude/settings.json)
# Writes:  .label field on /dev/shm/cc-sessions/<project-hash>/<session-id>.json
#          plus .state = "working". Where no other broadcast hook is installed
#          this is the ONLY writer of that file, so without it a pane in that
#          directory carries no session state at all.
# Reads:   the prompt + cwd + session_id from the hook's JSON payload
#
# Pairs with ~/.claude/statusline.sh: the statusline shows .label if present,
# else falls back to .working_on (the raw prompt head written by the session
# broadcast hook). When ollama is down, this hook silently no-ops and
# the statusline shows the raw truncation; when ollama comes back up the
# label upgrades on the next prompt with no other changes required.
#
# This session writes a self-description into the broadcast file; other sessions
# and the statusline read it. No central state, no synchronous dependency.
set -euo pipefail

command -v jq &>/dev/null   || { echo '{"continue":true}'; exit 0; }
command -v curl &>/dev/null || { echo '{"continue":true}'; exit 0; }

INPUT=$(cat)
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null)
[ "$EVENT" = "UserPromptSubmit" ] || { echo '{"continue":true}'; exit 0; }

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null | tr -cd 'a-zA-Z0-9_-')
[ -z "$SESSION_ID" ] && { echo '{"continue":true}'; exit 0; }

CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)
[ -z "$CWD" ] && { echo '{"continue":true}'; exit 0; }

PROMPT=$(echo "$INPUT" | jq -r '.user_prompt // .prompt // .tool_input.prompt // ""' 2>/dev/null | head -c 800)
[ -z "$PROMPT" ] && { echo '{"continue":true}'; exit 0; }

# ── THE LABEL DESCRIBES THE SESSION, NOT THE LAST THING SAID ────────────────
# An earlier revision re-summarised EVERY prompt and overwrote the label with the result.
# In a long session almost every prompt after the first is a follow-up that carries no
# subject of its own ("keep going", "does it work", "/handover to continue", a
# task-notification blob), so the label drifted off whatever the session was actually
# about and landed on whatever was last typed.
#
# Two panes wearing the SAME label are two panes you cannot tell apart, which is the exact
# job this string exists to do. So the label is now STICKY: it is minted from the first
# prompt that actually carries a subject, and it is only ever REPLACED when the session
# genuinely moves to different work. A continuation never rewrites it.
#
# TWO GATES, cheapest first:
#   1. A mechanical skip for turns that carry no subject at all (below). Costs nothing,
#      and catches the majority: transcripts, tool blobs, bare continuations.
#   2. The model itself, holding the CURRENT label, asked to KEEP or REPLACE. This is
#      what catches the case the regex cannot: a substantive prompt that is nonetheless a
#      refinement of the work already in flight.

# GATE 1a: machine blobs. A bash transcript (`!command`), a task notification, a system
# reminder, or a slash-command echo is not a human describing work, and summarising one
# produces a label about the plumbing. The shell-prompt arm matches ANY username, never a
# hardcoded one, so it works for whoever is running.
if echo "$PROMPT" | grep -qE '(<bash-(input|stdout|stderr)>|<task-notification>|<system-reminder>|<local-command|^[[:alnum:]_.-]+[[:space:]]+[~▶]|^sudo[[:space:]]|^\[sudo\]|[▶│])' 2>/dev/null; then
    echo '{"continue":true}'
    exit 0
fi

# GATE 1b: bare continuations. These carry no subject whatever, and re-labelling from one
# is how a session about the assessment engine ends up called "keep-going". Matched on the
# WHOLE prompt (trimmed, lowercased, punctuation dropped), so a prompt that merely BEGINS
# with "ok" but goes on to say something real is not caught here.
_norm=$(printf '%s' "$PROMPT" | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:]' \
        | tr -s '[:space:]' ' ' | sed -e 's/^ //' -e 's/ $//')
case "$_norm" in
    ''|ok|okay|yes|yep|yeah|yup|sure|no|nope|ta|thanks|thank\ you|cheers|k|kk \
    |go|go\ on|going|do\ it|just\ do\ it|send\ it|ship\ it|proceed|continue|carry\ on \
    |keep\ going|keep\ at\ it|next|more|again|retry|redo|and|also|hmm|right|good|nice \
    |is\ it\ working|is\ it\ workingn|does\ it\ work|did\ it\ work|working|done|finished \
    |handover|handover\ to\ continue|handover\ to\ continue\ in\ a\ new\ session \
    |go\ continue|continue\ in\ a\ new\ session|resume|pick\ up\ where\ you\ left\ off)
        echo '{"continue":true}'
        exit 0 ;;
esac
# Anything under four words is a continuation in practice, not a brief.
_wc=$(printf '%s' "$_norm" | wc -w 2>/dev/null | tr -d ' ')
[[ "$_wc" =~ ^[0-9]+$ ]] || _wc=99
if [ "$_wc" -lt 4 ]; then
    echo '{"continue":true}'
    exit 0
fi

# Resolve broadcast file location: matches cc-broadcast.sh / config.sh logic.
_cc_root=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "$CWD")
if [ -d /dev/shm ]; then
    _base="/dev/shm/cc-sessions"
else
    _base="/tmp/cc-sessions"
fi
if command -v md5sum &>/dev/null; then
    _hash=$(echo "$_cc_root" | md5sum | cut -c1-8)
elif command -v md5 &>/dev/null; then
    _hash=$(echo "$_cc_root" | md5 -q | cut -c1-8)
else
    _hash=$(echo "$_cc_root" | cksum | cut -d' ' -f1)
fi
STATUS_DIR="$_base/$_hash"
STATUS_FILE="$STATUS_DIR/$SESSION_ID.json"
LOCK_FILE="$STATUS_DIR/.lock"
mkdir -p "$STATUS_DIR" 2>/dev/null || true

# ── portable read-modify-write lock ─────────────────────────────────────────
# flock is GNU/Linux-only and absent on stock macOS; mkdir is atomic on every
# POSIX filesystem and is the portable substitute. Unlike flock's fd, a mkdir lock
# does not self-release when the holder crashes, so a lock dir older than
# STALE_S is presumed abandoned and broken rather than wedging every future
# write forever. $1 = lock dir, $2 = max wait seconds (matches the previous
# `flock -w N` semantics).
_lm_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
_lock_acquire() {
    local dir="$1" wait_s="${2:-2}" waited=0 stale_s=10
    while ! mkdir "$dir" 2>/dev/null; do
        # mkdir can fail for reasons other than the dir existing (ENOENT on a
        # missing parent, EACCES, EROFS, ENOSPC). Those are unrecoverable here,
        # and the stale-break below cannot see them: an absent dir reads mtime
        # 0, so it always looks stale and rmdir always fails. Bail rather than
        # spin.
        [ -d "$dir" ] || return 1
        if [ $(( $(date +%s) - $(_lm_mtime "$dir") )) -gt "$stale_s" ]; then
            rmdir "$dir" 2>/dev/null || true
        fi
        [ "$waited" -ge "$wait_s" ] && return 1
        sleep 1
        waited=$(( waited + 1 ))
    done
    return 0
}
_lock_release() { rmdir "$1" 2>/dev/null || true; }

OLLAMA_URL="${OLLAMA_HOST:-http://localhost:11434}"
OLLAMA_MODEL="${CC_LABEL_MODEL:-hermes3:8b}"

# Synchronous step: ensure the broadcast file exists and carries .working_on.
# Where a session broadcast hook is also installed it populates this; in any
# other directory this is the only writer, so without it the statusline label
# segment stays empty.
NOW=$(date +%s)
PROMPT_HEAD=$(echo "$PROMPT" | head -c 200)
if [ -e "$STATUS_FILE" ]; then
    if _lock_acquire "$LOCK_FILE.d" 2; then
        MERGED=$(jq --arg wo "$PROMPT_HEAD" --arg ts "$NOW" \
            '.working_on = $wo | .last_activity = ($ts | tonumber) | .state = "working"' \
            "$STATUS_FILE" 2>/dev/null) || MERGED=""
        if [ -n "$MERGED" ]; then
            echo "$MERGED" > "$STATUS_FILE.tmp" 2>/dev/null && \
                mv "$STATUS_FILE.tmp" "$STATUS_FILE" 2>/dev/null
        fi
        _lock_release "$LOCK_FILE.d"
    fi
else
    CONTENT=$(jq -n \
        --arg pid "$PPID" \
        --arg sid "$SESSION_ID" \
        --arg ts "$NOW" \
        --arg wo "$PROMPT_HEAD" \
        '{pid:$pid, session_id:$sid, started_at:($ts|tonumber), last_activity:($ts|tonumber), working_on:$wo, files_touched:[], last_file:"", state:"working"}')
    if _lock_acquire "$LOCK_FILE.d" 2; then
        echo "$CONTENT" > "$STATUS_FILE.tmp" 2>/dev/null && \
            mv "$STATUS_FILE.tmp" "$STATUS_FILE" 2>/dev/null
        _lock_release "$LOCK_FILE.d"
    fi
fi

# The label already standing on this session, if any. It is what makes the decision
# below a KEEP-or-REPLACE rather than a fresh summarisation, and it is the whole
# difference between a session descriptor and a description of the last thing typed.
EXISTING=""
[ -f "$STATUS_FILE" ] && EXISTING=$(jq -r '.label // ""' "$STATUS_FILE" 2>/dev/null)

# Background the network call: never block CC's prompt flow.
(
    # Liveness probe: 1s timeout. Down = silent no-op, statusline falls back
    # to .working_on truncation.
    curl -sS --max-time 1 "$OLLAMA_URL/api/tags" >/dev/null 2>&1 || exit 0

    _LABEL_RULES='Output ONLY a 2-4 word lowercase label, at most 28 characters, naming the SUBJECT of the work. Use hyphens between words. No quotes, no punctuation, no preamble, no trailing dot. Three words is the sweet spot. Examples: alembic-audit, statusline-overhaul, pricing-rewrite, ietf-disclosure-cleanup.'

    if [ -z "$EXISTING" ]; then
        # FIRST SUBSTANTIVE PROMPT. This is the one that names the session, and it is the
        # label that will normally stand for the session's whole life.
        SYSTEM="You are a label generator. Read the user request and name what this working session is about. $_LABEL_RULES"
        USER="$PROMPT"
    else
        # EVERY PROMPT AFTER. The model is handed the label the session is ALREADY wearing
        # and asked the only question that matters: is this still that work? Almost always
        # it is, and almost always the right answer is to change nothing. A session is
        # renamed only when it has genuinely turned to a different subject, which is rare
        # and is exactly when the pane SHOULD update.
        SYSTEM="You decide whether a working session has changed subject.

The session is currently labelled: ${EXISTING}

Read the user's latest message. If it continues, refines, corrects, tests, extends, or asks about THAT SAME work in any way, reply with exactly: KEEP

Only if the user has clearly turned to a DIFFERENT subject, reply with a new label. $_LABEL_RULES

Default strongly to KEEP. A follow-up, a complaint, a question, a correction, or a request to carry on is always KEEP."
        USER="$PROMPT"
    fi

    PAYLOAD=$(jq -n \
        --arg m "$OLLAMA_MODEL" \
        --arg p "$USER" \
        --arg s "$SYSTEM" \
        '{model:$m, prompt:$p, system:$s, stream:false, options:{num_predict:18, temperature:0.1, top_p:0.9}}')

    RESP=$(curl -sS --max-time 30 "$OLLAMA_URL/api/generate" -d "$PAYLOAD" 2>/dev/null)
    [ -z "$RESP" ] && exit 0

    RAW=$(echo "$RESP" | jq -r '.response // ""' 2>/dev/null | tr -d '\n\r"`')

    # KEEP means the session is still about what it was about. Nothing is written, and the
    # label you have learned to recognise on that pane stays exactly where it is.
    case "$(printf '%s' "$RAW" | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:][:space:]')" in
        keep*) exit 0 ;;
    esac

    LABEL=$(printf '%s' "$RAW" \
        | tr '[:upper:]' '[:lower:]' \
        | sed -E 's/[^a-z0-9 -]/ /g; s/  +/ /g; s/^ +//; s/ +$//; s/ /-/g; s/--+/-/g' \
        | head -c 40)
    [ -z "$LABEL" ] && exit 0
    # A model that answers with a sentence, or echoes the instruction, is refused rather
    # than allowed to overwrite a good label with rubbish. Keeping the old label is always
    # the safe failure here: it is at worst stale, never misleading.
    case "$LABEL" in
        keep*|-*|*--*) exit 0 ;;
    esac
    [ "${#LABEL}" -ge 3 ] || exit 0
    [ "$LABEL" = "$EXISTING" ] && exit 0

    [ -f "$STATUS_FILE" ] || exit 0

    _lock_acquire "$LOCK_FILE.d" 2 || exit 0
    CONTENT=$(jq --arg lbl "$LABEL" --arg ts "$NOW" \
        '.label = $lbl | .label_at = ($ts | tonumber)' "$STATUS_FILE" 2>/dev/null) || CONTENT=""
    if [ -n "$CONTENT" ]; then
        echo "$CONTENT" > "$STATUS_FILE.tmp" 2>/dev/null && mv "$STATUS_FILE.tmp" "$STATUS_FILE" 2>/dev/null
    fi
    _lock_release "$LOCK_FILE.d"
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true

echo '{"continue":true}'
