#!/usr/bin/env bash
# cc-handover-capture.sh - Stop hook: persist any emitted handover to disk.
#
# Triggered by: Stop (CC fires this after every assistant turn completes).
# Reads:        stdin JSON {session_id, transcript_path, ...} - CC hook shape.
# Does:         scans the last assistant text block of the transcript for a
#               handover (a `Handover` heading line + a handover body section);
#               if found, writes it to the local handover store as
#               <date>-<time>-<slug>-<hash8>.md. Content-hash dedup; keeps
#               the newest 40 files. If the handover carries a
#               `> Target session: <id>` line, ALSO drops an agent_handover
#               frame into the drop dir so the named session's
#               cc-agent-handover-poll.sh hook picks it up inline.
# Returns:      {"continue":true} unconditionally - best-effort, never blocks.
#
# Why this exists: /handover emits chat text only. Close the window before you
# copy it and the handover survives nowhere but the raw session transcript -
# recoverable only by hand-parsing JSONL. This hook makes every handover
# durable the instant it is emitted; `/go` with no arguments reads the newest
# stored handover to pick it up. Companion to cc-agent-handover.sh, which
# covers the compaction path only (PreCompact) - this covers the manual
# window-close path (Stop), which fires far more often.
#
# The hook reads the transcript (filesystem / stdin) and writes a file. It
# consults no cached narrative for truth. Capture is deterministic - emit a
# handover and it is on disk before the principal can close the window.
#
# Store: $ALTER_HANDOVER_DIR (default ~/.local/share/handovers). This is the
# same store `/handover` and `/go` use, so a Stop-captured handover is
# recoverable by `/go` with no arguments.
set -eo pipefail

LOG_DIR="${ALTER_LOG_DIR:-$HOME/.local/share/alter}"
LOG_FILE="$LOG_DIR/cc-handover-capture.log"
HANDOVER_DROP="${ALTER_AGENT_HANDOVER_DIR:-$HOME/.local/share/alter/agent-handovers}"

# Where captured handovers land. Set here so the name is always defined; the
# block below repoints it at the store this machine actually uses.
HANDOVER_STORE="${ALTER_HANDOVER_DIR:-$HOME/.local/share/handovers}"

mkdir -p "$LOG_DIR" "$HANDOVER_STORE" "$HANDOVER_DROP" 2>/dev/null || true

# Run rolling-class rotation at session-end cadence.
# Best-effort - failure is silent, never blocks Stop.
PRUNE_SCRIPT="$(dirname "$0")/log-prune.sh"
{
    [ -x "$PRUNE_SCRIPT" ] && bash "$PRUNE_SCRIPT" 2>/dev/null
} || true

# Best-effort contract: every path emits {"continue":true} and exits 0.
emit() { echo '{"continue":true}'; exit 0; }

if ! command -v python3 >/dev/null 2>&1; then
    printf '{"ts":"%s","event":"skip","reason":"no_python3"}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG_FILE" 2>/dev/null || true
    emit
fi

INPUT=$(cat 2>/dev/null || true)

# Pre-populate the shared Stop-chain tail cache so the Python script below can
# read from /dev/shm (or /tmp fallback) instead of re-tailing the transcript.
# This eliminates one of the repeated transcript reads per Stop event.
# Best-effort: the cache helper handles its own failure paths.
# shellcheck source=./_stop-cache.sh
source "$(dirname "$0")/_stop-cache.sh"
PRE_TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null)
PRE_SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)
if [ -n "$PRE_TRANSCRIPT_PATH" ] && [ -n "$PRE_SESSION_ID" ] && [ -f "$PRE_TRANSCRIPT_PATH" ]; then
    stop_cache_get_tail "$PRE_TRANSCRIPT_PATH" "$PRE_SESSION_ID" >/dev/null 2>&1 || true
fi

