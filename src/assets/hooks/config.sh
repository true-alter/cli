#!/usr/bin/env bash
# config.sh: Shared configuration for all CC hooks.
# Source this in every hook: source "$(dirname "$0")/config.sh"

# ── GNU-binary presence, resolved once for every hook that sources this ──────
# `flock` (util-linux) and `timeout` (GNU coreutils) are both present on Linux
# and Windows Git Bash and both ABSENT on stock macOS. Every consumer needs the
# same answer, so it is computed once here and exported as a flag.
#
# DELIBERATELY A FLAG, NEVER A SHIM FUNCTION. The tempting fix is for this file
# to define no-op `flock()` / pass-through `timeout()` functions so that bare
# calls in hooks stop erroring on macOS. Do NOT do that here. `command -v` finds
# a shell function, so a shim defined in this file makes every consumer that
# probes `command -v flock` AFTER sourcing it believe the real binary is
# present. Several hooks use that probe to choose between real flock and a
# correct mkdir-lockdir emulation; a shim would silently swap their working
# mutual exclusion for a no-op, which is strictly worse than the error it was
# meant to avoid. A hook that wants a local shim must define it for itself,
# after its own probe.
CC_HAVE_FLOCK=0
command -v flock >/dev/null 2>&1 && CC_HAVE_FLOCK=1
CC_HAVE_TIMEOUT=0
command -v timeout >/dev/null 2>&1 && CC_HAVE_TIMEOUT=1

# Bound a command by wall clock when `timeout` exists, and run it plain when it
# does not. Used by the resolvers below so a missing GNU binary degrades to an
# unbounded call rather than to exit 127, without patching the `timeout` name
# itself for anyone else.
_cc_timeout() {
    if [ "$CC_HAVE_TIMEOUT" -eq 1 ]; then
        timeout "$@"
    else
        shift   # drop the duration
        "$@"
    fi
}

# Dynamic project root (works on any machine)
CC_PROJECT_ROOT="${CC_PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Session state directory (use /dev/shm if available for speed, fallback to /tmp).
# Honour caller-provided CC_STATE_BASE / CC_SPECIALIST_DIR overrides so tests
# (and exotic envs without /dev/shm write access) can redirect to a temp dir.
# NOTE: hooks that `set -u` source this file, so every read of an optionally-set
# var must use `${VAR:-}`, a bare `$CC_STATE_BASE` aborts the whole hook.
if [ -z "${CC_STATE_BASE:-}" ]; then
    if [ -d /dev/shm ]; then
        CC_STATE_BASE="/dev/shm/cc-sessions"
    else
        CC_STATE_BASE="/tmp/cc-sessions"
    fi
fi

if [ -z "${CC_SPECIALIST_DIR:-}" ]; then
    if [ -d /dev/shm ]; then
        CC_SPECIALIST_DIR="/dev/shm/claude-alter-specialists"
    else
        CC_SPECIALIST_DIR="/tmp/claude-alter-specialists"
    fi
fi

# Configurable timeouts
CC_IDLE_TIMEOUT="${CC_IDLE_TIMEOUT:-600}"           # 10 minutes
CC_SPECIALIST_WINDOW="${CC_SPECIALIST_WINDOW:-1800}" # 30 minutes

# Conflict-freshness window. A concurrent session counts as "alive" up to
# CC_IDLE_TIMEOUT, but asserting that two sessions are on the SAME FILE right
# now needs a much fresher signal, so that assertion is gated on this tighter
# window instead. 120s against the 600s idle timeout: a session silent for two
# minutes or more is treated as no longer on the file.
CC_CONFLICT_FRESH="${CC_CONFLICT_FRESH:-120}"        # 2 minutes

# ── Context-block size tier ────────────────────────────────────────────────
# Single knob controlling how much shared context the session-start and
# per-prompt injectors embed inline versus leave as a short pointer the model
# can dereference on demand. Ladder-shaped so moving a tier means changing ONE
# value: 0 = full inline blocks everywhere, 1 (default) = advisory blocks
# collapse to a compact reference line, 2 and 3 progressively shrink what stays
# inline. Each collapse degrades to its own tier-0 full text when the matching
# dereference is unavailable, so a miss never leaves a session without context.
# Sanitised to digits-only below so a garbage override lands on the default
# instead of tripping `set -e` on a numeric comparison.
CC_TOKEN_CUT_TIER_OVERRIDE=""

# Precedence: an explicit CC_TOKEN_CUT_TIER in the environment wins, then any
# live modifier resolved above, then the standing tier-1 default.
CC_TOKEN_CUT_TIER="${CC_TOKEN_CUT_TIER:-${CC_TOKEN_CUT_TIER_OVERRIDE:-1}}"
CC_TOKEN_CUT_TIER="$(printf '%s' "$CC_TOKEN_CUT_TIER" | tr -cd '0-9')"
[ -z "$CC_TOKEN_CUT_TIER" ] && CC_TOKEN_CUT_TIER=1

# Project hash for session isolation (md5sum on Linux, md5 on macOS, cksum fallback for Windows)
if command -v md5sum &>/dev/null; then
    CC_PROJECT_HASH=$(echo "${CC_PROJECT_ROOT}" | md5sum | cut -c1-8)
elif command -v md5 &>/dev/null; then
    CC_PROJECT_HASH=$(echo "${CC_PROJECT_ROOT}" | md5 -q | cut -c1-8)
else
    CC_PROJECT_HASH=$(echo "${CC_PROJECT_ROOT}" | cksum | cut -d' ' -f1)
fi
CC_STATUS_DIR="$CC_STATE_BASE/$CC_PROJECT_HASH"

