#!/usr/bin/env bash
# environment-intent-gate.sh - PreToolUse hook for Skill
# When CC invokes a deploy or release skill on a non-trivial change, injects a
# systemMessage reminding CC to confirm the target environment before
# proceeding.
# Advisory gate - never blocks, just reminds. Deduplicates per 30-minute window.
set -euo pipefail

command -v jq &>/dev/null || { echo '{"continue":true}'; exit 0; }
source "$(dirname "$0")/config.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

[ "$TOOL_NAME" = "Skill" ] || { echo '{"continue":true}'; exit 0; }

SKILL_NAME=$(echo "$INPUT" | jq -r '.tool_input.skill // ""' 2>/dev/null)

# Each arm is a complete case clause, so the list extends by adding an arm
# rather than reshaping the match. These are the deploy and release skill
# names any project would use.
case "$SKILL_NAME" in
    ship|flush|merge|promote|deploy|release) ;;
    *) echo '{"continue":true}'; exit 0 ;;
esac

mkdir -p "$CC_SPECIALIST_DIR"
WINDOW=$(( $(date +%s) / CC_SPECIALIST_WINDOW ))
MARKER="$CC_SPECIALIST_DIR/environment-intent-$WINDOW"
mkdir "$MARKER" 2>/dev/null || { echo '{"continue":true}'; exit 0; }

# Generic default, overridden below where a machine-readable check policy exists.
CHECK_FLOOR="project's required checks"


MSG="ENVIRONMENT INTENT (auto-injected by environment-intent-gate.sh): You are about to invoke /$SKILL_NAME, which can deploy or release code. Confirm the target environment (dev / staging / prod) is intended before proceeding. The $CHECK_FLOOR must pass in CI before any merge to the main branch. If environment intent is clear from context, proceed. If not, confirm with the user first."


MSG_JSON=$(printf '%s' "$MSG" | jq -Rs '.')
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":%s}}\n' "$MSG_JSON"
