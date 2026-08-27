---
description: On-demand audit of your lesson corpus - cluster acknowledged mistakes by root cause and surface any recurring class that has crystallised into a standing-rule candidate. Propose, never auto-adopt.
---

# /lessons-audit - lesson corpus audit

`$ARGUMENTS`

On-demand audit of your lesson corpus: the running record of mistakes you (or Claude Code) acknowledged, each captured with enough structure to cluster. Run it whenever you want to check whether a recurring failure class has crystallised into a standing-rule candidate.

This is the pull-when-wanted companion to whatever capture mechanism you use - a Stop hook, a habit of writing a lesson entry on every acknowledged error, or both. Capture is always-on; the audit runs only when invoked.

## The lesson entry shape

Each lesson should carry a small fixed schema so it can be clustered:

- **incident** - what went wrong, one line.
- **surfaced_by** - self-caught / user-surfaced / review-surfaced / CI-surfaced.
- **mechanism** - the verified reason it happened.
- **guard_gap** - why the guard that should have caught it didn't.
- **remediation** - what fixed it.
- **prevention** - where prevention was encoded (a hook / CI check / rule / note).
- **root_cause_class** - the clustering key: a short stable label for the underlying failure mode.

## What it does

1. **Read the corpus.** If you keep your lessons in a doctrine / decision MCP register, list and search every `lesson-*` entry across whatever scopes you use. Otherwise read them from wherever you keep them - a local notes file, a `lessons/` directory, or the project instruction files. The point is to gather every recorded lesson, not to require any one store.
2. **Cluster by `root_cause_class`.** Tally lesson entries per class - `root_cause_class` is the clustering key.
3. **For each class with ≥3 entries:** check whether a standing rule already covers that class. If not, draft a candidate rule (a proposed SOP, a new instruction-file rule, or a new guard) citing the clustered lesson labels. If one already covers it, record coverage instead - no duplicate proposal.
4. **Drain any staged-but-unwritten candidates.** If your capture mechanism stages raw candidates somewhere (e.g. a pending-lessons file), write each one up as a proper lesson entry with the full schema above, then clear the staging file.
5. **Report.** Every proposed rule and every coverage note, with the clustered lesson labels. **NEVER auto-adopt** - a proposal is for your ratification, not a live rule.

## Constraints

- **Local where it needs to be.** If the audit reads MCP tools that are local-stdio only, run it in a local session - a remote/cloud session cannot reach them. If you keep lessons in plain files, it runs anywhere.
- **Authenticated where it needs to be.** If proposing into a register is gated behind a signed-in identity, confirm you are signed in first (check the tool's own whoami/status, not just the presence of a credential file).
- **Inferred from corrected behaviour, never declared.** Lessons describe what actually changed, not aspirations.
- **Propose, never adopt.** A class reaching 3 produces a *proposed* rule for your ratification - not a live one.

## Cadence

On-demand. No timer required - the capture side is always-on; the audit is pull-when-wanted. If you want a nudge, have your session-start mechanism tally `root_cause_class` clusters and flag when any class reaches 3+ and has grown since you last ran the audit.

## Revision

Amendment-forward only.