# _cc_append_claims_line: append ONE envelope line to the session-claims JSONL
# under an exclusive lock. Args: kind label (for the skip log), session id, line.
# Returns 0 when the line was written, 1 when it was deliberately dropped.
#
# THE TWO EMITTERS SHARE THIS ON PURPOSE. session_claim and session_release each
# carried their own byte-identical copy of this block, and when the claim copy was
# repaired the release copy was left behind, so a no-flock host wrote claims that
# were never released. One body, two callers, no twin to forget.
#
# WHERE flock IS ABSENT (Windows Git Bash, stock macOS) this used to take the
# early return and drop the row, logging reason "flock_timeout". That is not a
# timeout, it is a missing binary, and the consequence was not a slow write but NO
# write: every session on such a host was invisible to every other session,
# permanently, while the log said something that reads like transient contention.
#
# Where flock exists, behaviour is byte-identical to before, including interop
# with any concurrent reader's fcntl lock on the same path. Where it does not, an
# atomic mkdir lock guards the append. That fallback does not interoperate with an
# fcntl lock, which is the honest trade: the alternative on those hosts is not a
# safer write, it is no write at all.
#
# The branch below reads $CC_HAVE_FLOCK, not `command -v flock`: the shim at the
# top of this file defines a no-op `flock` FUNCTION on hosts without the binary,
# which `command -v` would report as present and which would silently select the
# unlocked path while claiming to have locked.
_cc_append_claims_line() {
    local kind="$1" session_id="$2" line="$3"
    local claims_lock lock_held=0

    if ! exec 203>>"$SESSION_CLAIMS_JSONL"; then
        _cc_log_session_claim_skip "$kind" "open_failed" "$session_id"
        return 1
    fi

    if [ "${CC_HAVE_FLOCK:-0}" -eq 1 ]; then
        if ! flock -x -w 2 203; then
            exec 203>&-
            _cc_log_session_claim_skip "$kind" "flock_timeout" "$session_id"
            return 1
        fi
        printf '%s\n' "$line" >&203
        flock -u 203 2>/dev/null || true
        exec 203>&-
        return 0
    fi

    claims_lock="${SESSION_CLAIMS_JSONL}.lock"
    # Bounded spin, about 2s, matching the flock -w 2 above.
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        if mkdir "$claims_lock" 2>/dev/null; then lock_held=1; break; fi
        sleep 0.1 2>/dev/null || sleep 1
    done
    if [ "$lock_held" -eq 1 ]; then
        printf '%s\n' "$line" >&203
        exec 203>&-
        rmdir "$claims_lock" 2>/dev/null || true
        return 0
    fi
    # Contended for the full window. A single line under PIPE_BUF on an O_APPEND
    # fd is atomic on POSIX, so writing unlocked risks far less than dropping the
    # row and going invisible does.
    printf '%s\n' "$line" >&203
    exec 203>&-
    _cc_log_session_claim_skip "$kind" "lock_contended_wrote_anyway" "$session_id"
    return 0
}

# _cc_sha256: portable sha256, hex on stdout. With an argument, digests that
# FILE; with none, digests STDIN.
#
# `sha256sum` is GNU coreutils: present on Linux and Windows Git Bash, absent on
# stock macOS, which ships `shasum`. The three-way fallback for CC_PROJECT_HASH
# directly above got this right; the sha256 call sites scattered across the hooks
# did not, and each silently produced an EMPTY digest on macOS. An empty digest
# does not error, it collides: every key derived from one becomes the same key,
# so caches, dedup markers and idempotency latches all fold into a single bucket
# and quietly stop distinguishing anything.
_cc_sha256() {
    if [ "$#" -gt 0 ]; then
        if command -v sha256sum >/dev/null 2>&1; then
            sha256sum "$1" 2>/dev/null | awk '{print $1}'
        elif command -v shasum >/dev/null 2>&1; then
            shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
        fi
    else
        if command -v sha256sum >/dev/null 2>&1; then
            sha256sum 2>/dev/null | awk '{print $1}'
        elif command -v shasum >/dev/null 2>&1; then
            shasum -a 256 2>/dev/null | awk '{print $1}'
        fi
    fi
}


# ── Active-sessions JSONL dual-write ───────────────────────────────────────
# Tool-neutral session lifecycle envelopes written alongside the legacy
# /dev/shm/cc-sessions/<sid>.json file, to a local session-activity log other
# tools can read. A concurrent reader may take an fcntl lock on this same file,
# so the bash-side `flock` against the file FD must be cross-compatible.
if [ -z "${ACTIVE_SESSIONS_JSONL:-}" ]; then
    if [ -n "${ALTER_ACTIVE_SESSIONS_PATH:-}" ]; then
        ACTIVE_SESSIONS_JSONL="$ALTER_ACTIVE_SESSIONS_PATH"
    else
        _xdg_data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
        ACTIVE_SESSIONS_JSONL="$_xdg_data_home/alter-runtime/active-sessions.jsonl"
    fi
fi

# ── Session-claim stream, SEPARATE from the file above ─────────────────────
# session_claim and session_release envelopes carry a `payload` body and no
# `started_at`. active-sessions.jsonl carries a different record class
# (session_started / session_heartbeat / session_ended, flat, no payload).
#
# The two classes shared one file until a reader that validates exactly one of
# them started rejecting the other and skipping past it, so every claim was
# dropped, permanently and silently. Two record classes in one append-only file
# is the defect; one file per class is the fix. Claims get their own stream
# here, and a reader after live sessions reads THIS file.
if [ -z "${SESSION_CLAIMS_JSONL:-}" ]; then
    if [ -n "${ALTER_SESSION_CLAIMS_PATH:-}" ]; then
        SESSION_CLAIMS_JSONL="$ALTER_SESSION_CLAIMS_PATH"
    else
        _xdg_data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
        SESSION_CLAIMS_JSONL="$_xdg_data_home/alter-runtime/session-claims.jsonl"
    fi
fi

# Observability log for JSONL emit skips/failures. Same default location as
# session-summary.log so all hook diagnostics live in one place.
ACTIVE_SESSIONS_EMIT_LOG="${ALTER_LOG_DIR:-$HOME/.local/share/alter}/active-sessions-emit.log"

# _cc_machine_id: stable per-host fingerprint cached on first call.
# Linux: sha256-trunc-16 of /etc/machine-id (or /var/lib/dbus/machine-id).
# macOS: IOPlatformUUID via ioreg. Final fallback: hostname.
# Cached in $CC_STATE_BASE/.machine-id so we hit disk once per machine.
_cc_machine_id() {
    local cache="$CC_STATE_BASE/.machine-id"
    if [ -f "$cache" ]; then
        cat "$cache" 2>/dev/null && return 0
    fi
    local raw=""
    if [ -r /etc/machine-id ]; then
        raw=$(cat /etc/machine-id 2>/dev/null)
    elif [ -r /var/lib/dbus/machine-id ]; then
        raw=$(cat /var/lib/dbus/machine-id 2>/dev/null)
    elif command -v ioreg &>/dev/null; then
        raw=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null \
            | awk -F'"' '/IOPlatformUUID/ {print $4; exit}')
    fi
    if [ -z "$raw" ]; then
        raw=$(hostname 2>/dev/null || echo "unknown-host")
    fi
    local hashed
    if command -v sha256sum &>/dev/null; then
        hashed=$(printf '%s' "$raw" | sha256sum | cut -c1-16)
    elif command -v shasum &>/dev/null; then
        hashed=$(printf '%s' "$raw" | shasum -a 256 | cut -c1-16)
    else
        hashed="${raw:0:16}"
    fi
    mkdir -p "$CC_STATE_BASE" 2>/dev/null || true
    printf '%s' "$hashed" > "$cache" 2>/dev/null || true
    printf '%s' "$hashed"
}

