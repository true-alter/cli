#!/usr/bin/env bash
# auto-format.sh - PostToolUse hook for Edit|Write
# Auto-formats Python files (ruff) and TypeScript files (eslint) after edits.
# Runs silently - no systemMessage, no blocking. Just keeps files clean.
set -eo pipefail

# Require jq - exit silently if missing
command -v jq &>/dev/null || exit 0

# Load shared config (dynamic project path)
source "$(dirname "$0")/config.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

case "$TOOL_NAME" in
    Edit|Write) ;;
    *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)
[ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ] && exit 0

case "$FILE_PATH" in
    *.py)
        # Only format files inside the project
        [[ "$FILE_PATH" == "$CC_PROJECT_ROOT"/* ]] || exit 0
        command -v ruff &>/dev/null || exit 0
        ruff format --quiet "$FILE_PATH" 2>/dev/null || true
        ruff check --fix --quiet "$FILE_PATH" 2>/dev/null || true
        ;;
    *.ts|*.tsx|*.js|*.jsx)
        [[ "$FILE_PATH" == "$CC_PROJECT_ROOT/frontend/"* ]] || exit 0
        ESLINT="$CC_PROJECT_ROOT/frontend/node_modules/.bin/eslint"
        [ -x "$ESLINT" ] || exit 0
        REL_PATH="${FILE_PATH#$CC_PROJECT_ROOT/frontend/}"
        cd "$CC_PROJECT_ROOT/frontend" && "$ESLINT" --fix "$REL_PATH" 2>/dev/null || true
        ;;
esac

exit 0
