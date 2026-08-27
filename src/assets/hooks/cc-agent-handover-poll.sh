#!/usr/bin/env bash
# cc-agent-handover-poll.sh - UserPromptSubmit hook: deliver inbound handovers.
#
# The receive half of the session-to-session handover channel.
# The emit halves are cc-handover-capture.sh (Stop hook - manual /handover,
# targeted via a `> Target session:` line) and cc-agent-handover.sh (PreCompact
# hook - auto, self-targeted pre-compaction snapshot). Both write
# `agent_handover` frames into a shared local drop dir; this hook is the single
# receiver that picks them up.
#
# Triggered by: UserPromptSubmit (every prompt).
# Reads:        stdin JSON {session_id, ...} - CC hook shape.
# Does:         scans the drop dir for unconsumed agent_handover frames whose
#               target_session_id matches this session_id (or is broadcast),
#               claims each one atomically (flock + rename, fire-once), and
#               injects the body as additionalContext.
# Returns:      {"continue":true} - plus hookSpecificOutput.additionalContext
#               when a handover was delivered. Best-effort; never blocks.
#
# Why this exists: a handover emitted in one session reaches another session
# only by copy/paste or by /go re-reading the local handover store. This hook
# closes the loop - address a handover at a session id and that session picks it
# up inline on its next prompt, no /go, no paste. CC sessions cannot be woken
# externally, so "inline" means the target session's next keystroke; that is an
# accepted limit, not a bug. The local handover store remains the durable
# fallback for handovers that name no target or whose target never returns.
#
# The hook reads the drop dir and a flock. It consults no cached narrative for
# truth. Delivery is fire-once - the atomic rename of the frame file is the
# claim; a frame is delivered to exactly one session.
#
# Drop dir: $ALTER_AGENT_HANDOVER_DIR (default ~/.local/share/alter/agent-handovers).
set -eo pipefail

LOG_DIR="${ALTER_LOG_DIR:-$HOME/.local/share/alter}"
LOG_FILE="$LOG_DIR/cc-agent-handover-poll.log"
DROP_DIR="${ALTER_AGENT_HANDOVER_DIR:-$HOME/.local/share/alter/agent-handovers}"
mkdir -p "$LOG_DIR" 2>/dev/null || true

# Best-effort contract: every path emits {"continue":true} and exits 0.
emit() { echo '{"continue":true}'; exit 0; }

command -v python3 >/dev/null 2>&1 || emit

# Second frame source, empty unless the block below turns it on. Defined here
# so every later reference resolves whether or not that block survives.
FRAMES=""
CLAIMS_DIR=""

# No frame source present -> nothing has ever been handed over, by any path.
# Cheapest possible no-op.
[ -d "$DROP_DIR" ] || [ -f "$FRAMES" ] || emit

INPUT=$(cat 2>/dev/null || true)

# The script reads the CC hook envelope from stdin, so it is passed via
# `python3 -c` (NOT a heredoc - that would claim stdin). No `$` or backticks
# appear in the body, so double-quoting under bash is safe.
PYSCRIPT=$(cat <<'PYEOF'
import sys, os, json, glob, time

# fcntl is POSIX-only. It guards the drop dir's critical section; the second
# frame source claims by atomic mkdir and needs no lock at all. On a host
# without fcntl (Windows Git Bash), degrade to the unlocked path rather than
# take the whole channel down with an ImportError: the rename and the mkdir are
# each atomic on their own, so fire-once still holds. The lock only reduces
# contention.
try:
    import fcntl
except Exception:
    fcntl = None


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.exit(0)


def log(event, **kw):
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event}
    rec.update(kw)
    sys.stderr.write(json.dumps(rec) + "\n")


drop_dir = os.environ.get("ALTER_AGENT_HANDOVER_DIR", "")
if not os.path.isdir(drop_dir):
    drop_dir = ""

frames_path = os.environ.get("ALTER_AGENT_FRAMES", "")
if not os.path.isfile(frames_path):
    frames_path = ""

claims_dir = os.environ.get("ALTER_AGENT_CLAIMS_DIR", "")

# No frame source -> nothing to drain from any path.
if not drop_dir and not frames_path:
    emit({"continue": True})

try:
    env = json.load(sys.stdin)
except Exception:
    emit({"continue": True})

session_id = "".join(
    c for c in str(env.get("session_id", "")) if c.isalnum() or c in "-_"
)
if not session_id:
    emit({"continue": True})

# A frame is "broadcast" when its target is empty / null / a wildcard token.
BROADCAST = {"", "any", "broadcast", "all", "*", "null", "none"}

# Annotation on a delivered frame's footer. Overridden below where the richer
# provenance-tagged form applies.
PROV_HANDOVER = "handover frame"

# Second frame source, off by default: no such cache exists in this build, so
# the drain is a no-op and the drop dir is the only path. Redefined below when
# the cache is present.
def drain_frame_cache(session_id):
    return []