# _cc_active_session_uuid: fresh UUIDv4 per envelope. uuidgen preferred;
# /proc/sys/kernel/random/uuid fallback for stripped containers; final
# fallback synthesises from /dev/urandom (still uuid-shape).
_cc_active_session_uuid() {
    if command -v uuidgen &>/dev/null; then
        uuidgen | tr 'A-Z' 'a-z'
        return 0
    fi
    if [ -r /proc/sys/kernel/random/uuid ]; then
        cat /proc/sys/kernel/random/uuid
        return 0
    fi
    # Last-resort: synthesise from /dev/urandom (RFC4122 v4 layout).
    local hex
    hex=$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
    printf '%s-%s-4%s-%s-%s\n' \
        "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" \
        "${hex:16:4}" "${hex:20:12}"
}

# _cc_record_version: monotonic per-session_id version counter. Sidecar
# at $STATUS_FILE.ver, incremented under the SAME flock as the legacy
# /dev/shm write so concurrent hook invocations cannot tear the sequence.
# Caller passes $STATUS_FILE. Starts at 0; returns the value to use for
# THIS envelope and stores (value+1) for the next call.
_cc_record_version() {
    local status_file="$1"
    local ver_file="${status_file}.ver"
    local current=0
    if [ -f "$ver_file" ]; then
        current=$(cat "$ver_file" 2>/dev/null || echo 0)
        # Sanitise: non-integer content resets to 0.
        case "$current" in
            ''|*[!0-9]*) current=0 ;;
        esac
    fi
    printf '%s\n' "$((current + 1))" > "$ver_file.tmp" \
        && mv "$ver_file.tmp" "$ver_file" 2>/dev/null || true
    printf '%s' "$current"
}

# ── session_claim / session_release emitters (cross-session coordination) ───
# Every CC session announces a session_claim envelope at session-start,
# refreshes it on a TTL-third cadence (claim_ttl_ms=90000, so every 30s), and
# emits one final session_release on Stop. The envelopes ride
# $SESSION_CLAIMS_JSONL, their own stream, on the same lock substrate a reader
# dedupes against.
#
# These helpers ride the EXISTING emit chain, with no new emit primitive: they
# reuse the shared emit_jsonl() helper the session hooks already provide.
#
# Refresh cadence is tracked per session_id in a sidecar file
# $STATUS_FILE.last-claim holding the epoch seconds of the last successful
# claim emission. Callers invoke _cc_session_claim_should_refresh first; if
# it returns 0 (=yes) they call _cc_emit_session_claim. Refresh-skip is the
# common case (1 emit per 30s; many hook invocations per second on a busy
# session).

# _cc_session_claim_should_refresh: returns 0 when the last-claim sidecar
# is missing or older than $CC_SESSION_CLAIM_REFRESH_SEC (default 30). The
# claim TTL is 90s; refresh-at-third-life leaves 60s headroom
# for hook misses (paused session, slow disk, etc.) before the daemon's
# janitor sweep reaps the claim.
CC_SESSION_CLAIM_REFRESH_SEC="${CC_SESSION_CLAIM_REFRESH_SEC:-30}"

_cc_session_claim_should_refresh() {
    local status_file="$1"
    local marker="${status_file}.last-claim"
    [ -f "$marker" ] || return 0
    local now stamp age
    now=$(date +%s)
    stamp=$(cat "$marker" 2>/dev/null || echo 0)
    case "$stamp" in
        ''|*[!0-9]*) return 0 ;;
    esac
    age=$(( now - stamp ))
    [ "$age" -ge "$CC_SESSION_CLAIM_REFRESH_SEC" ]
}

# _cc_session_claim_mark_refreshed: record the epoch of a successful claim
# emit so subsequent hook invocations within the refresh window skip.
_cc_session_claim_mark_refreshed() {
    local status_file="$1"
    local marker="${status_file}.last-claim"
    date +%s > "$marker.tmp" 2>/dev/null && mv "$marker.tmp" "$marker" 2>/dev/null || true
}

