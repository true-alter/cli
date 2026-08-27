#!/usr/bin/env bash
# session-lesson-reconcile.sh: UserPromptSubmit: surface unlogged lesson
# candidates AND nudge a cluster review when it falls due.
#
# Triggered by: UserPromptSubmit (content-addressed gate via _cc_brief_should_emit
#              , emits on the first prompt of a session AND whenever the candidate
#               set changes; silent on every prompt where it is unchanged).
# Reads:        cc-lessons-pending.jsonl (staged by the cc-lesson-capture Stop hook)
#               and the local doctrine projection (lesson-* root_cause_class tally).
# Does:         (1) when candidates are staged, injects a short additionalContext
#               line prompting THIS session to write each as a lesson-* entry and
#               then clear the file; (2) when a root_cause_class keeps accruing
#               lessons and has grown since the last recorded review, injects a
#               nudge to review that cluster. This closes the "review only runs if
#               someone remembers" gap without a daemon.
# Ack mode:     `session-lesson-reconcile.sh --ack` records the currently-due
#               classes as the review watermark, so the nudge stays quiet until a
#               class grows again.
# Returns:      {"continue":true} (+ additionalContext when something is due).
#
# Companion to cc-lesson-capture.sh. The capture hook stages; this hook reminds;
# the agent writes the lesson and runs the review. Uses the same first-prompt
# injection shape and content-addressed gating the other session-start blocks use
# (config.sh::_cc_brief_should_emit).
set -euo pipefail

command -v jq &>/dev/null || { echo '{"continue":true}'; exit 0; }

source "$(dirname "$0")/config.sh"

# The $HOME path is the live corpus; ALTER_DOCTRINE_PROJECTION overrides it (test
# harness only, never set in a real session).
PROJ="${ALTER_DOCTRINE_PROJECTION:-$HOME/.local/share/alter/doctrine/personal.jsonl}"
ACK="${ALTER_LOG_DIR:-$HOME/.local/share/alter}/lessons-audit-acked.json"

CLUSTER_MIN=3         # a class needs this many lessons before it can be reviewed
RENUDGE_DAYS=30       # after an ack, a class stays quiet at least this long

# Optional fold map, collapses near-synonym class labels onto one canonical
# class before counting. Absent or malformed, the fold degrades to identity.
ALIAS_FILE="$(dirname "$0")/root-cause-aliases.json"