def drain_dropdir(session_id):
    """Claim agent_handover frames from the local drop dir (fire-once rename)."""
    claimed = []
    lock_fd = None
    try:
        if fcntl is not None:
            lock_fd = os.open(os.path.join(drop_dir, ".poll.lock"),
                              os.O_CREAT | os.O_RDWR, 0o600)
            # Blocking exclusive lock. The critical section is a few file ops
            # over a <=40-file dir - microseconds. Only sibling poll hooks
            # contend, and the kernel releases the lock on process exit, so a
            # hook killed by its configured timeout cannot wedge the channel.
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
    except Exception:
        if lock_fd is not None:
            try:
                os.close(lock_fd)
            except Exception:
                pass
        return claimed

    try:
        # Oldest frame first - handovers deliver in the order they were emitted.
        frames = sorted(
            glob.glob(os.path.join(drop_dir, "*.json")),
            key=lambda p: os.path.getmtime(p),
        )
        for fp in frames:
            try:
                with open(fp, encoding="utf-8") as fh:
                    frame = json.load(fh)
            except Exception:
                continue
            if not isinstance(frame, dict) or frame.get("kind") != "agent_handover":
                continue
            tgt = frame.get("target_session_id")
            tgt_norm = "" if tgt is None else str(tgt).strip().lower()
            is_mine = tgt is not None and str(tgt).strip() == session_id
            is_broadcast = tgt_norm in BROADCAST
            if not (is_mine or is_broadcast):
                continue
            # Claim atomically - the rename IS the fire-once primitive. A frame
            # renamed to *.consumed is invisible to every other session.
            try:
                os.rename(fp, fp + ".consumed")
            except FileNotFoundError:
                continue
            except Exception:
                continue
            claimed.append({
                "from": (str(frame.get("from_session", "") or "?"))[:8],
                "body": str(frame.get("body_md", "") or ""),
                "created": str(frame.get("created_at", "") or ""),
                "source": str(frame.get("source", "") or ""),
                "broadcast": is_broadcast and not is_mine,
            })

        # Prune: consumed markers older than 24h, stale unclaimed frames older
        # than 7 days (the target session never returned - the local handover
        # store is the durable fallback for those, so dropping the frame loses
        # nothing).
        now = time.time()
        for cf in glob.glob(os.path.join(drop_dir, "*.json.consumed")):
            try:
                if now - os.path.getmtime(cf) > 86400:
                    os.unlink(cf)
            except Exception:
                pass
        for sf in glob.glob(os.path.join(drop_dir, "*.json")):
            try:
                if now - os.path.getmtime(sf) > 604800:
                    os.unlink(sf)
                    log("pruned_stale", file=os.path.basename(sf))
            except Exception:
                pass
    finally:
        try:
            if fcntl is not None and lock_fd is not None:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            if lock_fd is not None:
                os.close(lock_fd)
        except Exception:
            pass
    return claimed




claimed = drain_dropdir(session_id) if drop_dir else []
extra = drain_frame_cache(session_id)

if not claimed and not extra:
    emit({"continue": True})

# Build the additionalContext block. Capture-sourced frames are directives
# (a session deliberately handed this work along); PreCompact-sourced frames
# are recovered context (a session's own pre-compaction snapshot).
parts = []
for i, c in enumerate(claimed, 1):
    if c["source"] == "cc-agent-handover":
        intent = ("Pre-compaction snapshot recovered from a sibling session before "
                  "its last context compression. Treat as recovered context, not a "
                  "new directive.")
    else:
        intent = ("Directed agent handover addressed to your session. Pick this work "
                  "up now: re-derive live state first (git log, file reads, MCP "
                  "queries), then continue from where the handover points.")
    hdr = "Inbound agent handover" + (" [broadcast]" if c["broadcast"] else "")
    parts.append(
        "── {} ({}/{})\n{}\n\n{}\n\n"
        "{} from session {} · {}".format(
            hdr, i, len(claimed), intent, c["body"].strip(),
            PROV_HANDOVER, c["from"], c["created"] or "time unknown",
        )
    )


total = len(claimed) + len(extra)
log("delivered", dropdir=len(claimed), extra=len(extra), session=session_id)
emit({
    "continue": True,
    "systemMessage": "~alter · inbound agent handover ({})".format(total),
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": "\n\n".join(parts),
    },
})
PYEOF
)

OUT=$(
    printf '%s' "$INPUT" \
        | ALTER_AGENT_HANDOVER_DIR="$DROP_DIR" \
          ALTER_AGENT_FRAMES="$FRAMES" \
          ALTER_AGENT_CLAIMS_DIR="$CLAIMS_DIR" \
          python3 -c "$PYSCRIPT" 2>>"$LOG_FILE" \
        || true
)

# Pass the hook JSON straight through; fall back to a benign continue if the
# Python core produced nothing parseable.
case "$OUT" in
    '{'*) printf '%s\n' "$OUT" ;;
    *)    echo '{"continue":true}' ;;
esac
exit 0