# _cc_emit_session_claim: write one session_claim envelope to the
# session-claims JSONL stream. Idempotency is the caller's
# responsibility (use _cc_session_claim_should_refresh as the gate). Silent
# on every failure path, because the hook NEVER blocks CC on emit issues.
#
# Args:
#   $1  session_id  , stable CC session_id (stable for the run)
#   $2  status_file , path to /dev/shm/cc-sessions/<sid>.json (used for
#                      working_on / version sidecar)
#
# Reads (when present):
#   ~/.config/alter/session.json  → handle, consent_tier
#   $status_file                   → working_on
#   $CLAUDE_MODEL env              → model id, mapped to instrument shape
#   git branch via $PWD            → branch
#
# Top-level envelope keys match the
# active-sessions schema (id / version / kind / handle / tool / session_id /
# machine_id / started_at / last_activity / consent_tier) so the daemon's line
# parser doesn't choke on the new kind.
#
# That mirroring was chosen for ONE consumer, the daemon's parser, and it does
# not make this record a session record: it adds `payload` and omits
# `started_at`, so the DO's sessions validator rejects it 400. Shape-matching an
# envelope to one reader is not the same as belonging to that reader's stream.
# The envelope is unchanged here; only its destination is. It goes to
# $SESSION_CLAIMS_JSONL, which no session-route publisher reads.
_cc_emit_session_claim() {
    local session_id="$1"
    local status_file="$2"
    [ -z "$session_id" ] && return 0

    command -v jq &>/dev/null || return 0

    local _sess_json
    _sess_json=$(_cc_session_info_cached "$session_id" 2>/dev/null) || _sess_json=""
    local handle=""
    handle=$(printf '%s' "$_sess_json" | jq -r '.handle // ""' 2>/dev/null || true)
    if [ -z "$handle" ] || [ "$handle" = "null" ]; then
        _cc_log_session_claim_skip "session_claim" "no_handle" "$session_id"
        return 0
    fi
    # active-sessions JSONL schema requires the ~-prefixed handle form
    # (^~[a-z0-9_-]+$); the resolver emits bare. Re-prefix exactly one ~.
    handle="~${handle#\~}"

    local consent_tier
    local _tier_label
    _tier_label=$(printf '%s' "$_sess_json" | jq -r '.tier // ""' 2>/dev/null || true)
    case "$_tier_label" in
        L1) consent_tier=1 ;;
        L2) consent_tier=2 ;;
        L3) consent_tier=3 ;;
        L4) consent_tier=4 ;;
        *)  consent_tier=2 ;;
    esac

    local iso_now
    iso_now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Instrument label for the Drafted-With trailer shape. $CLAUDE_MODEL is set by
    # the CC harness when available; fall back to "cc-unknown" so the wire
    # contract is always populated.
    local instrument="${CLAUDE_MODEL:-}"
    if [ -z "$instrument" ]; then
        instrument="cc-unknown"
    else
        # Strip a leading "claude-" prefix if present; collapse to lower-kebab.
        instrument="cc-${instrument#claude-}"
    fi

    local working_on=""
    if [ -f "$status_file" ]; then
        working_on=$(jq -r '.working_on // empty' "$status_file" 2>/dev/null)
    fi

    local branch=""
    branch=$(git -C "$PWD" branch --show-current 2>/dev/null || echo "")

    local machine_id env_id version
    machine_id=$(_cc_machine_id)
    env_id=$(_cc_active_session_uuid)
    version=$(_cc_record_version "$status_file")

    # claim_ttl_ms default (90s).
    local claim_ttl_ms="${CC_SESSION_CLAIM_TTL_MS:-90000}"

    local line
    line=$(jq -nc \
        --arg id "$env_id" \
        --argjson version "$version" \
        --arg handle "$handle" \
        --arg session_id "$session_id" \
        --arg machine_id "$machine_id" \
        --arg instrument "$instrument" \
        --arg working_on "$working_on" \
        --arg branch "$branch" \
        --arg working_directory "$PWD" \
        --arg claimed_at "$iso_now" \
        --argjson claim_ttl_ms "$claim_ttl_ms" \
        --argjson consent_tier "$consent_tier" \
        '{
            id: $id,
            version: $version,
            kind: "session_claim",
            handle: $handle,
            tool: "cc",
            session_id: $session_id,
            machine_id: $machine_id,
            last_activity: $claimed_at,
            status: "active",
            provenance_class: "active_composition",
            consent_tier: $consent_tier,
            payload: {
                session_id: $session_id,
                instrument: $instrument,
                tool: "cc",
                machine_id: $machine_id,
                working_on: ($working_on | if . == "" then null else . end),
                branch: ($branch | if . == "" then null else . end),
                working_directory: $working_directory,
                claimed_at: $claimed_at,
                claim_ttl_ms: $claim_ttl_ms,
                accepts: ["link", "text", "image", "audio", "file"]
            }
        }' 2>/dev/null)

    if [ -z "$line" ]; then
        _cc_log_session_claim_skip "session_claim" "jq_build_failed" "$session_id"
        return 0
    fi

    mkdir -p "$(dirname "$SESSION_CLAIMS_JSONL")" 2>/dev/null || true

    _cc_append_claims_line "session_claim" "$session_id" "$line" || return 0

    _cc_session_claim_mark_refreshed "$status_file"
}

# _cc_emit_session_release: write one session_release envelope on Stop.
# Idempotent at the caller layer (Stop fires once per run); a second emit
# is harmless beyond a duplicate row.
#
# Args:
#   $1  session_id
#   $2  status_file
_cc_emit_session_release() {
    local session_id="$1"
    local status_file="$2"
    [ -z "$session_id" ] && return 0

    command -v jq &>/dev/null || return 0

    local _sess_json
    _sess_json=$(_cc_session_info_cached "$session_id" 2>/dev/null) || _sess_json=""
    local handle=""
    handle=$(printf '%s' "$_sess_json" | jq -r '.handle // ""' 2>/dev/null || true)
    if [ -z "$handle" ] || [ "$handle" = "null" ]; then
        _cc_log_session_claim_skip "session_release" "no_handle" "$session_id"
        return 0
    fi
    # active-sessions JSONL schema requires the ~-prefixed handle form
    # (^~[a-z0-9_-]+$); the resolver emits bare. Re-prefix exactly one ~.
    handle="~${handle#\~}"

    local consent_tier
    local _tier_label
    _tier_label=$(printf '%s' "$_sess_json" | jq -r '.tier // ""' 2>/dev/null || true)
    case "$_tier_label" in
        L1) consent_tier=1 ;;
        L2) consent_tier=2 ;;
        L3) consent_tier=3 ;;
        L4) consent_tier=4 ;;
        *)  consent_tier=2 ;;
    esac

    local iso_now
    iso_now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    local instrument="${CLAUDE_MODEL:-}"
    if [ -z "$instrument" ]; then
        instrument="cc-unknown"
    else
        instrument="cc-${instrument#claude-}"
    fi

    local machine_id env_id version
    machine_id=$(_cc_machine_id)
    env_id=$(_cc_active_session_uuid)
    version=$(_cc_record_version "$status_file")

    local line
    line=$(jq -nc \
        --arg id "$env_id" \
        --argjson version "$version" \
        --arg handle "$handle" \
        --arg session_id "$session_id" \
        --arg machine_id "$machine_id" \
        --arg instrument "$instrument" \
        --arg released_at "$iso_now" \
        --argjson consent_tier "$consent_tier" \
        '{
            id: $id,
            version: $version,
            kind: "session_release",
            handle: $handle,
            tool: "cc",
            session_id: $session_id,
            machine_id: $machine_id,
            last_activity: $released_at,
            status: "complete",
            provenance_class: "active_composition",
            consent_tier: $consent_tier,
            payload: {
                session_id: $session_id,
                instrument: $instrument,
                released_at: $released_at
            }
        }' 2>/dev/null)

    if [ -z "$line" ]; then
        _cc_log_session_claim_skip "session_release" "jq_build_failed" "$session_id"
        return 0
    fi

    mkdir -p "$(dirname "$SESSION_CLAIMS_JSONL")" 2>/dev/null || true

    _cc_append_claims_line "session_release" "$session_id" "$line" || return 0
}

