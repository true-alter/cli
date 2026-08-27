#!/usr/bin/env bash
# homework-preflight-gate.sh: PreToolUse hook for AskUserQuestion.
# Injects a model-visible homework pre-flight before CC asks the user a
# question that could be answered by observation.
# Advisory: never blocks, never gates. Injecting nothing is always safe.
#
# The pre-flight rides hookSpecificOutput.additionalContext, a model-only
# channel: the text reaches the asking model's context for the call and is
# never rendered to the user. It carries context and decides nothing. An
# advisory hook must never emit permissionDecision on AskUserQuestion, because
# that decision RESOLVES the dialog: the question would auto-answer and close
# with no human ever seeing it, the opposite of what an AskUserQuestion is for.
#
# The advisory is deduplicated per 30-minute window (CC_SPECIALIST_WINDOW).
#
# PORTABILITY: python3 does every JSON read. An earlier revision required jq
# and exited silently without it, so it had never once fired on a stock macOS
# box (no jq preinstalled). No bash-4-isms, no `declare -A`, no mapfile, no
# GNU-only flags, no `readlink -f`. /dev/shm is existence-gated inside
# config.sh.
#
# FAIL SOFT, ALWAYS: missing python3, or any exception, yields
# {"continue":true} and the question proceeds. This hook advises; it does not
# gate. Injecting nothing must always be safe.
set -uo pipefail
trap 'exit 0' EXIT

PASS='{"continue":true}'

command -v python3 >/dev/null 2>&1 || { printf '%s\n' "$PASS"; exit 0; }
# shellcheck source=/dev/null
source "$(dirname "$0")/config.sh" 2>/dev/null || { printf '%s\n' "$PASS"; exit 0; }

INPUT=$(cat 2>/dev/null || true)
[ -z "${INPUT//[[:space:]]/}" ] && { printf '%s\n' "$PASS"; exit 0; }

# The advisory half keeps its 30-minute dedup. The query half never sees this
# marker: `mkdir` failing means the advisory already fired this window, not that
# the question is unworthy of a substrate read.
ADVISORY_OK=0
if mkdir -p "$CC_SPECIALIST_DIR" 2>/dev/null; then
    WINDOW=$(( $(date +%s) / CC_SPECIALIST_WINDOW ))
    if mkdir "$CC_SPECIALIST_DIR/homework-preflight-$WINDOW" 2>/dev/null; then
        ADVISORY_OK=1
    fi
fi


AQ_INPUT="$INPUT" AQ_ADVISORY_OK="$ADVISORY_OK" \
python3 - <<'PY' 2>/dev/null || printf '%s\n' "$PASS"
import json, os, re, sys, time

PASS = '{"continue":true}'


def bail():
    print(PASS)
    sys.exit(0)


try:
    payload = json.loads(os.environ.get("AQ_INPUT") or "{}")
except Exception:
    bail()

if payload.get("tool_name") != "AskUserQuestion":
    bail()

questions = (payload.get("tool_input") or {}).get("questions") or []
if not questions:
    bail()


advisory_ok = os.environ.get("AQ_ADVISORY_OK") == "1"
blocks = []


if advisory_ok:
    # Bind `advisory` here so it is always set before it is appended, whatever
    # else does or does not reassign it further down.
    advisory = (
        "HOMEWORK PRE-FLIGHT (model-only advisory): before this question "
        "reaches the user, verify the answer is not already observable: git "
        "(log / cherry / show against the TARGET ref, not the open tree), any "
        "MCP tools you have connected (a doctrine or decision register where "
        "wired), project docs and agent instruction files, or the working "
        "tree. If one of "
        "those answers it, do not ask; ask only the residual. Any state-claim "
        "inside the question's options must cite how it was verified or be "
        "labelled unverified-inference. A doc read is weaker than a code read "
        "and must be reconciled against the running code before being cited "
        "as current."
    )
    blocks.append(advisory)

# Silent by default: no name-hit and no advisory window means inject nothing.
# {"continue":true} IS the silence contract every sibling on this matcher uses.
if not blocks:
    bail()

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": "\n\n".join(blocks),
    }
}))
PY