# The script reads the CC hook envelope from stdin, so it is passed via
# `python3 -c` (NOT a heredoc - that would claim stdin). No `$` or backticks
# appear in the body, so double-quoting under bash is safe.
PYSCRIPT=$(cat <<'PYEOF'
import sys, os, json, re, glob, hashlib, time


def out(event, reason="", fname=""):
    print(json.dumps({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "event": event, "reason": reason, "fname": fname,
    }))
    sys.exit(0)


handover_store = os.environ.get("ALTER_HANDOVER_DIR", "")
if not handover_store:
    out("skip", "no_handover_dir")

try:
    env = json.load(sys.stdin)
except Exception:
    out("skip", "bad_stdin")

session_id = "".join(
    c for c in str(env.get("session_id", "")) if c.isalnum() or c in "-_"
)
transcript = str(env.get("transcript_path", "") or "")

# Resolve the transcript: prefer the path the harness handed us; else glob the
# CC projects tree by session id.
if not transcript or not os.path.isfile(transcript):
    cands = []
    if session_id:
        cands = glob.glob(
            os.path.expanduser("~/.claude/projects/*/" + session_id + ".jsonl")
        )
    transcript = cands[0] if cands else ""
if not transcript or not os.path.isfile(transcript):
    out("skip", "no_transcript")

# Read the tail only - the last assistant message sits near the end and a
# handover is at most a few KB. 512 KiB is generous and bounds cost on the
# multi-MB transcripts long sessions accumulate.
#
# If the bash wrapper pre-populated the Stop-chain tail cache (via
# _stop-cache.sh stop_cache_get_tail), STOP_CACHE_TAIL_PATH points at the
# 524288-byte cache file. Reading that avoids a second tail-read of the
# transcript on this Stop event.
raw = ""
cache_path = os.environ.get("STOP_CACHE_TAIL_PATH", "")
if cache_path and os.path.isfile(cache_path):
    try:
        with open(cache_path, "rb") as fh:
            raw = fh.read().decode("utf-8", "replace")
    except Exception:
        raw = ""

if not raw:
    try:
        size = os.path.getsize(transcript)
        with open(transcript, "rb") as fh:
            if size > 524288:
                fh.seek(-524288, os.SEEK_END)
            raw = fh.read().decode("utf-8", "replace")
    except Exception:
        out("skip", "read_failed")

# Walk lines from the end for the last assistant text block.
text = ""
for line in reversed(raw.splitlines()):
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    if obj.get("type") != "assistant":
        continue
    parts = obj.get("message", {}).get("content", [])
    blocks = [
        p.get("text", "") for p in parts
        if isinstance(p, dict) and p.get("type") == "text"
    ]
    joined = "".join(blocks)
    if joined.strip():
        text = joined
        break

if not text:
    out("skip", "no_assistant_text")

# Two-signal handover detection: a `Handover` heading line AND a handover body
# section. Avoids capturing messages that merely mention the word in passing.
heading = None
for ln in text.splitlines():
    stripped = ln.strip().lstrip("#").strip().strip("`").strip()
    if re.match(r"^Handover\b", stripped):
        heading = ln
        break
if heading is None:
    out("skip", "no_handover_heading")
if ("## What needs doing next" not in text
        and "## What this session did" not in text):
    out("skip", "no_handover_body")

# Extract the block: from the heading line to the end, dropping a wrapping
# code fence (and anything after it) if the model emitted one.
lines = text.splitlines()
start = lines.index(heading)
block = lines[start:]
for i, ln in enumerate(block):
    if i > 0 and ln.strip().startswith("```"):
        block = block[:i]
        break
# Normalise the heading to a single leading '# '.
block[0] = "# " + block[0].strip().lstrip("#").strip().strip("`").strip()
body = "\n".join(block).strip() + "\n"

# Slug from the topic line: `# Handover, <topic> - <date>`. The comma is the
# canonical separator; the dash forms stay accepted unconditionally, because
# handovers already at rest in the store were written with a dash and this
# parser is what reads them back. The dash forms are spelled as escapes, not
# literal bytes, so a lexical scan of this file cannot confuse them with prose.
topic_match = re.search("Handover\\s*[\\u2014\\u2013,-]\\s*(.+)", block[0])
topic = topic_match.group(1) if topic_match else "handover"
topic = re.split(r"\s*[·•]\s*", topic)[0]      # drop the trailing date
slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")[:48] or "handover"

hash8 = hashlib.sha256(body.encode("utf-8")).hexdigest()[:8]

# Content-hash dedup - same handover already in the store -> nothing to do.
if glob.glob(os.path.join(handover_store, "*-" + hash8 + ".md")):
    out("noop", "already_captured")

stamp = time.strftime("%Y-%m-%d-%H%M", time.localtime())
fname = stamp + "-" + slug + "-" + hash8 + ".md"
fpath = os.path.join(handover_store, fname)

sess8 = (session_id or "unknown")[:8]
provenance = (
    "> Auto-captured from session " + sess8
    + " by cc-handover-capture Stop hook · "
    + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
)
final = block[0] + "\n\n" + provenance + "\n\n" + "\n".join(block[1:]).strip() + "\n"

try:
    with open(fpath, "w", encoding="utf-8") as fh:
        fh.write(final)
except Exception:
    out("skip", "write_failed")

# Prune: keep the newest 40 handovers, drop the rest.
try:
    stored = sorted(
        glob.glob(os.path.join(handover_store, "*.md")),
        key=os.path.getmtime, reverse=True,
    )
    for stale in stored[40:]:
        os.unlink(stale)
except Exception:
    pass

# --- Agent-handover frame ------------------------------------------------
# If the handover names a target session, also drop an agent_handover frame
# into the shared drop dir so that session's UserPromptSubmit poll hook
# (cc-agent-handover-poll.sh) picks it up inline - no /go, no copy/paste.
# Syntax, inside the handover block:  > Target session: <id>
#   <id> = a session id        -> directed; only that session consumes it
#   <id> in {any,broadcast,*}  -> broadcast; whichever session polls first
# No line -> stored-only (the default; behaviour unchanged).
drop_dir = os.environ.get("ALTER_AGENT_HANDOVER_DIR", "")
target = None
for ln in block:
    m = re.match(
        r"\s*>?\s*\*{0,2}\s*Target session\s*\*{0,2}\s*:\s*\*{0,2}\s*([^\s*]+)",
        ln, re.I,
    )
    if m:
        target = m.group(1).strip()
        break
if drop_dir and target is not None:
    if target.lower() in ("any", "broadcast", "all", "*", "none", "null"):
        tgt_val = None
    else:
        tgt_val = "".join(c for c in target if c.isalnum() or c in "-_") or None
    try:
        os.makedirs(drop_dir, exist_ok=True)
        dup = (glob.glob(os.path.join(drop_dir, "*-" + hash8 + ".json"))
               + glob.glob(os.path.join(drop_dir, "*-" + hash8 + ".json.consumed")))
        if not dup:
            frame = {
                "kind": "agent_handover",
                "from_session": session_id or "unknown",
                "target_session_id": tgt_val,
                "body_md": final,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "source": "cc-handover-capture",
            }
            frame_path = os.path.join(
                drop_dir, "{}-{}-{}.json".format(int(time.time()), sess8, hash8)
            )
            tmp_frame = frame_path + ".tmp"
            with open(tmp_frame, "w", encoding="utf-8") as fh:
                json.dump(frame, fh)
            os.rename(tmp_frame, frame_path)
    except Exception:
        pass  # best-effort - the store write already succeeded

out("captured", "", fname)
PYEOF
)

STATUS=$(
    printf '%s' "$INPUT" \
        | ALTER_HANDOVER_DIR="$HANDOVER_STORE" \
          ALTER_AGENT_HANDOVER_DIR="$HANDOVER_DROP" \
          STOP_CACHE_TAIL_PATH="${STOP_CACHE_TAIL_PATH:-}" \
          python3 -c "$PYSCRIPT" 2>/dev/null \
        || true
)

# Mirror the status line into the hook log; never block Stop.
[ -n "$STATUS" ] && printf '%s\n' "$STATUS" >>"$LOG_FILE" 2>/dev/null || true


emit