# _cc_log_session_claim_skip: one-line JSON observability record per skip.
# Mirrors the shape used by cc-broadcast.sh's _log_emit_skip so all hook
# emit diagnostics live in the same log.
_cc_log_session_claim_skip() {
    local kind="$1"
    local reason="$2"
    local sid="$3"
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    mkdir -p "$(dirname "$ACTIVE_SESSIONS_EMIT_LOG")" 2>/dev/null || true
    printf '{"ts":"%s","event":"skip","reason":"%s","kind":"%s","session":"%s"}\n' \
        "$ts" "$reason" "$kind" "${sid:-}" \
        >>"$ACTIVE_SESSIONS_EMIT_LOG" 2>/dev/null || true
}

# ── Content-addressed session-brief gating ──────────────────────────────────
# Shared primitive for the session-start-class injectors (the various brief
# blocks injected once at session start). Replaces the buggy `$PPID`
# once-per-session marker: $PPID is the ephemeral hook-wrapper shell and rotates
# every invocation, so the marker never matched its own prior file and the SAME
# block re-injected on EVERY prompt. The fix keys on the stable session_id from
# the hook's stdin JSON and gates on a CONTENT HASH, a block is emitted on the
# first prompt of a session AND whenever its content changes, and is silent on
# every prompt where the content is unchanged. This preserves freshness (a
# changed queue re-surfaces immediately) while eliminating the per-turn re-paste
# of identical blocks. Mirrors session-context.sh's session_id idiom and
# cc-inbox-poll.sh's watermark idiom.

# _cc_resolve_session_id <input-json>: echo a stable per-session id.
# session_id (stable for the whole CC run) → tx-<md5 transcript_path> →
# last-resort pid-$PPID (degenerate, but never worse than the prior bug).
_cc_resolve_session_id() {
    local input="${1:-}" sid=""
    sid=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null | tr -cd 'a-zA-Z0-9_-')
    if [ -z "$sid" ]; then
        local tx
        tx=$(printf '%s' "$input" | jq -r '.transcript_path // ""' 2>/dev/null)
        if [ -n "$tx" ] && command -v md5sum &>/dev/null; then
            sid="tx-$(printf '%s' "$tx" | md5sum | cut -c1-12)"
        else
            sid="pid-$PPID"
        fi
    fi
    printf '%s' "$sid"
}

# _cc_brief_should_emit <key> <session-id> <content>: returns 0 (emit) when
# this content is new to the session (no marker) or has changed since the last
# emit; returns 1 (skip) when identical. Records the new hash on every 0. The
# marker stores the hash of the LAST content seen (including the empty string),
# so empty→non-empty and changed→changed both re-surface while unchanged
# (including empty→empty) stays silent. NEVER call bare under `set -e`, always
# use it as an `if` condition, since the skip path returns non-zero by design.
_cc_brief_should_emit() {
    local key="${1:-}" sid="${2:-}" content="${3:-}"
    [ -z "$key" ] && return 0
    mkdir -p "$CC_STATUS_DIR" 2>/dev/null || true
    local marker="$CC_STATUS_DIR/brief-${key}-${sid}.hash"
    local newhash oldhash=""
    if command -v md5sum &>/dev/null; then
        newhash=$(printf '%s' "$content" | md5sum | cut -c1-16)
    else
        newhash=$(printf '%s' "$content" | cksum | tr -d ' ')
    fi
    [ -f "$marker" ] && oldhash=$(cat "$marker" 2>/dev/null || true)
    if [ "$newhash" = "$oldhash" ]; then
        return 1
    fi
    printf '%s' "$newhash" > "$marker.tmp" 2>/dev/null \
        && mv "$marker.tmp" "$marker" 2>/dev/null || true
    return 0
}

# ── Owner member_id resolution ─────────────────────────────────────────────
# resolve_owner_member_id: echo the caller's authoritative owner key.
#
# CORRECTNESS LINCHPIN: session.json's `user_id` is the
# User PK, NOT members.id. The owner key is `member_id` (= the minted key's
# APIKey.delegated_member_id, surfaced on MemberKeyResponse.member_id and
# persisted into session.json by the CLI login flow). It is NULL for admin /
# unlinked keys. This resolver reads `member_id` ONLY, it NEVER falls back to
# `user_id`, which would silently key the projection on the wrong identity and
# produce a wrong/empty result.
#
# Resolution order:
#   1. ~/.config/alter/session.json `.member_id` (the CLI persists it here)
#   2. LIVING_STATE_OWNER_MEMBER_ID env (back-compat for shells / CI that
#      set the owner explicitly before the CLI binding lands)
# Emits nothing (empty string, return 1) when neither is set or the value is
# the all-zeros placeholder, and callers degrade silently.
resolve_owner_member_id() {
    local owner=""

    # Primary: resolve via the shared session resolver (enc store preferred,
    # legacy session.json fallback). Extracts member_id from the contract object.
    if command -v jq &>/dev/null; then
        local _rom_sess
        _rom_sess=$(resolve_alter_session_json 2>/dev/null) || _rom_sess=""
        if [ -n "$_rom_sess" ]; then
            owner=$(printf '%s' "$_rom_sess" | jq -r '.member_id // ""' 2>/dev/null || true)
        fi
    fi

    if [ -z "$owner" ] || [ "$owner" = "null" ]; then
        owner="${LIVING_STATE_OWNER_MEMBER_ID:-}"
    fi

    if [ -z "$owner" ] \
        || [ "$owner" = "null" ] \
        || [ "$owner" = "00000000-0000-0000-0000-000000000000" ]; then
        return 1
    fi

    printf '%s' "$owner"
}

