#!/usr/bin/env bash
# cc-lesson-capture.sh: Stop hook: stage an unlogged lesson candidate.
#
# Triggered by: Stop (CC fires this after every assistant turn completes).
# Reads:        stdin JSON {session_id, transcript_path, ...}, CC hook shape.
# Does:         scans the recent transcript for (a) a high-precision, FIRST-PERSON
#               error-acknowledgement in ASSISTANT TEXT, and (b) whether this
#               session already wrote a lesson-* note entry. If an error was
#               acknowledged and NO lesson-* write is present, it appends one
#               candidate record to cc-lessons-pending.jsonl so a future session
#               (prompted by session-lesson-reconcile.sh) can write the missed
#               lesson. Self-heals: if a lesson-* write IS present this session,
#               any prior candidate for the session is removed.
# Returns:      {"continue":true} unconditionally, best-effort, never blocks.
#
# Why this exists: the PRIMARY capture is writing the lesson in-session, the
# moment an error is acknowledged. This hook is the BACKSTOP for sessions that
# erred but forgot to log. It cannot write the entry itself, because the note
# store is reached only through a live tool session or an authenticated call, so
# it stages a local candidate a later session can turn into a proper entry,
# auth-free.
#
# Precision over recall (deliberate): false negatives are acceptable (the
# behavioural rule is primary); a false positive costs only one staged line a
# human reviews. Detection is restricted to assistant TEXT (not tool_use inputs,
# tool_results, or user prompts) and skips list/quote/fenced lines, so a session
# that merely DISCUSSES errors (like the one that built this hook) does not fire.
# Broad words ("error"/"mistake"/"flaw" alone) are NOT triggers, only
# first-person admissions are.
#
# Reads the transcript (stdin) and writes a local file. Consults no network
# source.
#
# Store: cc-lessons-pending.jsonl in $ALTER_LOG_DIR (default ~/.local/share/alter).
set -eo pipefail

LOG_DIR="${ALTER_LOG_DIR:-$HOME/.local/share/alter}"
LOG_FILE="$LOG_DIR/cc-lesson-capture.log"
PENDING="${ALTER_LESSONS_PENDING:-$LOG_DIR/cc-lessons-pending.jsonl}"
mkdir -p "$LOG_DIR" 2>/dev/null || true

# Best-effort contract: every path emits {"continue":true} and exits 0.
emit() { echo '{"continue":true}'; exit 0; }

if ! command -v python3 >/dev/null 2>&1; then
    printf '{"ts":"%s","event":"skip","reason":"no_python3"}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG_FILE" 2>/dev/null || true
    emit
fi

INPUT=$(cat 2>/dev/null || true)

