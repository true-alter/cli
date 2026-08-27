#!/usr/bin/env bash
# Claude Code status line - single line, identity-first
# ~handle [⌥ ~orgs] │ ctx N% │ 5h N% · week N% │ model │ branch │ descriptor
#
# Handle is the leftmost anchor - your identity is the "who" you should see
# first. Coupled org slots (~handle form) sit next to the handle in a softer
# colour so the identity/coupling distinction reads visually. Branch sits right
# of context so visual scan is identity -> state -> location. Descriptor
# (local-model session label, with a cleaned prompt-head fallback when no local
# model is present) anchors the right edge in per-session italic colour for pane
# distinguishability. The three consumption windows (context, the 5-hour rate
# window, the 7-day account window) all read as percent USED, rising from 0%.

# ── Portability preflight (macOS bash 3.2 / BSD) ─────────────────────────────
# The full renderer uses bash-4 associative arrays (declare -A). On stock macOS
# /bin/bash is 3.2 and would error. Re-exec under a modern bash if one is
# installed (Homebrew or anything on PATH reporting >=4); otherwise emit a
# minimal identity-only line and exit cleanly so the operator never sees a
# broken statusline. Linux and Windows Git Bash ship bash >=4 and fall straight
# through to the full renderer. Stdin (the CC JSON) is inherited across exec.
if [ -z "${ALTER_SL_REEXEC:-}" ] && [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
    for _modern in /opt/homebrew/bin/bash /usr/local/bin/bash; do
        if [ -x "$_modern" ] && [ "$("$_modern" -c 'echo ${BASH_VERSINFO[0]}' 2>/dev/null || echo 0)" -ge 4 ]; then
            export ALTER_SL_REEXEC=1; exec "$_modern" "$0" "$@"
        fi
    done
    _pathbash=$(command -v bash 2>/dev/null)
    if [ -n "$_pathbash" ] && [ "$("$_pathbash" -c 'echo ${BASH_VERSINFO[0]}' 2>/dev/null || echo 0)" -ge 4 ]; then
        export ALTER_SL_REEXEC=1; exec "$_pathbash" "$0" "$@"
    fi
    # No modern bash available - minimal identity-only degrade (no assoc arrays).
    _json=$(cat)
    _rst='\033[0m'; _dim='\033[90m'; _gold='\033[38;5;179m'; _yellow='\033[93m'; _red='\033[91m'
    _id="~?"; _col="$_dim"; _lvl=""
    if command -v jq >/dev/null 2>&1; then
        _aj=""
        if command -v alter >/dev/null 2>&1; then
            if command -v timeout >/dev/null 2>&1; then _aj=$(timeout 3 alter whoami --json 2>/dev/null)
            else _aj=$(alter whoami --json 2>/dev/null); fi
        fi
        if ! printf '%s' "$_aj" | jq -e 'has("handle")' >/dev/null 2>&1; then
            _legacy="${XDG_CONFIG_HOME:-$HOME/.config}/alter/session.json"
            [ -f "$_legacy" ] && _aj=$(jq -c '{handle:(.handle//""),tier:(.consent_tier//""),authenticated:((.handle//"")|length>0),expired:false}' < "$_legacy" 2>/dev/null)
        fi
        _h=$(printf '%s' "$_aj" | jq -r '.handle // ""' 2>/dev/null)
        if [ -n "$_h" ] && [ "$_h" != "null" ]; then
            _id="$_h"
            _auth=$(printf '%s' "$_aj" | jq -r '.authenticated // false' 2>/dev/null)
            _exp=$(printf '%s' "$_aj" | jq -r '.expired // false' 2>/dev/null)
            if [ "$_auth" != "true" ]; then _col="$_red"
            elif [ "$_exp" = "true" ]; then _col="$_yellow"
            else _col="$_gold"; fi
            _t=$(printf '%s' "$_aj" | jq -r '.tier // ""' 2>/dev/null)
            # Every tier renders here too, L4 included, matching seg_identity.
            [ -n "$_t" ] && [ "$_t" != "null" ] && _lvl=" ${_dim}${_t}${_rst}"
        fi
    fi
    printf '%b\n' "${_col}${_id}${_rst}${_lvl}"
    exit 0
fi

JSON=$(cat)

# jq is required for the full renderer. If absent, degrade to identity-only
# rather than emitting broken output (mirrors the bash-3.2 degrade above).
if ! command -v jq >/dev/null 2>&1; then
    printf '%b\n' "\033[90m~?\033[0m"
    exit 0
fi

CWD=$(echo "$JSON"          | jq -r '.workspace.current_dir // .cwd // ""')
REMAIN_PCT=$(echo "$JSON"   | jq -r '.context_window.remaining_percentage // "null"')
MODEL_NAME=$(echo "$JSON"   | jq -r '.model.display_name // "Claude"')
SESSION_ID=$(echo "$JSON"   | jq -r '.session_id // ""' | tr -cd 'a-zA-Z0-9_-')
# Reasoning effort level (.effort.level): low|medium|high|xhigh|max. Absent for
# models that don't support the effort param, leaving empty (no suffix).
MODEL_EFFORT=$(echo "$JSON" | jq -r '.effort.level // empty')
# Rate-limit burndowns: the 5-hour rate window and the 7-day account window,
# both metered by the API and carried on the payload every tick (the same
# numbers `/usage` reports). Left empty on a payload that omits them, so the
# burn segment goes dark rather than reporting a confident zero.
RL5_PCT=$(echo "$JSON"      | jq -r '.rate_limits.five_hour.used_percentage // empty')
RL7_PCT=$(echo "$JSON"      | jq -r '.rate_limits.seven_day.used_percentage // empty')

# ── Colors ───────────────────────────────────────────────────────────────────
# Defined early so every downstream rendering block can use them. (Was
# previously defined about halfway down the script, which silently broke
# SESSION_LABEL styling - variables expanded to empty.)
DIM='\033[90m'
ITALIC='\033[3m'
ITALIC_DIM='\033[3;90m'
WHITE='\033[97m'
GREEN='\033[92m'
YELLOW='\033[93m'
CYAN='\033[96m'
BLUE='\033[94m'
RED='\033[91m'
MAGENTA='\033[95m'
GOLD='\033[38;5;179m'        # premium tier (Opus model)
SOVEREIGN='\033[97m'         # sovereign handle - brightest on the line, the fixed point
COUPLING='\033[38;5;245m'    # structural operator (⌥) - grammar, not content
COLLECTIVE='\033[38;5;109m'  # collective context (~org) - same colour as @scope
AMBER='\033[38;5;214m'       # signal family base - "attention needed"
AMBER_HOT='\033[38;5;208m'   # signal family escalated - high count
SCOPE_COLOR='\033[38;5;109m' # teal-grey - location anchor, distinct from gold identity
RST='\033[0m'
# Variation Selector 15 - forces text presentation on emoji-class symbols so
# ⚡/✉/⚖ render at 1-column width with no apparent trailing space, matching
# the tight cluster intended for the count badges.
VS15=$'\xef\xb8\x8e'

# ── Git branch ───────────────────────────────────────────────────────────────
# Truncated to BRANCH_MAX_LEN so long branch names don't push the rest of the
# line off-screen. Dirty marker `*` is appended AFTER truncation so the cue is
# never elided.
BRANCH_MAX_LEN=32
GIT_BRANCH=""
_in_repo=false
_dirty=""
if [ -n "$CWD" ] && git -C "$CWD" rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
    _in_repo=true
    GIT_BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null || echo "")
    if [ -z "$GIT_BRANCH" ]; then
        # Detached HEAD - fall back to CWD basename (worktree or repo dir).
        # The dirname reads better than a raw SHA.
        GIT_BRANCH=$(basename "$CWD" 2>/dev/null || echo "")
    fi
    if [ -n "$(git -C "$CWD" status --porcelain 2>/dev/null | head -1)" ]; then
        _dirty="*"
    fi
