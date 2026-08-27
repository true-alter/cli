#!/usr/bin/env bash
# agent-substrate-prologue.sh, PreToolUse hook on the `Agent`/`Task` tool.
#
# PURPOSE: prepend a verification prologue to every dispatched sub-agent's
# prompt, so the dispatched session verifies its claims against actual sources
# rather than relaying unchecked narrative. Every state-claim it returns must
# cite how it was verified, or be labelled [unverified-inference].
#
# OUTPUT SHAPE (PreToolUse): emit `hookSpecificOutput.updatedInput`, rewriting
# tool_input.prompt with the prologue prepended. `permissionDecision="allow"`
# plus `permissionDecisionReason` is the wrong vector on two counts. The reason
# string surfaces to the PARENT session, never to the dispatched sub-agent, so
# the prologue would never reach the one reader it is written for. And an
# explicit allow on every Agent/Task call blanket-approves the dispatch, which
# an advisory hook has no business doing. The COMPLETE tool_input object is
# re-emitted with prompt replaced, so the rewrite holds whether the harness
# merges updatedInput or replaces it outright.
#
# OWNERSHIP: this hook is the SOLE owner of `updatedInput` in the Agent|Task
# PreToolUse matcher block. Do not add a second updatedInput-emitting hook to
# that block without defining a merge order, or the two rewrites will race.
#
# IDEMPOTENT: a prompt already carrying the prologue passes through untouched,
# so a re-dispatch cannot stack it twice.
#
# FAIL-OPEN: any parse failure, missing jq, missing prompt -> {"continue":true}.
# Dispatch must never be blocked by this hook.

set -euo pipefail

command -v jq >/dev/null 2>&1 || { printf '{"continue":true}\n'; exit 0; }

INPUT=$(cat 2>/dev/null) || { printf '{"continue":true}\n'; exit 0; }
[[ -z "$INPUT" ]] && { printf '{"continue":true}\n'; exit 0; }

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) \
    || { printf '{"continue":true}\n'; exit 0; }

# Matcher is wired in settings.json; defensive double-check here.
case "$TOOL_NAME" in
    Agent|Task) ;;
    *) printf '{"continue":true}\n'; exit 0 ;;
esac

PROMPT=$(printf '%s' "$INPUT" | jq -r '.tool_input.prompt // ""' 2>/dev/null) \
    || { printf '{"continue":true}\n'; exit 0; }
[[ -z "$PROMPT" ]] && { printf '{"continue":true}\n'; exit 0; }

# Idempotency: if a retry/resume re-fires this event on an already-rewritten
# prompt, do not stack a second copy of the prologue (context bloat).
case "$PROMPT" in
    *"VERIFICATION PROLOGUE"*) printf '{"continue":true}\n'; exit 0 ;;
esac

# Optional second prologue block, prepended after the static one. Empty
# unless the block below builds it, and an empty value adds nothing to the
# dispatched prompt.
SHARED_STATE=""

# Optional per-dispatch rules slice, injected just before the DISPATCH MANDATE.
# Empty unless the block below builds one, and an empty value adds nothing.
RULES_SLICE=""

# ── Verification prologue, verbatim, do not paraphrase ───────────────────
read -r -d '' PROLOGUE <<'PROLOGUE_EOF' || true
VERIFICATION PROLOGUE

You are dispatched to verify your claims against the actual sources, not to relay unchecked narrative. Every state-claim in your report must cite how it was verified, or be labelled [unverified-inference].

Required behaviour:
1. Before claiming X exists / does not exist / has been removed / is not wired: actively check the relevant source. Codebase claims need grep or Read output. Removal claims need git history showing the removing commit plus a present-day Read confirming absence.
2. Search-by-route-before-class-name: when the search term is conjectural (a guessed class name, a guessed file path), search for the user-facing route, the feature name, or the identifier FIRST. A false-negative on a class name does not entail the absence of the feature.
3. Label every claim with how it was verified (for example: grep-verified, file-read-verified, commit-cited) or mark it unverified-inference. The foreground session merges your claims locally; the labels tell it what to trust and what to re-check.
4. Verified sources are the only basis for state-claims. Cached or synthesised narrative is not a verified source; it is one observation among many that needs cross-checking against the code.
5. When a source cannot be checked: return [unverified-inference] rather than fabricating confidence. The foreground session prefers uncertainty over a false positive.

This is the approach, not a checklist. Return claims-with-sources or return [unverified-inference]; never return claims-without-sources.
PROLOGUE_EOF


# ── Emit updatedInput: rewrite tool_input.prompt with the prologue prepended.
# Re-emit the COMPLETE tool_input object (prompt replaced) so the rewrite is
# correct whether the harness merges or replaces updatedInput.
# $ss and $slice are both optional: each is prepended with its own separator
# only when it is non-empty, so an absent one adds nothing at all to the
# prompt. The static $pro always stays first, preserving the byte-stable
# prompt-cache prefix.
OUT=$(printf '%s' "$INPUT" | jq -c \
    --arg ss "$SHARED_STATE" \
    --arg pro "$PROLOGUE" \
    --arg slice "$RULES_SLICE" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse", updatedInput:(.tool_input | .prompt = (
        $pro
        + (if ($ss | length) > 0 then "\n\n" + $ss else "" end)
        + (if ($slice | length) > 0 then "\n\n--- STANDING RULES, BIRTH SLICE ---\n\n" + $slice else "" end)
        + "\n\n--- DISPATCH MANDATE ---\n\n" + (.prompt // "")))}}' \
    2>/dev/null) || { printf '{"continue":true}\n'; exit 0; }

[[ -z "$OUT" ]] && { printf '{"continue":true}\n'; exit 0; }
printf '%s\n' "$OUT"
exit 0