# The script reads the CC hook envelope from stdin, so it is passed via
# `python3 -c` (NOT a heredoc, that would claim stdin). The PYSCRIPT heredoc is
# single-quoted, so no bash expansion happens inside it.
PYSCRIPT=$(cat <<'PYEOF'
import sys, os, json, re, glob, time

# fcntl is POSIX-only: it is absent on Windows Python (Git Bash users run the
# native interpreter). Without this guard the import raises, the whole script
# dies before it can stage anything, and the hook silently does nothing. The
# lock is best-effort serialisation, so a no-op stand-in is the right degrade.
try:
    import fcntl
except Exception:  # pragma: no cover - Windows
    class _NoFcntl(object):
        LOCK_EX = 0
        LOCK_UN = 0

        def flock(self, *_a, **_kw):
            return None

    fcntl = _NoFcntl()


def out(event, reason="", extra="", sid=""):
    # session_id is included so per-session rollups can key on it.
    print(json.dumps({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "session_id": sid,
        "event": event, "reason": reason, "extra": extra,
    }))
    sys.exit(0)


# Module-level session_id for rollup keying.
# Populated after stdin parse; empty string for early-exit paths before then.
session_id = ""

pending = os.environ.get("ALTER_LESSONS_PENDING", "")
if not pending:
    out("skip", "no_pending_path", sid=session_id)

try:
    env = json.load(sys.stdin)
except Exception:
    out("skip", "bad_stdin", sid=session_id)

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
    out("skip", "no_transcript", sid=session_id)

# Read up to the last 1 MiB, enough to hold the recent turns where an
# acknowledgement and its lesson-write co-reside. Stop fires every turn, so an
# ack is scanned on the Stop immediately following the turn it appeared in.
raw = ""
try:
    size = os.path.getsize(transcript)
    with open(transcript, "rb") as fh:
        if size > 1048576:
            fh.seek(-1048576, os.SEEK_END)
        raw = fh.read().decode("utf-8", "replace")
except Exception:
    out("skip", "read_failed", sid=session_id)

# High-precision FIRST-PERSON acknowledgement phrases. Broad words
# ("error"/"mistake"/"flaw" alone) are deliberately EXCLUDED, they appear in
# meta-discussion (this very hook's design talk) and would false-fire.
ACK = [
    r"i was wrong", r"i'?m wrong", r"my mistake", r"my error", r"my bad",
    r"i shouldn'?t have", r"i should not have", r"i caused",
    r"i missed", r"i made (?:a|an) (?:mistake|error)",
    r"that was (?:a|an) (?:mistake|error|regression) i\b",
    r"i introduced (?:a|an) (?:bug|regression|error)",
    r"i got that wrong", r"i misread", r"i overlooked",
]
# NOTE: bare affirmations ("good catch", "you're right") are deliberately
# EXCLUDED: they fire on benign agreement (the user correcting their own
# earlier statement and the model agreeing) and are not CC error admissions.
# A genuine acknowledgement almost always carries an explicit first-person
# admission above, which is what we match. (Security review 2026-06-04.)
ACK_RE = re.compile("(" + "|".join(ACK) + ")", re.I)
QUOTES = {'"', "'", "`"}


def matched_in_prose(line):
    s = line.strip()
    if not s:
        return None
    # list / quote / heading / fence / table lines are where phrase LISTS and
    # quoted examples live: exclude them to dodge the meta-discussion trap.
    if s[0] in "-*>#|" or s.startswith("```"):
        return None
    m = ACK_RE.search(line)
    if not m:
        return None
    i, j = m.start(1), m.end(1)
    before = line[i - 1] if i > 0 else ""
    after = line[j] if j < len(line) else ""
    # reject mid-word matches and quoted/backticked examples.
    if before and (before.isalnum() or before in QUOTES):
        return None
    if after in QUOTES:
        return None
    return m.group(1)


ack_phrase = None
ack_snippet = ""
lesson_logged = False

for line in raw.splitlines():
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    if obj.get("type") != "assistant":
        continue
    for p in obj.get("message", {}).get("content", []):
        if not isinstance(p, dict):
            continue
        ptype = p.get("type")
        if ptype == "text":
            if ack_phrase is None:
                for tl in p.get("text", "").splitlines():
                    hit = matched_in_prose(tl)
                    if hit:
                        ack_phrase = hit.lower()
                        ack_snippet = tl.strip()[:200]
                        break
        elif ptype == "tool_use":
            # A lesson-* write THIS session means capture already happened the
            # right way, so no candidate is needed (and any earlier one is
            # self-healed away). Matched on the write-tool name SHAPE rather
            # than one specific tool, so whichever note / doctrine / memory /
            # journal tool the session has connected is recognised.
            name = str(p.get("name", "")).lower()
            if any(k in name for k in ("doctrine", "note", "memory", "journal")):
                inp = p.get("input", {})
                if isinstance(inp, dict) and inp.get("action") == "write" \
                        and str(inp.get("slug", "")).startswith("lesson-"):
                    lesson_logged = True

# --- pending-file read-modify-write under an exclusive lock --------------
# Shared file across concurrent sessions' Stop hooks → fcntl.flock serialises.
if not os.path.exists(pending):
    try:
        open(pending, "a").close()
    except Exception:
        out("skip", "pending_create_failed", sid=session_id)
try:
    fd = open(pending, "r+")
except Exception:
    out("skip", "pending_open_failed", sid=session_id)


def read_rows(fh):
    fh.seek(0)
    rows = []
    for ln in fh.read().splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            rows.append(json.loads(ln))
        except Exception:
            continue
    return rows


def write_rows(fh, rows):
    fh.seek(0)
    fh.truncate()
    for r in rows:
        fh.write(json.dumps(r) + "\n")
    fh.flush()


try:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
    except Exception:
        pass
    rows = read_rows(fd)

    if lesson_logged:
        kept = [r for r in rows if r.get("session_id") != session_id]
        if len(kept) != len(rows):
            write_rows(fd, kept)
            out("noop", "logged_unstaged", sid=session_id)
        out("noop", "logged", sid=session_id)

    if ack_phrase is None:
        out("noop", "no_ack", sid=session_id)

    # one candidate per session (dedup; Stop fires every turn).
    if any(r.get("session_id") == session_id for r in rows):
        out("noop", "already_staged", sid=session_id)

    rows.append({
        "session_id": session_id or "unknown",
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "matched_phrase": ack_phrase,
        "snippet": ack_snippet,
        "transcript_path": transcript,
    })
    write_rows(fd, rows)
    out("staged", ack_phrase, sid=session_id)
finally:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    except Exception:
        pass
    try:
        fd.close()
    except Exception:
        pass
PYEOF
)

STATUS=$(
    printf '%s' "$INPUT" \
        | ALTER_LESSONS_PENDING="$PENDING" \
          python3 -c "$PYSCRIPT" 2>/dev/null \
        || true
)

# Mirror the status line into the hook log; never block Stop.
[ -n "$STATUS" ] && printf '%s\n' "$STATUS" >>"$LOG_FILE" 2>/dev/null || true
emit