# ── ALTER session resolver (enc-store migration) ───────────────────────────
# resolve_alter_session_json: emit one JSON object with EXACTLY these keys:
#   handle, tier, org, trust, domain, email, member_id, session_id,
#   authenticated, expired
#
# Resolution order (one 2s budget across ALL attempts, never blocks):
#   a) `alter whoami --json`, preferred: emits the full contract object
#   b) `alter whoami` (human line), parse the pipe-delimited first line:
#        "~example | L4 | truealter.com (trusted/engineering) | you@example.com"
#      fills handle/tier/org/trust/domain/email; member_id/session_id empty.
#   c) Legacy ~/.config/alter/session.json, read with jq; maps the fields
#      that exist in the old plaintext file (handle, consent_tier→tier,
#      member_id, email).
#   d) All-empty contract object with authenticated=false.
#
# The emitted JSON always conforms to the shared field contract regardless
# of which path succeeded. Callers extract the specific field they need.
#
# Sourceable by any hook that already sources config.sh.
resolve_alter_session_json() {
    local session_file="$HOME/.config/alter/session.json"

    # One wall-clock budget for the WHOLE resolution, shared by every CLI
    # attempt below. Every registered caller allows this function 3s or less
    # (see the hook registration), and paths (a) and (b) run in sequence, so a
    # per-attempt cap lets them outlive the hook ceiling together. The kill
    # then lands mid-resolve and the caller emits nothing at all: the hook
    # reads as having found no session rather than as having been killed.
    # `timeout` is GNU-only and absent on stock macOS; without it an attempt is
    # unbounded, so skip the CLI paths entirely and fall through to the file.
    local _budget="${ALTER_SESSION_RESOLVE_BUDGET:-2}"
    local _deadline=$(( SECONDS + _budget ))
    local _left=0
    local _have_timeout="${CC_HAVE_TIMEOUT:-0}"

    # ── Path (a): alter whoami --json ──────────────────────────────────────
    _left=$(( _deadline - SECONDS ))
    if [ "$_have_timeout" -eq 1 ] && [ "$_left" -gt 0 ] \
       && command -v alter >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
        local json_out
        json_out=$(timeout "$_left" alter whoami --json 2>/dev/null || true)
        if [ -n "$json_out" ]; then
            # Validate: must parse as JSON with a non-empty handle field
            local parsed_handle
            parsed_handle=$(printf '%s' "$json_out" | jq -r '.handle // ""' 2>/dev/null || true)
            if [ -n "$parsed_handle" ] && [ "$parsed_handle" != "null" ]; then
                # Normalise to the shared contract: ensure all 10 keys are
                # present (fill missing ones with empty/"" / false defaults).
                printf '%s' "$json_out" | jq -c '{
                    handle:        (.handle         // ""),
                    tier:          (.tier           // ""),
                    org:           (.org            // ""),
                    trust:         (.trust          // ""),
                    domain:        (.domain         // ""),
                    email:         (.email          // ""),
                    member_id:     (.member_id      // ""),
                    session_id:    (.session_id     // ""),
                    authenticated: (.authenticated  // true),
                    expired:       (.expired        // false)
                }' 2>/dev/null && return 0
            fi
        fi
    fi

    # ── Path (b): alter whoami (human first line) ──────────────────────────
    _left=$(( _deadline - SECONDS ))
    if [ "$_have_timeout" -eq 1 ] && [ "$_left" -gt 0 ] \
       && command -v alter >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
        local whoami_line
        whoami_line=$(timeout "$_left" alter whoami 2>/dev/null | head -1 || true)
        if [ -n "$whoami_line" ]; then
            # Line format (live):    "~example | L4 | truealter.com (trusted/engineering) | you@example.com"
            # Line format (expired): "~example (not set - add one in Account > Email) - SESSION EXPIRED. Run 'alter login'."
            # First whitespace-delimited token is always the ~handle in both formats.
            # Pipe-delimited fields 2/3/4 are correct for live; empty-string for expired (no pipes).
            local raw_handle raw_tier raw_org_trust raw_email
            raw_handle=$(printf '%s' "$whoami_line" | awk '{print $1}' | tr -d '[:space:]')
            raw_tier=$(   printf '%s' "$whoami_line" | awk -F'|' '{print $2}' | tr -d '[:space:]')
            raw_org_trust=$(printf '%s' "$whoami_line" | awk -F'|' '{print $3}' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
            raw_email=$(  printf '%s' "$whoami_line" | awk -F'|' '{print $4}' | tr -d '[:space:]')

            # Detect expired/logged-out session from the human line
            local _session_expired=false
            if printf '%s' "$whoami_line" | grep -qiE 'SESSION EXPIRED|not logged in|Run .alter login'; then
                _session_expired=true
            fi

            # Strip leading ~ from handle; validate against handle regex
            local h="${raw_handle#\~}"
            # Regex guard: clear garbage handle (e.g. from expired no-pipe line first token mismatch)
            if ! printf '%s' "$h" | grep -qE '^[a-z0-9][a-z0-9._-]{0,62}$'; then
                h=""
            fi
            if [ -n "$h" ] && [ "$h" != "null" ]; then
                # Parse org (trust/domain): e.g. "truealter.com (trusted/engineering)"
                local org trust domain
                org=$(   printf '%s' "$raw_org_trust" | sed 's/ (.*//')
                trust=$( printf '%s' "$raw_org_trust" | grep -oP '(?<=\()\w+(?=/)' 2>/dev/null || true)
                domain=$(printf '%s' "$raw_org_trust" | grep -oP '(?<=/)[^)]+(?=\))' 2>/dev/null || true)

                local _auth_val=true
                [ "$_session_expired" = "true" ] && _auth_val=false

                jq -nc \
                    --arg handle    "$h" \
                    --arg tier      "$raw_tier" \
                    --arg org       "$org" \
                    --arg trust     "$trust" \
                    --arg domain    "$domain" \
                    --arg email     "$raw_email" \
                    --argjson authenticated "$_auth_val" \
                    '{
                        handle:        $handle,
                        tier:          $tier,
                        org:           $org,
                        trust:         $trust,
                        domain:        $domain,
                        email:         $email,
                        member_id:     "",
                        session_id:    "",
                        authenticated: $authenticated,
                        expired:       false
                    }' 2>/dev/null && return 0
            fi
        fi
    fi

    # ── Path (c): legacy ~/.config/alter/session.json ─────────────────────
    if [ -f "$session_file" ] && command -v jq >/dev/null 2>&1; then
        local legacy_handle legacy_ct legacy_member_id legacy_email
        legacy_handle=$(    jq -r '.handle     // ""' "$session_file" 2>/dev/null || true)
        legacy_ct=$(        jq -r '.consent_tier // ""' "$session_file" 2>/dev/null || true)
        legacy_member_id=$( jq -r '.member_id  // ""' "$session_file" 2>/dev/null || true)
        legacy_email=$(     jq -r '.email       // ""' "$session_file" 2>/dev/null || true)

        # Strip leading ~ from handle if present
        legacy_handle="${legacy_handle#\~}"
        # Map numeric consent_tier to tier label (L1..L4)
        local tier_label=""
        case "$legacy_ct" in
            1) tier_label="L1" ;;
            2) tier_label="L2" ;;
            3) tier_label="L3" ;;
            4) tier_label="L4" ;;
        esac

        if [ -n "$legacy_handle" ] && [ "$legacy_handle" != "null" ]; then
            jq -nc \
                --arg handle    "$legacy_handle" \
                --arg tier      "$tier_label" \
                --arg email     "$legacy_email" \
                --arg member_id "$legacy_member_id" \
                '{
                    handle:        $handle,
                    tier:          $tier,
                    org:           "",
                    trust:         "",
                    domain:        "",
                    email:         $email,
                    member_id:     $member_id,
                    session_id:    "",
                    authenticated: true,
                    expired:       false
                }' 2>/dev/null && return 0
        fi
    fi

    # ── Path (d): all-empty fallback ───────────────────────────────────────
    printf '{"handle":"","tier":"","org":"","trust":"","domain":"","email":"","member_id":"","session_id":"","authenticated":false,"expired":false}\n'
}

# ── TTL-cached session resolver (perf: per-prompt hook consolidation) ───────
# resolve_alter_session_json spawns `alter whoami` (6s cap, ~380ms typical) and
# was invoked ~4x on every UserPromptSubmit across cc-awareness / cc-broadcast /
# cc-cone-declare / the session-claim emitter. This wrapper resolves ONCE per
# session and caches the 10-key contract in $CC_STATUS_DIR/<sid>.session.cache
# for CC_SESSION_INFO_TTL seconds; the hot callers read the cache instead of
# re-resolving. Only a SUCCESSFUL resolve (non-empty handle) is cached, so a
# transient `alter whoami` timeout is retried next prompt rather than pinned as
# "logged out". Keyed by the per-session <sid>, so concurrent sessions
# never collide. Falls back to a direct resolve when no sid is supplied.
# Atomic mktemp+mv write; cross-platform stat (-c %Y Linux, -f %m macOS).
CC_SESSION_INFO_TTL="${CC_SESSION_INFO_TTL:-300}"
_cc_session_info_cached() {
    local sid="${1:-}"
    [ -z "$sid" ] && { resolve_alter_session_json; return; }
    mkdir -p "$CC_STATUS_DIR" 2>/dev/null || true
    local cache="$CC_STATUS_DIR/${sid}.session.cache"
    if [ -f "$cache" ] && [ -s "$cache" ]; then
        local now stamp age
        now=$(date +%s)
        stamp=$(stat -c %Y "$cache" 2>/dev/null || stat -f %m "$cache" 2>/dev/null || echo 0)
        age=$(( now - stamp ))
        if [ "$age" -lt "$CC_SESSION_INFO_TTL" ]; then
            cat "$cache" 2>/dev/null
            return 0
        fi
    fi
    local json handle=""
    json=$(resolve_alter_session_json 2>/dev/null) || json=""
    if command -v jq &>/dev/null; then
        handle=$(printf '%s' "$json" | jq -r '.handle // ""' 2>/dev/null || true)
    fi
    if [ -n "$handle" ] && [ "$handle" != "null" ]; then
        printf '%s' "$json" > "$cache.tmp" 2>/dev/null && mv "$cache.tmp" "$cache" 2>/dev/null || true
    fi
    printf '%s' "$json"
}

# ── TTL-cached worktree inventory (perf: per-prompt hook consolidation) ─────
# The worktree inventory in cc-awareness.sh ran `git worktree list` plus a
# per-worktree `git status --porcelain` on EVERY UserPromptSubmit, scaling with
# worktree count. This wrapper renders the inventory once and caches the
# rendered block in $CC_STATUS_DIR/<sid>.worktrees.cache for CC_WORKTREE_INV_TTL
# seconds. A newly-added sibling worktree surfaces within the TTL (advisory
# only; nothing gates on it). Excludes $PWD (the caller's own worktree), which
# is stable for the session, so per-sid caching is sound. The rendered string
# is a verbatim port of the prior inline producer to keep output byte-identical.
CC_WORKTREE_INV_TTL="${CC_WORKTREE_INV_TTL:-45}"
_cc_worktree_inventory_cached() {
    local sid="${1:-}"
    [ -z "$sid" ] && return 0
    mkdir -p "$CC_STATUS_DIR" 2>/dev/null || true
    local cache="$CC_STATUS_DIR/${sid}.worktrees.cache"
    if [ -f "$cache" ]; then
        local now stamp age
        now=$(date +%s)
        stamp=$(stat -c %Y "$cache" 2>/dev/null || stat -f %m "$cache" 2>/dev/null || echo 0)
        age=$(( now - stamp ))
        if [ "$age" -lt "$CC_WORKTREE_INV_TTL" ]; then
            cat "$cache" 2>/dev/null
            return 0
        fi
    fi
    local wt_common wt_lines wt_count=0 wt_items="" inventory=""
    local _wt_path="" _wt_branch="" _wt_head="" _wt_dirty="" _wt_short="" line
    wt_common=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
    if [ -n "$wt_common" ]; then
        wt_lines=$(git worktree list --porcelain 2>/dev/null || true)
        # Pre-existing bug fix (found while testing the token-cut tier gate,
        # unrelated to it): command substitution strips ALL trailing
        # newlines, eating the blank-line record separator git emits after
        # the LAST worktree entry. Without it, the final entry's flush
        # branch (the `""` case below) never fires and the last worktree in
        # the list is silently dropped from the inventory. Appending one
        # synthetic blank line restores the terminator; it is a no-op when
        # the real output already had one (the flush condition is already
        # false by then). Mirrors the same fix already present in the
        # Python rewrite of this producer (its compute_worktrees:
        # `for line in out.stdout.splitlines() + [""]:`).
        while IFS= read -r line; do
            case "$line" in
                "worktree "*)
                    if [ -n "$_wt_path" ] && [ "$_wt_path" != "$PWD" ]; then
                        _wt_dirty=""
                        [ -d "$_wt_path" ] && _wt_dirty=$(git -C "$_wt_path" status --porcelain 2>/dev/null | head -3 | wc -l)
                        _wt_short="${_wt_path##*/}"
                        wt_items="${wt_items}\n- ${_wt_short}: ${_wt_branch:-detached} ${_wt_head:+[${_wt_head:0:8}]}${_wt_dirty:+ (${_wt_dirty} dirty)}"
                        wt_count=$((wt_count + 1))
                    fi
                    _wt_path="${line#worktree }" _wt_branch="" _wt_head=""
                    ;;
                "branch "*)  _wt_branch="${line#branch refs/heads/}" ;;
                "HEAD "*)    _wt_head="${line#HEAD }" ;;
                "")
                    if [ -n "$_wt_path" ] && [ "$_wt_path" != "$PWD" ]; then
                        _wt_dirty=""
                        [ -d "$_wt_path" ] && _wt_dirty=$(git -C "$_wt_path" status --porcelain 2>/dev/null | head -3 | wc -l)
                        _wt_short="${_wt_path##*/}"
                        wt_items="${wt_items}\n- ${_wt_short}: ${_wt_branch:-detached} ${_wt_head:+[${_wt_head:0:8}]}${_wt_dirty:+ (${_wt_dirty} dirty)}"
                        wt_count=$((wt_count + 1))
                    fi
                    _wt_path="" _wt_branch="" _wt_head=""
                    ;;
            esac
        done <<< "${wt_lines}"$'\n'
        if [ "$wt_count" -gt 0 ]; then
            inventory="WORKTREE INVENTORY (${wt_count} other worktree(s), branches in play):${wt_items}\nBefore creating a new branch, check if an existing worktree already covers the topic."
        fi
    fi
    printf '%s' "$inventory" > "$cache.tmp" 2>/dev/null && mv "$cache.tmp" "$cache" 2>/dev/null || true
    printf '%s' "$inventory"
}

