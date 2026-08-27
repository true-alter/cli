---
description: Emit a session-to-session handover under a strict token contract - a pointer, not a snapshot. Persists it locally so a fresh session picks it up with /go.
---

# /handover - Session-to-Session Pointer

Emit a handover prompt under a strict token contract: pointer, not snapshot. Target 1.5-3k chars, hard cap 4k. Skip anything the receiving session can re-derive from git, your connected tools, or your project's instruction files. This skill exists because unscoped handovers default to "dump everything" and cost far more than they need to.

$ARGUMENTS

## Prematurity check (mandatory, FIRST step every invocation)

Before emitting any handover output, observe the substrate to confirm `/handover` is actually appropriate. The check runs every invocation - including ones where the user explicitly typed `/handover` - because handover at the wrong moment costs the next session more than it saves this one (mid-stride work gets orphaned; deliverables get re-derived; the receiver picks up a half-baked pointer and has to back-fill anyway).

**Observations to make (parallel reads, every invocation):**

1. `git status --short` in the active working tree - uncommitted edits to existing files? Untracked files that look like in-flight drafts?
2. `gh pr list --state open --json number,title,mergeStateStatus,headRefName --limit 20` (if the repo uses GitHub) - any PRs from this session still queued, blocked on CI, or awaiting merge?
3. Recent tool activity within the last ~10 minutes (Edit / Write / Bash with git commit) - is the session mid-stride on a deliverable that hasn't reached a clean stopping point?
4. Context utilisation, if the harness reports it - is it actually high (>70%), or does the user just *think* it is?

**Premature signals (any one fires):**

- Uncommitted edits to existing files that are NOT themselves the handoff seed (a half-edited source file is mid-stride; a freshly-written design draft is a deliverable that can be handed off).
- One or more queued PRs from this session still resolving (`mergeStateStatus: BLOCKED` waiting on CI counts; the receiver inherits the wait).
- An in-flight design draft sketched in chat but not yet written to disk.
- Context utilisation below ~70% AND the user didn't say "long" / "save the context" / "wrap up".
- The receiver-session premise doesn't hold - e.g. the user is reading the chat directly and just typed `/handover` reflexively.

**Behaviour on prematurity:**

If any premature signal fires AND the user did not include an override phrase (`do it anyway`, `even so`, `force`, `--force`, `--anyway`, `regardless`), refuse with reason. Emit:

- One sentence on what's mid-stride.
- The observations that flagged it (one line each, ≤4 items).
- A short MC question (via `AskUserQuestion`) offering: *land the in-flight work first* (Recommended) / *handover with the work as a pointer* / *force-emit handover anyway* / *cancel*.

Do NOT emit a partial handover and ask afterward.

If all signals are clear OR an override phrase is present, proceed to the Output contract below.

## Output contract

```
# Handover - <session-topic> · <date>

## What this session did (≤5 lines)
- <landmark change 1>
- <landmark change 2>
...

## What needs doing next (≤5 lines, ordered)
1. <next-action-1 - with file path or ref>
2. ...

## Blockers / open loops (≤5 lines, omit section if empty)
- <blocker 1 - what and why>

## Pointers (MUST be refs, not content)
- Code: <file:line or PR #>
- Decision: <id or slug in your register, if you keep one>
```

**Caps:** target 1.5-3k chars, hard cap 4k. No code blocks pasted (ref the file). No full decision entries pasted (ref the id). No prior session narrative (the receiver can re-read it).

**Forbidden:**
- Commit logs (`git log` is live)
- File contents (Read is live)
- Long prose recaps or "summary of a great session" filler
- Emoji

## When to invoke

- User explicitly asks for a handover, continuation prompt, or next-session seed
- Context is close to the limit and work must continue in a fresh session
- Transferring work from one model tier to another where the next tier needs explicit framing

## When NOT to invoke

- User has not asked (handovers are never spontaneous)
- Context is fine and work continues this session
- The receiver is the user reading the chat directly - they already saw everything

## Persistence - write it yourself, in-turn

**The markdown body MUST be written to the local handover store by THIS skill, in-turn.** Do not rely on any Stop hook alone: a Stop hook fires after the turn ends and can race the transcript flush, so when the handover is the last thing a session emits the Stop can fire before the handover text is captured.

**Write step (run immediately after rendering the markdown block, BEFORE the closing line of the turn):**

```bash
mkdir -p ~/.local/share/handovers
# slug  = lowercase topic line, non-alphanum -> '-', collapsed, trimmed, ≤48 chars
# stamp = date +%Y-%m-%d-%H%M (local)
tmp=$(mktemp)
cat > "$tmp" <<'HANDOVER_MD'
<the exact markdown handover block, verbatim>
HANDOVER_MD
mv "$tmp" ~/.local/share/handovers/<stamp>-<slug>.md
```

After writing, tell the user in one line that the handover is saved and that a fresh session picks it up with `/go` (no arguments). The receiving session reads the newest store file; the raw session transcript is the last-resort fallback if the write ever fails.

If you keep a doctrine or decision MCP register connected, also persist a one-line pointer there so a session on another machine can recover it - but the local store above is the primary, always-available path.

## Why this matters

Unscoped handovers repeat what a fresh session can already re-derive (recent commits, open PRs, the project instruction files). That's pure redundancy. The cheapest-sufficient handover is a *pointer* to where the receiver can find detail - not the detail itself.

## Revision

Amendment-forward only.