# Tally entries per root_cause_class from the projection. Each class is
# normalised through the fold map BEFORE counting, so near-synonym labels
# collapse to one canonical class. An unmapped class passes through unchanged.
# Diagnostic only, surfaced by `--tally`.
_cluster_tally() {
    [ -s "$PROJ" ] || { echo '{}'; return 0; }
    local aliases amap
    aliases="$ALIAS_FILE"
    amap='{}'
    if [ -s "$aliases" ]; then
        amap="$(cat "$aliases" 2>/dev/null || echo '{}')"
        printf '%s' "$amap" | jq -e 'type == "object"' >/dev/null 2>&1 || amap='{}'
    fi
    # The label may be written plain (`root_cause_class: foo`), markdown-bold
    # (`**root_cause_class:** foo`), or as a heading (`## root_cause_class` then
    # the value on a later line). A `:\s*` matcher cannot cross the trailing `**`
    # and DROPS those rows silently. Consume any run of separator/emphasis
    # characters before the value so every body form counts.
    #
    # The match is LINE-ANCHORED to the FIELD form first. An unanchored matcher takes
    # the body's first occurrence of the term anywhere, so a row whose PROSE discusses
    # root_cause_class before declaring its own field captures the next prose word
    # ("clustering", "repeat", "as") and is tallied as a phantom class while its real
    # label goes uncounted. The loose matcher stays as a fallback for bodies that only
    # ever mention the term mid-line.
    #
    # EVERY LIVE HEAD PER SLUG COUNTS, NEVER "the latest version wins". The
    # projection holds CURRENT heads only, so a lesson-* slug appearing more than
    # once here is a LIVE FORK or a declared LEDGER, never amendment history to
    # collapse by picking the highest (version, created_at). Collapsing silently
    # undercounts a forked slug's root_cause_class, which is exactly what this
    # tally feeds a review-due decision on. The supersedes_id filter below is the
    # reader's own defensive backstop against the residual case of a DIFFERENT
    # writer of this same projection leaving a merge-retired row beside its
    # surviving head.
    jq -rs --argjson amap "$amap" '
        [ .[] | select((.slug // "") | startswith("lesson-")) ]
        | group_by(.slug)
        | map(
            (map(.supersedes_id) | map(select(. != null))) as $retired
            | map(select(([.id] | inside($retired)) | not))
          )
        | flatten
        | map(select((.status // "active") == "active"))
        | [ .[] | ((.body // "") as $b
              | (($b | capture("(?im)^[\\s>*#-]*\\**root_cause_class\\**[\\s:*\"'\''`]*(?<c>[A-Za-z0-9][A-Za-z0-9_-]+)")? | .c)
                 // ($b | capture("(?i)root_cause_class[\\s:*\"'\''`]*(?<c>[A-Za-z0-9][A-Za-z0-9_-]+)")? | .c)))
              | select(. != null)
              | ascii_downcase
              | ($amap[.] // .) ]
        | group_by(.) | map({(.[0]): length}) | add // {}
    ' "$PROJ" 2>/dev/null || echo '{}'
}

# Classes that are review-DUE: a class holding CLUSTER_MIN+ lessons that has GROWN
# since the last recorded ack. Emits a JSON array (possibly empty) of
# {class, n, post_n, sop_id, age_days}, newest growth first.
#
# Growth, not raw size, is the trigger: a class that has not moved since you last
# looked at it has nothing new to say, and re-nudging on it trains the reader to
# ignore the nudge. RENUDGE_DAYS additionally floors how often the same class can
# speak up again.
#
# Dates are aged with jq's own mktime, never `date -d` (GNU-only, absent on stock
# macOS), so the hook stays portable.
_due_json() {
    [ -s "$PROJ" ] || { echo '[]'; return 0; }
    local ack_json tally out
    tally="$(_cluster_tally)"
    printf '%s' "$tally" | jq -e 'type == "object"' >/dev/null 2>&1 || tally='{}'
    ack_json="$(cat "$ACK" 2>/dev/null || echo '{}')"
    printf '%s' "$ack_json" | jq -e 'type == "object"' >/dev/null 2>&1 || ack_json='{}'

    out=$(jq -n --argjson tally "$tally" --argjson ack "$ack_json" \
                --argjson min "$CLUSTER_MIN" --argjson renudge "$RENUDGE_DAYS" '
        def days_since($d): (now - ($d | strptime("%Y-%m-%d") | mktime)) / 86400;

        # An ack entry is an object here, but a legacy ack file held raw counts.
        # Indexing a number would abort the whole filter and fail QUIET (no
        # nudge, no error), so both shapes are read defensively.
        [ $tally
          | to_entries[]
          | { class: .key,
              n: .value,
              prev: ($ack[.key] | if type == "object" then (.post_n_at_ack // 0)
                                  elif type == "number" then .
                                  else 0 end),
              acked_at: ($ack[.key] | if type == "object" then (.acked_at // null)
                                      else null end) }
          | select(.n >= $min and .n > .prev)
          | select(.acked_at == null or days_since(.acked_at) >= $renudge)
          | { class, n, post_n: (.n - .prev), sop_id: null, age_days: 0 } ]
        | sort_by(-.post_n)
    ' 2>/dev/null) || out='[]'
    printf '%s' "$out" | jq -e 'type == "array"' >/dev/null 2>&1 || out='[]'
    printf '%s' "$out"
}


# ── Tally mode: diagnostic per-class counts ─────────────────────────────────
if [ "${1:-}" = "--tally" ]; then
    _cluster_tally
    exit 0
fi

# ── Ack mode: quiet each currently-DUE class for RENUDGE_DAYS ───────────────
# Only DUE classes are acked. A class that matures into DUE later is NOT
# suppressed by an earlier audit it was never part of.
if [ "${1:-}" = "--ack" ]; then
    mkdir -p "$(dirname "$ACK")" 2>/dev/null || true
    DUE_NOW=$(_due_json)
    PREV=$(cat "$ACK" 2>/dev/null || echo '{}')
    printf '%s' "$PREV" | jq -e 'type == "object"' >/dev/null 2>&1 || PREV='{}'
    MERGED=$(jq -n --argjson prev "$PREV" --argjson due "$DUE_NOW" '
        $prev + ( $due | map({ (.class): { acked_at: (now | strftime("%Y-%m-%d")),
                                           sop_id, post_n_at_ack: .post_n } }) | add // {} )
    ' 2>/dev/null || echo '')
    if [ -n "$MERGED" ]; then
        printf '%s\n' "$MERGED" > "$ACK"
        N=$(printf '%s' "$DUE_NOW" | jq 'length' 2>/dev/null || echo 0)
        echo "lessons-audit watermark recorded ($N class(es) acked): $ACK"
    else
        echo "lessons-audit watermark NOT recorded (jq failed): $ACK" >&2
    fi
    exit 0
fi

INPUT=$(cat)
SID=$(_cc_resolve_session_id "$INPUT")

PENDING="${ALTER_LESSONS_PENDING:-${ALTER_LOG_DIR:-$HOME/.local/share/alter}/cc-lessons-pending.jsonl}"

# ── Part 1: unlogged staged candidates ───────────────────────────────────────
MSG_PENDING=""
if [ -s "$PENDING" ]; then
    # Summarise the pending set: count + unique sessions + unique phrases. The JSON
    # is the content-hash input, so a newly-staged candidate changes the hash and
    # re-surfaces the reminder; an unchanged set stays silent.
    SUMMARY_JSON=$(jq -s '
        { count: length,
          sessions: ([ .[].session_id // "?" ] | unique),
          phrases:  ([ .[].matched_phrase // "?" ] | unique) }
    ' "$PENDING" 2>/dev/null || echo '')

    COUNT=$(printf '%s' "$SUMMARY_JSON" | jq -r '.count // 0' 2>/dev/null || echo 0)
    case "$COUNT" in ''|*[!0-9]*) COUNT=0 ;; esac

    # Content-addressed gate: emit only when new/changed for this session. Used as
    # an if-condition: the skip path returns non-zero by design (config.sh note).
    if [ "$COUNT" -gt 0 ] && _cc_brief_should_emit "lesson-reconcile" "$SID" "$SUMMARY_JSON"; then
        PHRASES=$(printf '%s' "$SUMMARY_JSON" | jq -r '(.phrases // []) | join("; ")' 2>/dev/null || echo '')
        MSG_PENDING="LESSON CANDIDATES: ${COUNT} unlogged candidate(s) staged from prior session(s). The cc-lesson-capture Stop hook saw an error acknowledgement with no lesson entry written. For EACH, write a lesson entry wherever you keep them (a doctrine or decision register if you use one, otherwise a local notes file), with these fields:
  incident / surfaced_by / mechanism (verified, not recalled) / guard_gap / remediation / prevention_rung / root_cause_class
Then clear the file once written: > ${PENDING}
Detected cues: ${PHRASES}
(If on review a candidate was a false positive, meta-discussion rather than a real error, just clear it.)"
    fi
fi

# ── Part 2: cluster review nudge ─────────────────────────────────────────────
# A class is DUE when it holds CLUSTER_MIN+ lessons and has grown since the last
# ack. The finding worth acting on is never that a class is common, it is that
# the class kept accruing while whatever was meant to prevent it stayed prose.
#
# It is deliberately NOT a recurrence-RATE trigger: created_at records when a
# lesson was WRITTEN, not when the failure happened, so a retrospective backfill
# reads as a rate spike, and the largest classes are wide catch-alls whose
# recurrence tracks bucket width rather than a failing prevention.
MSG_CLUSTER=""
DUE=$(_due_json)
DUE_N=$(printf '%s' "$DUE" | jq 'length' 2>/dev/null || echo 0)
case "$DUE_N" in ''|*[!0-9]*) DUE_N=0 ;; esac
if [ "$DUE_N" -gt 0 ] && _cc_brief_should_emit "lesson-cluster" "$SID" "$DUE"; then
    LIST=$(printf '%s' "$DUE" | jq -r '
        map("\(.class) (\(.n) lessons, \(.post_n) since the last review)")
        | join("; ")' 2>/dev/null || echo '')
    MSG_CLUSTER="LESSON CLUSTER REVIEW DUE: a failure class keeps recurring while prose is still the only thing preventing it: ${LIST}. The finding is NOT that the class is common; it is that it kept accruing anyway. Review the named cluster this session and, where the prevention is genuinely still prose, propose the MECHANICAL guard (hook, CI check, or test) that would close the recurrence path. Then record the watermark by running the installed session-lesson-reconcile.sh --ack, which keeps the class quiet for at least ${RENUDGE_DAYS} days."
fi

# ── Emit ─────────────────────────────────────────────────────────────────────
if [ -z "$MSG_PENDING" ] && [ -z "$MSG_CLUSTER" ]; then
    echo '{"continue":true}'
    exit 0
fi

MSG="${MSG_PENDING}"
[ -n "$MSG_PENDING" ] && [ -n "$MSG_CLUSTER" ] && MSG="${MSG}

"
MSG="${MSG}${MSG_CLUSTER}"

CTX=$(printf '%s' "$MSG" | jq -Rs '.')
echo "{\"continue\":true,\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":$CTX}}"