# ── ALTER login resolver (enc-store migration) ─────────────────────────────
# resolve_alter_login: detect whether the user is logged in to ALTER and
# echo their bare ~handle (without the leading ~). Returns 0 on success,
# 1 when not logged in. Sources: enc store (via `alter whoami`) → plaintext
# session.json (legacy fallback, also future-proofing for re-added plaintext).
#
# Resolution order:
#   1. Fast path: ~/.config/alter/last-status-snapshot.json, does NOT carry
#      handle, so skipped for handle resolution. The snapshot only carries
#      attunement/balance, not identity.
#   2. `alter whoami` subprocess, authoritative live read from enc store.
#      Output format: "~handle | L4 | ...", extract the bare handle.
#      Capped at 3 seconds to prevent blocking hook dispatch.
#   3. Legacy: ~/.config/alter/session.json .handle field, kept for older
#      setups that still write the plaintext file, and as a fast path if a
#      future CLI version restores it.
#
# Callers that need only logged-in detection (not the handle) can test
# `resolve_alter_login >/dev/null`.
#
# Sourceable by both the hook scripts that already source config.sh and the
# repository's own pre-commit hook, which sources this file.
#
# NOTE: this function is intentionally CHEAP. It never makes network calls
# beyond the local `alter whoami` (which reads the enc store, not the network
# when the daemon is running). The 6-second timeout (bumped from 3s because
# the CLI version-floor preflight stalls ~4s on a stale disk cache against a
# cold API, which starved the 3s budget and silently killed paths (a)/(b))
# bounds the stall without starving the call.
resolve_alter_login() {
    local session_file="$HOME/.config/alter/session.json"
    local handle=""

    # Path 1: `alter whoami`, reads the enc store, returns instantly when the
    # CLI daemon is running. The output first token is "~<handle>"; strip the ~.
    if command -v alter >/dev/null 2>&1; then
        local whoami_out
        # _cc_timeout, not bare `timeout`: on a host without GNU coreutils a
        # bare call returns 127, the handle comes back empty, and this resolver
        # reports "not logged in" for what is only a missing binary.
        whoami_out=$(_cc_timeout 6 alter whoami 2>/dev/null | head -1 || true)
        if [ -n "$whoami_out" ]; then
            # First whitespace-delimited token is always the ~handle in both live and expired formats.
            handle=$(printf '%s' "$whoami_out" | awk '{print $1}' | tr -d '[:space:]~')
            # Validate: clear garbage if it doesn't match handle regex
            if ! printf '%s' "$handle" | grep -qE '^[a-z0-9][a-z0-9._-]{0,62}$'; then
                handle=""
            fi
        fi
    fi

    # Path 2: legacy plaintext session.json fallback (old setups / re-added by future CLI)
    if [ -z "$handle" ] || [ "$handle" = "null" ]; then
        if [ -f "$session_file" ] && command -v jq >/dev/null 2>&1; then
            handle=$(jq -r '.handle // empty' "$session_file" 2>/dev/null | sed 's/^~//')
        fi
    fi

    if [ -z "$handle" ] || [ "$handle" = "null" ]; then
        return 1
    fi
    printf '%s' "$handle"
}

