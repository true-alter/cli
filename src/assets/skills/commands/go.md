---
description: Continue from a handover. Pick up the handover passed as args and execute it. With NO args, recover the most recent handover by reading the local handover store, then the session transcripts as a fallback. No copy/paste pointer needed.
---

# /go - Pick up a handover and continue

You are the new Claude Code session continuing the work described in a handover. Treat the handover as the authoritative pointer to where the previous session left off.

## You ARE the handover session

Running `/go` makes THIS session the executor of the handover - that is what `/go` means. Do not talk yourself out of that role:

- The session that **emitted** this handover (it ran `/handover`, or its transcript carries this same handover text) is your **predecessor** - the previous link in the chain. It will often still appear as an active session, sometimes still touching the very files the handover names, because those are the files it just finished. That is expected. It is not a competitor, and its presence is not a reason to stand down.
- A genuine **duplicate** is only another session that itself ran `/go` on this same handover. The claim step below is what detects that - not the mere presence of a sibling near the same files.
- Rule of thumb: a sibling on `/handover` (or whose recent work matches "What this session did") = predecessor, proceed. A sibling on `/go` for the same handover = duplicate, coordinate. Never abandon a handover just because a sibling appears.

## Handover

$ARGUMENTS

## Locate the handover

**If the `## Handover` section above contains a handover, use it directly** - skip to "What to do".

**If it is empty** - no pointer was pasted, e.g. the previous window was closed before copy/paste - recover it yourself. Do NOT ask the user to find it:

1. **Read the local handover store**, newest first. `/handover` writes emitted handovers here:
   ```
   for f in $(ls -t ~/.local/share/handovers/*.md 2>/dev/null | head -6); do printf '%s  ::  %s\n' "$(stat -c %y "$f" | cut -d. -f1)" "$(head -1 "$f")"; done
   ```
   If you have a doctrine or decision MCP tool connected, also list the newest handover entries there and reconcile by timestamp - the strictly newest entry across all stores wins. If several candidates are within minutes of each other, show topics + ages and ask which one via `AskUserQuestion`.

2. **Fallback - raw transcripts.** If the store is empty or every entry is stale, scan the session transcripts directly. Every handover ever emitted survives in one, even if it was never persisted:
   ```
   python3 - <<'EOF'
   import json, os, glob
   d = os.path.expanduser("~/.claude/projects/" + os.getcwd().replace("/", "-"))
   for f in sorted(glob.glob(d + "/*.jsonl"), key=os.path.getmtime, reverse=True)[:12]:
       try: lines = open(f, encoding="utf-8").read().splitlines()
       except Exception: continue
       for ln in reversed(lines):
           try: o = json.loads(ln)
           except Exception: continue
           if o.get("type") != "assistant": continue
           t = "".join(p.get("text","") for p in o.get("message",{}).get("content",[])
                       if isinstance(p, dict) and p.get("type") == "text")
           if "## What needs doing next" in t or "## What this session did" in t:
               print("=== " + os.path.basename(f) + " ===\n" + t[:4000] + "\n")
               break
   EOF
   ```
   Pick the transcript whose handover matches the work the user described; if ambiguous, ask via `AskUserQuestion`.

3. If nothing is found anywhere: stop and ask the user one line. Don't guess.

## Claim the handover

Once the handover is in hand, claim it - so a *second* `/go` on the same handover can tell it is a duplicate, and so this session can tell it is the legitimate executor. Set `SLUG` to a kebab-case form of the handover topic (e.g. `auth-refactor-p3`):

```bash
SLUG="<kebab-of-handover-topic>"
CLAIM=~/.local/share/handovers/claims/"$SLUG".claim
mkdir -p "$(dirname "$CLAIM")"
if [ -f "$CLAIM" ]; then
  age_min=$(( ( $(date +%s) - $(stat -c %Y "$CLAIM") ) / 60 ))
  echo "EXISTING CLAIM (age ${age_min}m):"; cat "$CLAIM"
else
  echo "NO EXISTING CLAIM - you are the handover session"
fi
```

- **No claim, or claim older than 720 min (12h), or `status: done`** -> stale or absent. You are the handover session. Write the claim and proceed.
- **Fresh claim (<12h, not done) naming a branch/worktree other than yours** -> a live `/go` already owns this handover. This is a real duplicate - surface it to the user via `AskUserQuestion` (continue in parallel / coordinate / stand down) before continuing. Do not silently refuse.

Write/refresh the claim once you have decided to proceed:

```bash
cat > "$CLAIM" <<EOF
handover: <handover title line>
claimed_at: $(date -Iseconds)
branch: <branch this session will work on>
status: working
EOF
```

## What to do

1. **Re-derive live state.** The handover is a pointer, not a snapshot. Before acting, hydrate context from live sources referenced in it:
   - Code refs (`file:line`, PR #) -> Read / `gh pr view`
   - Decision / doctrine refs -> search your decision register if you have one connected
   - Recent activity -> `git log --oneline -20` + `git status`
2. **Resolve the next-actions list.** Reconcile the handover's "What needs doing next" against current state - drop anything already shipped, sharpen anything stale. A recovered handover may be hours old; verify before acting.
3. **Plan, then execute.** Build a tight plan from the resolved next-actions and work it. If you have a planning or orchestration skill, hand off to it rather than re-deriving the plan inline.
4. **Report back** in a short synopsis + bullets, with the plan, before launching into multi-step work, unless the handover explicitly says "just go".

## Guardrails

- If a "next action" contradicts a locked rule in your project or global instructions, flag it inline and propose the correct path before continuing.
- Worktree rule: if any next-action targets a different branch from the active tree, propose `git worktree add` before checking out - never switch branches in a shared tree.
- Never auto-publish or auto-merge from `/go` - those remain explicit user invocations.
- A recovered handover is a pointer to a *past* state. Re-derive live state (step 1) is non-negotiable - never act on a stale handover without reconciling against `git log` first.
- The claim file is advisory, not a lock - the user may deliberately run two sessions in parallel. When a conflicting claim appears, surface it and let them decide; never silently drop a handover you were explicitly handed.
