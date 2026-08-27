#!/usr/bin/env bash
# _stop-cache.sh: Sourced by Stop hooks that need the transcript tail.
#
# Several Stop hooks may read the same transcript on every Stop event, each
# tailing it a different way. Under load the transcript is 1-5MB and the reads
# are serialised within a Stop chain, so the same bytes get read more than once
# per Stop.
#
# This helper exposes one function: `stop_cache_get_tail $TRANSCRIPT
# $SESSION_ID [$BYTES]`. First caller in the Stop chain reads-and-caches
# at /dev/shm/cc-stop-cache/$SESSION_ID.tail with a 60s TTL; subsequent
# callers read from the cache. Falls back to /tmp on tmpfs failure. All
# paths are best-effort: read-failure returns empty, never blocks.
#
# The cache is one file per session_id with mtime as the freshness signal.
# The next Stop event sees the same disk state regardless of which hook
# wrote it.

stop_cache_get_tail() {
    local transcript="$1" session_id="$2" bytes="${3:-524288}"
    [ -z "$transcript" ] || [ -z "$session_id" ] && return 1
    [ -f "$transcript" ] || return 1

    local cache_dir="/dev/shm/cc-stop-cache"
    [ -d /dev/shm ] || cache_dir="/tmp/cc-stop-cache"
    mkdir -p "$cache_dir" 2>/dev/null || cache_dir="/tmp/cc-stop-cache"
    mkdir -p "$cache_dir" 2>/dev/null || return 1

    # Janitor: same pattern as _verify.sh. Drop cache files older than
    # 5 minutes on every entry so stale session caches don't accumulate.
    find "$cache_dir" -maxdepth 1 -type f -name '*.tail' -mmin +5 -delete 2>/dev/null &

    local cache_file="$cache_dir/${session_id}.tail"
    # Export the chosen path so callers (notably python subprocesses) can
    # read the cache directly without re-probing /dev/shm vs /tmp.
    STOP_CACHE_TAIL_PATH="$cache_file"
    export STOP_CACHE_TAIL_PATH

    if [ -f "$cache_file" ]; then
        local age
        # GNU stat (-c) on Linux + Git Bash; BSD stat (-f) on macOS; 0 if neither.
        age=$(( $(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || stat -f %m "$cache_file" 2>/dev/null || echo 0) ))
        if [ "$age" -lt 60 ]; then
            cat "$cache_file" 2>/dev/null
            return 0
        fi
    fi

    # Cold miss: read, atomically cache, emit.
    local tmp="$cache_file.$$.tmp"
    if tail -c "$bytes" "$transcript" 2>/dev/null > "$tmp"; then
        mv "$tmp" "$cache_file" 2>/dev/null || rm -f "$tmp" 2>/dev/null
        cat "$cache_file" 2>/dev/null
    else
        rm -f "$tmp" 2>/dev/null
        return 1
    fi
}