elif [ -n "$CWD" ]; then
    # Non-git CWD - show the directory name as the location label so the
    # branch slot is never empty and a pane is always self-locating.
    GIT_BRANCH=$(basename "$CWD" 2>/dev/null || echo "")
fi
# Truncate the core label before appending dirty marker so the dirty cue
# never gets elided alongside an overflowed name.
if [ ${#GIT_BRANCH} -gt "$BRANCH_MAX_LEN" ]; then
    GIT_BRANCH="${GIT_BRANCH:0:$((BRANCH_MAX_LEN - 1))}…"
fi
GIT_BRANCH="${GIT_BRANCH}${_dirty}"

# ── Context remaining % ─────────────────────────────────────────────────────
if [ "$REMAIN_PCT" = "null" ] || [ "$REMAIN_PCT" = "0" ]; then
    REMAIN_INT=100
else
    REMAIN_INT=$(awk "BEGIN {printf \"%.0f\", $REMAIN_PCT}")
fi

# ── ALTER identity + level + session state ──────────────────────────────────
# State matrix (drives ALTER_STATE -> colour at render):
#   live      JWT valid                              -> GOLD
#   refresh   JWT expired, refresh still valid       -> YELLOW (daemon re-mints)
#   dead      Refresh expired                        -> RED   (needs `alter login`)
#   absent    No session.json / unparseable          -> DIM   `~?` slot held
ALTER_ID=""
ALTER_LEVEL=""
ALTER_STATE="absent"
ALTER_ORGS=()  # list of handle-form coupled org alters (domain-stripped)
# Identity is sourced from `alter whoami --json` - the secret-safe surface that
# replaced the plaintext session.json when auth moved into the enc-store (the OS
# keychain). The CLI no longer writes session.json, so grepping it directly
# false-negatives even when logged in. We cache the whoami JSON to
# ~/.cache/alter/whoami.json (short TTL) so the status line never spawns `node`
# on more than one render per window. Legacy session.json is kept as a fallback
# for older installs that predate the enc-store migration.
_alter_json=""
_alter_cache="${XDG_CACHE_HOME:-$HOME/.cache}/alter/whoami.json"
_alter_ttl=15
if command -v alter &>/dev/null; then
    _cache_age=99999
    [ -f "$_alter_cache" ] && _cache_age=$(( $(date +%s) - $(stat -c %Y "$_alter_cache" 2>/dev/null || stat -f %m "$_alter_cache" 2>/dev/null || echo 0) ))
    if [ "$_cache_age" -lt "$_alter_ttl" ]; then
        _alter_json=$(cat "$_alter_cache" 2>/dev/null)
    elif command -v timeout &>/dev/null; then
        _alter_json=$(timeout 3 alter whoami --json 2>/dev/null)
    else
        _alter_json=$(alter whoami --json 2>/dev/null)
        if printf '%s' "$_alter_json" | jq -e 'has("handle")' >/dev/null 2>&1; then
            mkdir -p "$(dirname "$_alter_cache")" 2>/dev/null \
                && printf '%s' "$_alter_json" > "$_alter_cache" 2>/dev/null
        fi
    fi
fi
# Legacy fallback: plaintext session.json (pre-enc-store installs). Normalise its
# shape into the whoami --json contract so the consumer logic below is uniform.
if ! printf '%s' "$_alter_json" | jq -e 'has("handle")' >/dev/null 2>&1; then
    _legacy="${XDG_CONFIG_HOME:-$HOME/.config}/alter/session.json"
    if [ -f "$_legacy" ] && jq empty < "$_legacy" 2>/dev/null; then
        _alter_json=$(jq -c '{
            handle: (.handle // ""),
            tier: (.consent_tier // ""),
            domain: ((.orgs[0].domain) // ""),
            authenticated: ((.handle // "") | length > 0),
            expired: false
        }' < "$_legacy" 2>/dev/null)
    fi
fi
if printf '%s' "$_alter_json" | jq -e 'has("handle")' >/dev/null 2>&1; then
    _handle=$(printf '%s' "$_alter_json" | jq -r '.handle // ""' 2>/dev/null)
    if [ -n "$_handle" ] && [ "$_handle" != "null" ]; then
        ALTER_ID="$_handle"
        # whoami --json exposes booleans, not raw token expiries. Map them onto
        # the existing live/refresh/dead state machine: not authenticated -> dead;
        # authenticated but access token expired -> refresh (daemon re-mints);
        # otherwise -> live.
        _auth=$(printf '%s' "$_alter_json" | jq -r '.authenticated // false' 2>/dev/null)
        _expired=$(printf '%s' "$_alter_json" | jq -r '.expired // false' 2>/dev/null)
        if [ "$_auth" != "true" ]; then
            ALTER_STATE="dead"
        elif [ "$_expired" = "true" ]; then
            ALTER_STATE="refresh"
        else
            ALTER_STATE="live"
        fi
        _tier=$(printf '%s' "$_alter_json" | jq -r '.tier // ""' 2>/dev/null)
        [ -n "$_tier" ] && [ "$_tier" != "null" ] && ALTER_LEVEL="$_tier"
        # Coupled org alter - whoami --json returns the primary org `domain`.
        # The authoritative memberships endpoint now
        # puts the canonical ~handle (e.g. ~truealter) in `domain`, so the
        # value may ALREADY be sigil-prefixed. Render an existing ~handle
        # verbatim (re-prefixing produced the ~~truealter double-trill); only
        # the legacy bare-domain shape (truealter.com) gets the TLD stripped
        # and the ~ added. Idempotent and backward-compatible.
        _domain=$(printf '%s' "$_alter_json" | jq -r '.domain // ""' 2>/dev/null)
        if [ -n "$_domain" ] && [ "$_domain" != "null" ]; then
            case "$_domain" in
                "~"*)
                    ALTER_ORGS+=("$_domain")
                    ;;
                *)
                    _slug="${_domain%%.*}"
                    [ -n "$_slug" ] && ALTER_ORGS+=("~${_slug}")
                    ;;
            esac
        fi
    fi
fi

# ── Peer-channel typed counts ────────────────────────────────────────────────
# Unread peer messages, read from ~/.cache/alter/inbox.json which the
# inbox hooks populate on every prompt + session-start.
INBOX_PEER=0
INBOX_CACHE="$HOME/.cache/alter/inbox.json"
if command -v jq &>/dev/null; then
    if [ -r "$INBOX_CACHE" ]; then
        # alter_message_inbox returns a rendered text blob (.result.content[0].text),
        # not a structured .result.messages[] array - count the
        # "── ~handle · … · unread" header lines. (.result.messages branch kept
        # for a hypothetical future structured shape.)
        INBOX_PEER=$(jq -r '
            def inbox_rows:
              if (.result.messages // null | type) == "array" then .result.messages
              else
                ((.result.content[0].text // "") / "\n── ")
                | (if length > 1 then .[1:] else [] end)
                | map(
                    (((. / "\n")[0] // "") / " · ") as $hp
                    | { read_at: (if (($hp | last // "") | ascii_downcase | test("unread")) then null else "read" end),
                        redacted: false, content_type: "text/markdown" }
                  )
              end;
            [ inbox_rows[]
              | select((.read_at // null) == null and .redacted != true)
              | select((.content_type // "text/markdown") == "text/markdown")]
            | length
        ' "$INBOX_CACHE" 2>/dev/null || echo "0")
        [[ "$INBOX_PEER" =~ ^[0-9]+$ ]] || INBOX_PEER=0
    fi
fi

# ── Mail indicator state (zero | unread | new) ──────────────────────────────
# Always visible. `zero` renders a dim placeholder. A genuine NEW arrival (the
# unread count rose since the last render) glimmers for a short window so it
# catches the eye, then settles to a calmer `unread` cue that persists while any
# mail stays unread. Cross-render state lives in a tiny cache shared by every
# session reading the same inbox; the count is always persisted (including 0) so
# a 0->N arrival is always detected as new.
MAIL_STATE="zero"
MAIL_NEW_WINDOW=60   # seconds a fresh arrival keeps glimmering
_mail_state_file="${XDG_CACHE_HOME:-$HOME/.cache}/alter/inbox-statusline-state.json"
_mail_now=$(date +%s)
_prev_count=-1; _last_rise=0
if [ -r "$_mail_state_file" ] && command -v jq &>/dev/null; then
    _prev_count=$(jq -r '.count // -1'     "$_mail_state_file" 2>/dev/null || echo -1)
    _last_rise=$(jq -r '.last_rise // 0'   "$_mail_state_file" 2>/dev/null || echo 0)
    [[ "$_prev_count" =~ ^-?[0-9]+$ ]] || _prev_count=-1
    [[ "$_last_rise"  =~ ^[0-9]+$   ]] || _last_rise=0
fi
# A rise over a KNOWN prior count stamps a fresh-arrival time. A first-ever render
# (prev unknown) just seeds the baseline, so pre-existing mail never glimmers.
if [ "$_prev_count" -ge 0 ] && [ "$INBOX_PEER" -gt "$_prev_count" ]; then
    _last_rise=$_mail_now
fi
if [ "$INBOX_PEER" -gt 0 ]; then
    MAIL_STATE="unread"
    if [ "$_last_rise" -gt 0 ] && [ $(( _mail_now - _last_rise )) -le "$MAIL_NEW_WINDOW" ]; then
        MAIL_STATE="new"
    fi
fi
mkdir -p "$(dirname "$_mail_state_file")" 2>/dev/null
printf '{"count":%d,"last_rise":%d}\n' "$INBOX_PEER" "$_last_rise" \
    > "${_mail_state_file}.tmp" 2>/dev/null \
    && mv -f "${_mail_state_file}.tmp" "$_mail_state_file" 2>/dev/null

# ── Other local sessions on this project ────────────────────────────────────
# Mirrors the hook system's project-hash + alive/non-idle/non-self filter.
# Read-only - does not write anything to /dev/shm itself; relies on the
# session broadcast hook to populate.
SIBLINGS=0
SELF_STATUS_FILE=""
if [ -n "$CWD" ]; then
    _cc_root=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "$CWD")
    if [ -d /dev/shm ]; then
        _cc_state_base="/dev/shm/cc-sessions"
    else
        _cc_state_base="/tmp/cc-sessions"
    fi
    if command -v md5sum &>/dev/null; then
        _cc_hash=$(echo "$_cc_root" | md5sum | cut -c1-8)
    elif command -v md5 &>/dev/null; then
        _cc_hash=$(echo "$_cc_root" | md5 -q | cut -c1-8)
    else
        _cc_hash=$(echo "$_cc_root" | cksum | cut -d' ' -f1)
    fi
    _cc_dir="$_cc_state_base/$_cc_hash"
    _cc_idle_timeout="${CC_IDLE_TIMEOUT:-600}"
    _cc_now=$(date +%s)
    [ -n "$SESSION_ID" ] && SELF_STATUS_FILE="$_cc_dir/$SESSION_ID.json"
    if [ -d "$_cc_dir" ]; then
        for _sf in "$_cc_dir"/*.json; do
            [ -f "$_sf" ] || continue
            _other_id=$(basename "$_sf" .json)
            # Skip legacy PID-keyed files (purged on next awareness pass).
            [[ "$_other_id" =~ ^[0-9]+$ ]] && continue
            # Skip self.
            [ -n "$SESSION_ID" ] && [ "$_other_id" = "$SESSION_ID" ] && continue
            _other_ts=$(jq -r '.last_activity // 0' "$_sf" 2>/dev/null)
            [[ "$_other_ts" =~ ^[0-9]+$ ]] || continue
            _age=$(( _cc_now - _other_ts ))
            [ "$_age" -gt "$_cc_idle_timeout" ] && continue
            SIBLINGS=$((SIBLINGS + 1))
        done
    fi
fi

# ── Session pill - sid + italic descriptor in a chunky bg-coloured tag ──────
# Replaces the prior FOCUS_TAG (repo·kind classification) as the descriptor
# segment at the right edge. CC's project scoping already handles repo
# coordination; what the operator needs at a glance is which session this is
# (8-hex cross-reference) and what subject it's on (hermes label).
# Pill background hashes from session id for a stable distinct hue per pane.
# Label source: .label (local-model summary via the label hook) ->
# .working_on (raw prompt head from the session broadcast hook) -> empty.
SESSION_PILL=""
if [ -n "$SESSION_ID" ]; then
    _sid_short="${SESSION_ID:0:8}"
    # Dark/saturated 256-colour palette - readable with white fg; curated for
    # parallel-pane distinguishability across 8+ panes.
    _pill_palette=(22 24 25 28 30 52 54 56 58 60 88 91 94 100 125 130)
    _pill_hash=$(echo -n "$SESSION_ID" | cksum | cut -d' ' -f1)
    _pill_bg="${_pill_palette[$((_pill_hash % ${#_pill_palette[@]}))]}"

    _lbl=""
    if [ -n "$SELF_STATUS_FILE" ] && [ -r "$SELF_STATUS_FILE" ]; then
        _lbl=$(jq -r '.label // ""' "$SELF_STATUS_FILE" 2>/dev/null)
        _from_label=1
        if [ -z "$_lbl" ] || [ "$_lbl" = "null" ]; then
            _lbl=$(jq -r '.working_on // ""' "$SELF_STATUS_FILE" 2>/dev/null)
            _from_label=0
            # Strip common conversational prefixes so truncation lands on the
            # semantic core rather than filler.
            _lbl=$(echo "$_lbl" | sed -E 's/^(at the moment[ ,]+|can you[ ,]+|could you[ ,]+|i want to[ ,]+|i need to[ ,]+|please[ ,]+|so[ ,]+|ok[ ,]+|okay[ ,]+|hey[ ,]+|right[ ,]+)//i')
        fi
        # Reject shell-paste / bash-transcript blobs that leak in when the user
        # submits a `!command` to CC - the user_prompt for those turns carries
        # the bash transcript (PS1 + stdout + stderr), which makes a useless
        # label. Detection: shell PS1 prefix (username + whitespace + ~),
        # explicit bash-tag markers, raw sudo command, or a Powerline-chevron
        # signature. Only applies to the .working_on fallback - a model-
        # written .label is trusted (the hook already filters at the source).
        if [ "$_from_label" -eq 0 ] && [ -n "$_lbl" ] && [ "$_lbl" != "null" ]; then
            if echo "$_lbl" | grep -qE '(<bash-(input|stdout|stderr)>|^[[:alnum:]_.-]+[[:space:]]+[~▶]|^sudo[[:space:]]|^\[sudo\]|^── ~|[▶│])' 2>/dev/null; then
                _lbl=""
            fi
        fi
        if [ -n "$_lbl" ] && [ "$_lbl" != "null" ]; then
            # Collapse internal whitespace + newlines.
            _lbl=$(echo "$_lbl" | tr '\n\r\t' '   ' | tr -s ' ')
            _lbl="${_lbl# }"  # trim leading space after sed
            # Word-snap truncation, no trailing ellipsis. Hermes labels are
            # hyphen-joined slugs; cut at the last hyphen ≤ cap so the label
            # never implies "more text off-screen". Working_on fallback (no
            # hyphens) hard-cuts at the cap.
            if [ ${#_lbl} -gt 32 ]; then
                _lbl="${_lbl:0:32}"
                _snapped="${_lbl%-*}"
                [ ${#_snapped} -ge 12 ] && [ "$_snapped" != "$_lbl" ] && _lbl="$_snapped"
            fi
        else
            _lbl=""
        fi
    fi

    # Compose two-tone pill:
    #   ▍ (left bar, pill-colour fg)
    #   [filled] 2-space + bold sid + 2-space - bg=pill, fg=white
    #   [unfilled] space + italic descriptor + space - no bg, fg=pill colour
    # The fill->no-fill transition visually delineates session-id from
    # descriptor while keeping both within a single block of pill-colour.
    SESSION_PILL="\033[38;5;${_pill_bg}m▍"
    SESSION_PILL+="\033[48;5;${_pill_bg};38;5;231;1m  ${_sid_short}  \033[0m"
    if [ -n "$_lbl" ]; then
        SESSION_PILL+="\033[3;38;5;${_pill_bg}m ${_lbl} \033[0m"
    fi
fi

# ── Worktree detection ──────────────────────────────────────────────────────
# Surfaces when CC is operating in a `git worktree add`-style isolated copy.
# (Repo + branch-kind classification used to live here for the FOCUS_TAG;
# that's been retired - the SESSION_PILL is now the prominent visual anchor.)
focus_worktree=""
if [ -n "$CWD" ]; then
    _common_dir=$(git -C "$CWD" rev-parse --git-common-dir 2>/dev/null || echo "")
    _git_dir=$(git -C "$CWD" rev-parse --git-dir 2>/dev/null || echo "")
    if [ -n "$_git_dir" ] && [ -n "$_common_dir" ] && [ "$_git_dir" != "$_common_dir" ]; then
        case "$_git_dir" in
            /*) _wt_abs="$_git_dir" ;;
            # readlink -f is absent on stock macOS; `cd … && pwd -P` resolves a
            # relative dir portably (bash 3.2 + BSD + Git Bash).
            *)  _wt_abs=$(cd "$CWD/$_git_dir" 2>/dev/null && pwd -P || echo "") ;;
        esac
        [ -n "$_wt_abs" ] && focus_worktree=$(basename "$_wt_abs")
    fi
fi

# Worktree segment - only present when in a git worktree (CC isolation mode).
# Distinguishes 2 panes that share repo+kind but live in different worktrees.
FOCUS_WT=""
if [ -n "$focus_worktree" ]; then
    _wt="$focus_worktree"
    if [ ${#_wt} -gt 16 ]; then
        _wt="${_wt:0:15}…"
    fi
    FOCUS_WT="${DIM}▸ ${WHITE}${_wt}${RST}"
fi

# Branch colour reflects CWD context: GREEN when CC is operating inside a
# `git worktree add` isolated copy, YELLOW when CWD is the shared tree (the
# default-branch HEAD - usually `main`), DIM when CWD is outside any git repo
# (label is the directory basename - no branch concept to colour).
if [ -n "$focus_worktree" ]; then
    BRANCH_COLOR="$GREEN"
elif [ "$_in_repo" = "true" ]; then
    BRANCH_COLOR="$YELLOW"
else
    BRANCH_COLOR="$DIM"
fi

# ── Scope anchor - @<scope> chip right of branch slot ────────────────────────
# Maps CWD (or its canonical repo root, for worktrees) to a scope label via
# ~/.config/alter/scopes.json. First-match-wins prefix list; personal fallback
# mirrors the sovereign ~handle as @<handle>. The `@` prefix carves a third
# semantic class distinct from `~` (sovereign identity) and `⌥` (coupling) -
# `@truealter` reads as "this session is anchored in the truealter scope"
# rather than as a coupling claim. Renders always when a label resolves.
SCOPE_LABEL=""
SCOPE_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/alter/scopes.json"
# Resolve the canonical anchor: a worktree's git-common-dir lives under its
# source repo, so its parent is the repo root - which makes worktrees inherit
# their backing repo's scope without per-worktree config.
_scope_anchor="$CWD"
if [ -n "$_common_dir" ] && [ -n "$_git_dir" ] && [ "$_git_dir" != "$_common_dir" ]; then
    case "$_common_dir" in
        /*) _scope_anchor=$(dirname "$_common_dir") ;;
        # readlink -f is absent on stock macOS; `cd … && pwd -P` resolves a
        # relative dir portably (bash 3.2 + BSD + Git Bash).
        *)  _cd_abs=$(cd "$CWD/$_common_dir" 2>/dev/null && pwd -P || echo "")
            [ -n "$_cd_abs" ] && _scope_anchor=$(dirname "$_cd_abs") ;;
    esac
fi
if [ -f "$SCOPE_CONFIG" ] && jq empty < "$SCOPE_CONFIG" 2>/dev/null && [ -n "$_scope_anchor" ]; then
    while IFS=$'\t' read -r _prefix _label; do
        [ -z "$_prefix" ] && continue
        case "$_scope_anchor" in
            "$_prefix"|"$_prefix"/*)
                SCOPE_LABEL="$_label"
                break ;;
        esac
    done < <(jq -r '.scopes[]? | [.prefix, .label] | @tsv' "$SCOPE_CONFIG" 2>/dev/null)
fi
# Personal-scope fallback: @<handle> mirroring the sovereign ~handle. Reads
# as "this pane is anchored to you" - symmetrical with the leftmost ~handle.
if [ -z "$SCOPE_LABEL" ]; then
    if [ -n "$ALTER_ID" ]; then
        # `\~` to escape the tilde: bash would otherwise read `~` as the home-
        # directory expansion sigil and the strip would no-op (yielding `@~handle`).
        SCOPE_LABEL="@${ALTER_ID#\~}"
    elif [ -f "$SCOPE_CONFIG" ]; then
        _default=$(jq -r '.default_label // empty' "$SCOPE_CONFIG" 2>/dev/null)
        [ -n "$_default" ] && SCOPE_LABEL="$_default"
    fi
fi
SCOPE_BLOCK=""
if [ -n "$SCOPE_LABEL" ]; then
    SCOPE_BLOCK="${SCOPE_COLOR}${SCOPE_LABEL}${RST}"
fi

# Peers badge - ↔N other live CC sessions on the same project.
# Tier thresholds calibrated to the parallel-agent velocity floor (4-8 parallel):
#   1-3 lavender (light), 4-7 amber (peak), 8+ red (over recommended cap).
SIBLINGS_BADGE=""
if [ "$SIBLINGS" -gt 0 ]; then
    if   [ "$SIBLINGS" -ge 8 ]; then _sib_color=196
    elif [ "$SIBLINGS" -ge 4 ]; then _sib_color=215
    else                              _sib_color=141
    fi
    SIBLINGS_BADGE="\033[38;5;${_sib_color}m↔${SIBLINGS}${RST}"
fi


# ── CONTEXT BURNT: one number, health-coloured ───────────────────────────────
# What sat here was a "session value trajectory": an eight-cell bar over a
# composite of context, turn count and an agent-spawn bonus. It could not work
# as calibrated. The composite's context term was divided by (100 - 78), so it
# reached its ceiling the moment the window fell to 78% remaining and stayed
# pinned there for the remaining 78 points of the session. A bar that is full
# through nearly every session reports nothing, and on a fresh render, with no
# session log to supply the offsetting bonus, 78% remaining and 41% remaining
# drew the same eight filled cells.
#
# It is replaced by the number it was decorating. Context now reads as percent
# BURNT, rising from 0%, the same direction as the two rate-limit meters beside
# it. Each reads as a label plus a percent used, full is bad everywhere and
# empty is good everywhere. One grammar across all three windows.
#
# The bands are sized for a 1M window. The thresholds they replace were 200k
# numbers that were never revisited, which put the whole warning range past
# where a session normally goes and left the gauge unable to warn.
#
#   under 20%   green      plenty of room
#   20 to 30%   amber      the turn cost is climbing
#   30 to 40%   red        the band where a handover belongs
#   over 40%    red+bold   past where a session usually goes
_burnt=$(( 100 - REMAIN_INT ))
[ "$_burnt" -lt 0 ] && _burnt=0
[ "$_burnt" -gt 100 ] && _burnt=100
CTX_BOLD=""
if   [ "$_burnt" -ge 40 ]; then CTX_COLOR="$RED"; CTX_BOLD='\033[1m'
elif [ "$_burnt" -ge 30 ]; then CTX_COLOR="$RED"
elif [ "$_burnt" -ge 20 ]; then CTX_COLOR="$YELLOW"
else                            CTX_COLOR="$GREEN"
fi

# ── BURN: the two account burndowns ──────────────────────────────────────────
# Percentages, never token counts, each colouring by its own pressure (green
# under 70, amber to 90, red above), so a tightening limit is legible without
# reading the digits. Both windows show whenever the payload carries either;
# neither is inferred from the other.
BURN_TXT=""
BURN_W=0
if [ -n "$RL5_PCT" ] || [ -n "$RL7_PCT" ]; then
    _s5=$(awk "BEGIN {printf \"%.0f\", ${RL5_PCT:-0}}")
    _w7=$(awk "BEGIN {printf \"%.0f\", ${RL7_PCT:-0}}")
    if   [ "$_s5" -ge 90 ]; then _s5c="$RED"
    elif [ "$_s5" -ge 70 ]; then _s5c="$YELLOW"
    else                         _s5c="$GREEN"
    fi
    if   [ "$_w7" -ge 90 ]; then _w7c="$RED"
    elif [ "$_w7" -ge 70 ]; then _w7c="$YELLOW"
    else                         _w7c="$GREEN"
    fi
    BURN_TXT="${DIM}5h ${RST}${_s5c}${_s5}%${RST}${DIM} · week ${RST}${_w7c}${_w7}%${RST}"
    BURN_W=$(( 3 + ${#_s5} + 1 + 8 + ${#_w7} + 1 ))
fi

MODEL_SHORT=$(echo "$MODEL_NAME" \
    | sed 's/Claude //' \
    | sed 's/ Sonnet$/S/' \
    | sed 's/ Opus$/O/' \
    | sed 's/ Haiku$/H/' \
    | sed 's/ *([^)]*)$//')

# Model colour and the effort-suffix colour share ONE hue per model family, set
# here in a single place. The model name is bold + brightest in that hue; the
# effort suffix is a non-bold, dimmer shade of the SAME hue, ramped by level
# (low = darkest, max = brightest-but-still-below-the-model). So Opus renders
# gold with a gold effort ramp, Sonnet blue with a blue ramp, and so on. The
# ramp arrays are five indexed shades: low, medium, high, xhigh, max.
# Indexed arrays only (bash 3.2 / stock macOS safe); no assoc arrays.
case "$MODEL_SHORT" in
    Opus*)   MODEL_COL='\033[1;38;5;220m'; _eff_ramp=(94 130 136 172 178) ;;  # gold
    Fable*)  MODEL_COL='\033[1;38;5;213m'; _eff_ramp=(53 90 127 163 170) ;;  # magenta
    Sonnet*) MODEL_COL='\033[1;38;5;45m';  _eff_ramp=(23 24 31 32 38) ;;     # blue
    Haiku*)  MODEL_COL='\033[1;38;5;84m';  _eff_ramp=(22 28 34 71 78) ;;     # green
    *)       MODEL_COL='\033[1;38;5;45m';  _eff_ramp=(23 24 31 32 38) ;;     # blue
esac
MODEL_EFFORT_SFX=""
MODEL_EFFORT_COL="$RST"
if [ -n "$MODEL_EFFORT" ]; then
    MODEL_EFFORT_SFX=":${MODEL_EFFORT}"
    case "$MODEL_EFFORT" in
        low)    _ei=0 ;;
        medium) _ei=1 ;;
        high)   _ei=2 ;;
        xhigh)  _ei=3 ;;
        max)    _ei=4 ;;
        *)      _ei=2 ;;
    esac
    MODEL_EFFORT_COL='\033[38;5;'"${_eff_ramp[$_ei]}"'m'
fi



# ═══════════════════════════════════════════════════════════════════════════════
# WARDROBE - config-driven segment rendering
# Config-driven statusline customisation. Each segment renders from observed
# state: f(session) -> rendered line.
# Config: ~/.config/alter/statusline-wardrobe.json
# Array order = render order = overflow priority (first survives, last drops).
# ═══════════════════════════════════════════════════════════════════════════════

declare -A _R _W _A

seg_identity() {
    _A[identity]=1
    local r="" w="" o
    case "$ALTER_STATE" in
        live)    r="${SOVEREIGN}${ALTER_ID}${RST}"; w="$ALTER_ID" ;;
        refresh) r="${YELLOW}${ALTER_ID}${RST}"; w="$ALTER_ID" ;;
        dead)    r="${RED}${ALTER_ID}${RST}"; w="$ALTER_ID" ;;
        *)       r="${DIM}~?${RST}"; w="~?" ;;
    esac
    # Every tier renders, L4 included. Suppressing the top tier meant the one
    # fact a member most often wants confirmed, what they have consented to
    # share, was visible at L1 to L3 and invisible at L4, which is the tier
    # where the most is being shared.
    if [ -n "$ALTER_LEVEL" ]; then
        r+=" ${DIM}${ALTER_LEVEL}${RST}"; w+=" $ALTER_LEVEL"
    fi
    if [ "${#ALTER_ORGS[@]}" -gt 0 ]; then
        local -a shown=("${ALTER_ORGS[@]:0:3}")
        local overflow=$(( ${#ALTER_ORGS[@]} - ${#shown[@]} ))
        r+=" ${COUPLING}⌥${RST}  "; w+=" ⌥  "
        for o in "${shown[@]}"; do r+="${COLLECTIVE}${o}${RST} "; w+="${o} "; done
        [ "$overflow" -gt 0 ] && { r+="${DIM}+${overflow}${RST} "; w+="+${overflow} "; }
        r="${r% }"; w="${w% }"
    fi
    _R[identity]="$r"; _W[identity]=${#w}
}

seg_model() {
    _A[model]=1
    # Model name is the dominant element: bold + the brightest shade of its
    # family hue (set once, above, alongside the matching effort ramp). The
    # effort suffix is a non-bold, dimmer same-hue shade below the model name.
    local mc="$MODEL_COL"
    _R[model]="${mc}${MODEL_SHORT}${RST}${MODEL_EFFORT_COL}${MODEL_EFFORT_SFX}${RST}"
    _W[model]=$(( ${#MODEL_SHORT} + ${#MODEL_EFFORT_SFX} ))
}

seg_context() {
    _A[context]=1
    _R[context]="${DIM}ctx ${RST}${CTX_COLOR}${CTX_BOLD}${_burnt}%${RST}"
    _W[context]=$(( 4 + ${#_burnt} + 1 ))
}

seg_burn() {
    # Dark when the payload carries neither window, so an older or trimmed
    # payload costs the line nothing rather than showing a false 0%.
    [ -z "$BURN_TXT" ] && { _A[burn]=0; return; }
    _A[burn]=1
    _R[burn]="$BURN_TXT"; _W[burn]=$BURN_W
}

# ── Line 2, what the member owns ─────────────────────────────────────────────
# Line 1 is the session. Line 2 is the member: what they have earned, how far
# their recognition has accrued, and who is present. Every segment reads a file
# the alter-runtime daemon already writes, and none of them shells out. The
# daemon projects identity state into ~/.cache/alter/identity.json precisely so
# shell integrations get live state without a round trip, and it writes the
# presence feed for the peers pane; both are read here as-is.
#
# Absent daemon, absent file, or unparseable JSON all collapse to a dark
# segment. Silent skip is the floor the daemon's own writers hold to, and it is
# the right one: a member who is not logged in, or whose daemon is not running,
# gets line 1 alone rather than a row of zeroes claiming they have earned
# nothing.
MEMBER_INCOME=""
MEMBER_ATTUNE=""
_ident_cache="${XDG_CACHE_HOME:-$HOME/.cache}/alter/identity.json"
if [ -r "$_ident_cache" ]; then
    # One jq pass for both fields. The daemon writes every value as a string
    # and substitutes "" for a field it could not source, so an empty result
    # here means "not known", never "zero".
    IFS=$'\t' read -r MEMBER_INCOME MEMBER_ATTUNE < <(
        jq -r '[(.income // ""), (.attunement // "")] | @tsv' "$_ident_cache" 2>/dev/null
    )
fi

# Peers currently broadcasting. The feed carries one JSON object per line
# ({sender, state, sent_at, until}) and the daemon has already dropped rows
# whose declared window closed, so every line present is a live peer. Distinct
# senders only, most recent last, which is append order.
PEER_NAMES=()
_peer_feed="${XDG_DATA_HOME:-$HOME/.local/share}/alter-runtime/presence-feed.jsonl"
if [ -r "$_peer_feed" ]; then
    while IFS= read -r _p; do
        [ -n "$_p" ] && PEER_NAMES+=("$_p")
    done < <(tail -n 200 "$_peer_feed" 2>/dev/null \
        | jq -r 'select(type == "object") | .sender // empty' 2>/dev/null \
        | awk '!seen[$0]++' 2>/dev/null)
fi

seg_earn() {
    # Earnings are the member's own money, so this reads as money, never as a
    # score. With no figure sourced the segment still renders a placeholder,
    # which `full` shows and `alerts` drops; a segment that returns without a
    # render is dropped by BOTH modes and makes `full` a synonym for `alerts`.
    if [ -z "$MEMBER_INCOME" ]; then
        _A[earn]=0; _R[earn]="${DIM}earned \$-${RST}"; _W[earn]=9; return
    fi
    _A[earn]=1
    local t="earned \$${MEMBER_INCOME}"
    _R[earn]="${DIM}earned ${RST}${GREEN}\$${MEMBER_INCOME}${RST}"
    _W[earn]=${#t}
}

seg_attune() {
    # Attunement arrives either as a decimal 0..1 or as an integer percentage,
    # so both are normalised to a percentage here rather than trusting one
    # shape. A value at or below 1 with a decimal point is a fraction.
    local pct=""
    if [ -n "$MEMBER_ATTUNE" ]; then
        pct=$(awk -v v="$MEMBER_ATTUNE" 'BEGIN {
            if (v == "" || v + 0 != v) { print ""; exit }
            if (v <= 1) v = v * 100
            printf "%.0f", v
        }' 2>/dev/null)
    fi
    if [ -z "$pct" ]; then
        _A[attune]=0; _R[attune]="${DIM}attunement -${RST}"; _W[attune]=12; return
    fi
    _A[attune]=1
    local t="attunement ${pct}%"
    local c="$CYAN"
    [ "$pct" -lt 25 ] 2>/dev/null && c="$DIM"
    _R[attune]="${DIM}attunement ${RST}${c}${pct}%${RST}"
    _W[attune]=${#t}
}

seg_peers() {
    # Named, because a count is not a person. Two names then an overflow
    # marker, so the segment cannot grow without bound on a busy field.
    local n=${#PEER_NAMES[@]}
    if [ "$n" -eq 0 ]; then
        _A[peers]=0; _R[peers]="${DIM}with -${RST}"; _W[peers]=6; return
    fi
    _A[peers]=1
    local shown=("${PEER_NAMES[@]:0:2}")
    local t="with" r="${DIM}with${RST}"
    local p
    for p in "${shown[@]}"; do
        t+=" ${p}"; r+=" ${MAGENTA}${p}${RST}"
    done
    local over=$(( n - ${#shown[@]} ))
    if [ "$over" -gt 0 ]; then
        t+=" +${over}"; r+=" ${DIM}+${over}${RST}"
    fi
    _R[peers]="$r"; _W[peers]=${#t}
}


seg_scope() {
    [ -z "$SCOPE_LABEL" ] && { _A[scope]=0; return; }
    _A[scope]=1
    _R[scope]="${SCOPE_COLOR}${SCOPE_LABEL}${RST}"; _W[scope]=${#SCOPE_LABEL}
}

seg_branch() {
    _A[branch]=1
    local b="${GIT_BRANCH:--}"
    _R[branch]="${BRANCH_COLOR}${b}${RST}"; _W[branch]=${#b}
}

seg_inbox() {
    # zero: always-visible dim placeholder. unread: steady amber cue, present but
    # quiet. new: glimmer (blink, bold, hot orange) so a fresh arrival is
    # unmistakable, settling back to the unread cue after the window lapses.
    if [ "$MAIL_STATE" = "zero" ]; then
        _A[inbox]=0; _R[inbox]="${DIM}mail:-${RST}"; _W[inbox]=6; return
    fi
    _A[inbox]=1
    if [ "$MAIL_STATE" = "new" ]; then
        # \033[5m is the blink (the glimmer); bold and hot orange keep it
        # prominent on terminals that suppress blink.
        _R[inbox]='\033[5;1;38;5;208mmail:'"${INBOX_PEER}"'\033[0m'
        _W[inbox]=$(( 5 + ${#INBOX_PEER} ))
    else
        local sc="$AMBER"; [ "$INBOX_PEER" -ge 5 ] && sc="$AMBER_HOT"
        _R[inbox]="${sc}mail:${INBOX_PEER}${RST}"; _W[inbox]=$(( 5 + ${#INBOX_PEER} ))
    fi
}



# (peers segment retired: the ↔N peer-session count is now folded into
# seg_descriptor so it no longer occupies its own segment.)


seg_descriptor() {
    # Per-session pane label, with the peer-session count (↔N) folded in
    # beside it: both answer "which session am I, and how many peers are live",
    # so they share one grouping instead of the peer count owning a segment.
    local _sib="" _sibw=0
    if [ "$SIBLINGS" -gt 0 ]; then
        local sc
        if   [ "$SIBLINGS" -ge 8 ]; then sc="\033[38;5;196m"
        elif [ "$SIBLINGS" -ge 4 ]; then sc="\033[38;5;215m"
        else                              sc="\033[38;5;141m"; fi
        _sib="${sc}↔${SIBLINGS}${RST}"; _sibw=$(( 1 + ${#SIBLINGS} ))
    fi
    if [ -z "$_lbl" ]; then
        # No pane label: still surface the peer count if there is one.
        if [ -n "$_sib" ]; then
            _A[descriptor]=1; _R[descriptor]="$_sib"; _W[descriptor]=$_sibw
        else
            _A[descriptor]=0
        fi
        return
    fi
    _A[descriptor]=1
    local _txt
    if [ -n "$_pill_bg" ]; then
        _txt="\033[3;38;5;${_pill_bg}m${_lbl}${RST}"
    else
        _txt="${ITALIC_DIM}${_lbl}${RST}"
    fi
    if [ -n "$_sib" ]; then
        _R[descriptor]="${_txt} ${_sib}"; _W[descriptor]=$(( ${#_lbl} + 1 + _sibw ))
    else
        _R[descriptor]="$_txt"; _W[descriptor]=${#_lbl}
    fi
}

# ── Load wardrobe ────────────────────────────────────────────────────────────
_WARDROBE="${XDG_CONFIG_HOME:-$HOME/.config}/alter/statusline-wardrobe.json"
_SEP_W=3

_DEFAULT_ORDER=(identity branch descriptor context burn model inbox scope)
# burn is deliberately absent here. It is a signal segment, so it renders only
# on a payload that actually carries the rate-limit windows.
_DEFAULT_VIS_ALWAYS="identity branch context model inbox scope"

declare -a _ORDER
declare -A _ENABLED _VIS
if [ -f "$_WARDROBE" ] && jq empty < "$_WARDROBE" 2>/dev/null; then
    while IFS=$'\t' read -r _sid _en _vis; do
        [ -z "$_sid" ] && continue
        _ORDER+=("$_sid")
        _ENABLED[$_sid]="$_en"
        _VIS[$_sid]="${_vis:-signal}"
    done < <(jq -r '.segments[]? | [.id, (if has("enabled") then .enabled else true end | tostring), (.visibility // "signal")] | @tsv' "$_WARDROBE" 2>/dev/null)
else
    _ORDER=("${_DEFAULT_ORDER[@]}")
    for _s in "${_DEFAULT_ORDER[@]}"; do _ENABLED[$_s]="true"; _VIS[$_s]="signal"; done
    for _s in $_DEFAULT_VIS_ALWAYS; do _VIS[$_s]="always"; done
fi

for _sid in "${_ORDER[@]}"; do
    [ "${_ENABLED[$_sid]}" = "true" ] || continue
    type -t "seg_${_sid}" &>/dev/null && "seg_${_sid}"
done

declare -a _VISIBLE
for _sid in "${_ORDER[@]}"; do
    [ "${_ENABLED[$_sid]}" = "true" ] || continue
    [ -z "${_R[$_sid]+x}" ] && continue
    if [ "${_VIS[$_sid]}" = "signal" ] && [ "${_A[$_sid]}" != "1" ]; then continue; fi
    _VISIBLE+=("$_sid")
done

_TERM_W=${COLUMNS:-120}
while [ ${#_VISIBLE[@]} -gt 1 ]; do
    _total=0; _n=0
    for _sid in "${_VISIBLE[@]}"; do
        [ "$_n" -gt 0 ] && _total=$(( _total + _SEP_W ))
        _total=$(( _total + ${_W[$_sid]:-0} ))
        _n=$(( _n + 1 ))
    done
    [ "$_total" -le "$_TERM_W" ] && break
    _VISIBLE=("${_VISIBLE[@]:0:$(( ${#_VISIBLE[@]} - 1 ))}")
done

_LINE=""; _first=1
for _sid in "${_VISIBLE[@]}"; do
    [ "$_first" -eq 1 ] && _first=0 || _LINE+="${DIM} │ ${RST}"
    _LINE+="${_R[$_sid]}"
done

echo -e "$_LINE"

# ── Line 2 ───────────────────────────────────────────────────────────────────
# `line2_mode` in the wardrobe, three values:
#   alerts  the default, and what a new install gets. The line appears only
#           when a member segment has something to say, so a quiet field costs
#           no vertical space at all.
#   full    every enabled member segment renders, dim when it has no data, so
#           the row is in a fixed place and can be read by position.
#   off     no second line, ever.
# The default is `alerts` rather than `full` because a second row that is
# permanently present but usually empty is a row the eye learns to skip, and
# the point of these three is that they are worth looking at when they change.
_LINE2_MODE=$(jq -r '.line2_mode // "alerts"' "$_WARDROBE" 2>/dev/null)
case "$_LINE2_MODE" in alerts|full|off) ;; *) _LINE2_MODE="alerts" ;; esac

if [ "$_LINE2_MODE" != "off" ]; then
    _DEFAULT_ORDER2=(earn attune peers)
    declare -a _ORDER2
    if [ -f "$_WARDROBE" ] && jq -e '.segments2? | arrays' "$_WARDROBE" >/dev/null 2>&1; then
        while IFS=$'\t' read -r _sid _en _vis; do
            [ -z "$_sid" ] && continue
            _ORDER2+=("$_sid")
            _ENABLED[$_sid]="$_en"
            _VIS[$_sid]="${_vis:-signal}"
        done < <(jq -r '.segments2[]? | [.id, (if has("enabled") then .enabled else true end | tostring), (.visibility // "signal")] | @tsv' "$_WARDROBE" 2>/dev/null)
    else
        _ORDER2=("${_DEFAULT_ORDER2[@]}")
        for _s in "${_DEFAULT_ORDER2[@]}"; do _ENABLED[$_s]="true"; _VIS[$_s]="signal"; done
    fi

    for _sid in "${_ORDER2[@]}"; do
        [ "${_ENABLED[$_sid]}" = "true" ] || continue
        type -t "seg_${_sid}" &>/dev/null && "seg_${_sid}"
    done

    declare -a _VISIBLE2
    for _sid in "${_ORDER2[@]}"; do
        [ "${_ENABLED[$_sid]}" = "true" ] || continue
        [ -z "${_R[$_sid]+x}" ] && continue
        # In `full` a segment with no data still holds its place; in `alerts`
        # it drops, and a line with nothing left drops with it.
        if [ "$_LINE2_MODE" = "alerts" ] && [ "${_A[$_sid]}" != "1" ]; then continue; fi
        _VISIBLE2+=("$_sid")
    done

    # Same right-to-left shed as line 1, so a narrow pane loses the last
    # segment rather than wrapping the row.
    while [ ${#_VISIBLE2[@]} -gt 1 ]; do
        _total=0; _n=0
        for _sid in "${_VISIBLE2[@]}"; do
            [ "$_n" -gt 0 ] && _total=$(( _total + _SEP_W ))
            _total=$(( _total + ${_W[$_sid]:-0} ))
            _n=$(( _n + 1 ))
        done
        [ "$_total" -le "$_TERM_W" ] && break
        _VISIBLE2=("${_VISIBLE2[@]:0:$(( ${#_VISIBLE2[@]} - 1 ))}")
    done

    if [ ${#_VISIBLE2[@]} -gt 0 ]; then
        _LINE_2=""; _first=1
        for _sid in "${_VISIBLE2[@]}"; do
            [ "$_first" -eq 1 ] && _first=0 || _LINE_2+="${DIM} │ ${RST}"
            _LINE_2+="${_R[$_sid]}"
        done
        echo -e "$_LINE_2"
    fi
fi