# Cleanup stale files (runs once per hook invocation, fast)
_cc_cleanup() {
    # Session state older than 2 hours
    find "$CC_STATE_BASE" -name '*.json' -mmin +120 -delete 2>/dev/null || true
    find "$CC_STATE_BASE" -name '*.json.tmp' -mmin +5 -delete 2>/dev/null || true
    # Version sidecar files (JSONL dual-write) follow .json TTL
    find "$CC_STATE_BASE" -name '*.json.ver' -mmin +120 -delete 2>/dev/null || true
    find "$CC_STATE_BASE" -name '*.json.ver.tmp' -mmin +5 -delete 2>/dev/null || true
    # session_claim refresh markers follow .json TTL
    find "$CC_STATE_BASE" -name '*.json.last-claim' -mmin +120 -delete 2>/dev/null || true
    find "$CC_STATE_BASE" -name '*.json.last-claim.tmp' -mmin +5 -delete 2>/dev/null || true
    # Cached session-info + worktree-inventory (per-prompt hook consolidation) follow .json TTL
    find "$CC_STATE_BASE" -name '*.session.cache' -mmin +120 -delete 2>/dev/null || true
    find "$CC_STATE_BASE" -name '*.session.cache.tmp' -mmin +5 -delete 2>/dev/null || true
    find "$CC_STATE_BASE" -name '*.worktrees.cache' -mmin +120 -delete 2>/dev/null || true
    find "$CC_STATE_BASE" -name '*.worktrees.cache.tmp' -mmin +5 -delete 2>/dev/null || true
    # Content-addressed brief markers (session-start injectors), 2-day TTL
    find "$CC_STATE_BASE" -name 'brief-*.hash' -mmin +2880 -delete 2>/dev/null || true
    find "$CC_STATE_BASE" -name 'brief-*.hash.tmp' -mmin +5 -delete 2>/dev/null || true
    # Specialist dedup markers older than 35 minutes (window + margin)
    find "$CC_SPECIALIST_DIR" -type f -mmin +35 -delete 2>/dev/null || true
    # Empty directories: but NEVER the dir THIS hook is using. The caller
    # has just `mkdir -p`'d $CC_STATUS_DIR and is about to `exec 200>$LOCK_FILE`
    # into it; if cleanup wins the race the lock-file open ENOENTs and the
    # hook crashes. Exclude $CC_STATUS_DIR to keep first-invocation safe.
    find "$CC_STATE_BASE" -type d -empty ! -path "$CC_STATUS_DIR" -delete 2>/dev/null || true
}
_cc_cleanup &
