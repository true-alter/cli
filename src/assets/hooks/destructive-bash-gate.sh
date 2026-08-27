#!/usr/bin/env bash
# destructive-bash-gate.sh: PreToolUse hook. ERGONOMIC GUARDRAIL, NOT A BOUNDARY.
#
# ══ READ THIS BEFORE YOU FIX IT ══════════════════════════════════════════════
# THIS GATE IS NOT A SECURITY BOUNDARY AND CANNOT BE MADE INTO ONE. Do not fix
# it as though it were. Six independent catches on one function in a single day
# are not six unlucky bugs; they are a design verdict. The boundary is
# CAPABILITY, this file is ergonomics.
#
# WHY, structurally: this hook receives a command STRING and must decide what it
# would DO. That is undecidable. `python3 -c "import os; os.system('flyctl apps
# destroy x')"` is ALLOWED here today, and closing it means parsing Python;
# closing `node -e` means parsing JavaScript, recursively, forever. A perfect
# parser still does not close `os.system(base64.b64decode(x))`. Five successive
# fixes each widened the seed by one frame (verbs → bash grammar → …) and each
# stayed inside the language its author was reading. There is no sixth frame
# that finishes the job.
#
# WHAT ACTUALLY HOLDS, per class:
#   git / GitHub destruction  → GitHub branch protection, live + unconditional.
#                               The git checks below are defence in depth.
#   Fly / Cloudflare / cloud  → SCOPED CREDENTIALS. A destroy the token cannot
#                               authorise is unreachable, not merely unmatched.
#   database DROP / TRUNCATE  → Postgres role grants: the session's role simply
#                               has no DROP/TRUNCATE. Closes every invocation
#                               form at once (psql, dropdb, python driver, curl
#                               to the SQL endpoint) because none of them can
#                               grant themselves a privilege.
#   local rm -rf              → NO effect layer exists on a single-user box.
#                               This class stays string-level PERMANENTLY, with
#                               filesystem snapshots (root-owned, so a session
#                               cannot remove them) as the only real backstop.
#
# SO WHAT IS THIS FILE FOR? Catching a HALLUCINATED plain-form command cheaply,
# before it runs. That is a real and common failure and this gate is good at it.
# It is worth keeping for exactly that. It is not worth another parser fix, and
# a clean run of it is NOT evidence that a destructive act was prevented.
#
# ACCIDENTAL INVARIANTS, undesigned properties this file currently leans on.
# Recorded so the next change does not break them unknowingly:
#   (1) `split_compound` tracks PAREN depth but never BRACE depth. That is why
#       __has_function_def is the only guard catching `f(){ …; }; f`. Nobody
#       designed that; do not remove that guard on the assumption something
#       else covers the form.
#   (2) FAIL-OPEN on parse error (below) means every hardening change trades a
#       wedged session against a missed command. That tradeoff was chosen when
#       this gate was believed to be the boundary. It is now the correct call
#       for the opposite reason: an ergonomic aid must never wedge the session,
#       because the boundary no longer depends on it.
#
# MECHANICS: (1) detects wrapper forms via mini-parser, (2) extracts the inner
# quoted payload, (3) recurses (max depth 3), (4) splits compound cmds on
# top-level &&/||/;/|/&, (5) prefix-matches FIRST TOKEN of each segment.
# echo/grep/printf/cat/… as first token → data, not command → pass.
#
# KNOWN-OPEN BY DESIGN: `is_data_cmd` treats python/python3/node/ruby/perl/php/
# curl/wget as data commands and declines to look inside them. That is correct
# for `echo "flyctl apps destroy x"` and wrong for `python3 -c <code>`, and it
# is LEFT OPEN deliberately, because the effect layer closes those classes and
# a parser cannot. Do not "fix" this by removing the exemption: that trades a
# hole you can see for a flood of false positives on every legitimate
# `python3 -c` and `curl`, and closes nothing, since the payload is still
# arbitrary code in another language.
#
# LAYERS: deny[] in settings.json (floor) → THIS hook (wrapper-aware) → WORM/CI
# FAIL-OPEN: any parse error → {"continue":true} (wedging session is worse).
#
# Two further rungs beyond the plain destructive-verb match: (a) an unpinned
# git-mutation gate plus an unpinned-read advisory, because an un-pinned git
# mutation binds to whatever repo the ambient CWD points at; (b) a hard block on
# `git commit --no-verify` and on every `git push` force form, both of which are
# convenience bypasses around checks that were put there on purpose.

set -uo pipefail
MAX_DEPTH=3
LOG_DIR="${HOME}/.local/share/alter/cc/destructive-gate"
# Shared once-per-session latch, used for ADVISORY suppression only (see
# emit_advisory). Every BLOCKING decision in this file is untouched and never
# consults it. Sourced, not required: a missing helper leaves _once_per
# undefined and emit_advisory falls back to its prior always-fires behaviour.
source "$(dirname "$0")/_hook-latch.sh" 2>/dev/null || true

command -v jq >/dev/null 2>&1 || { printf '{"continue":true}\n'; exit 0; }
INPUT=$(cat)
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) \
    || { printf '{"continue":true}\n'; exit 0; }

log_event() {   # $1=decision $2=label $3=orig_cmd $4=inner
    mkdir -p "$LOG_DIR" 2>/dev/null || return 0
    printf '%s\t%s\t%s\t%s\t%s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" "$1" "$2" "$3" "${4:-}" \
        >> "${LOG_DIR}/events.log" 2>/dev/null || true
}
emit_pass() { printf '{"continue":true}\n'; exit 0; }
do_block() {    # $1=label $2=inner $3=orig_cmd
    local msg="~Alter guardrail: blocked pattern '${1}'"
    [[ -n "${2:-}" ]] && msg="${msg} (inner: ${2})"
    msg="${msg}. Run manually outside CC if intentional. Log: ${LOG_DIR}/events.log"
    local j; j=$(printf '%s' "$msg" | jq -Rs '.') 2>/dev/null || j='"blocked"'
    log_event "BLOCK" "$1" "${3:-}" "${2:-}"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' "$j"; exit 0
}

# ── MCP silent-rewrite block ─────────────────────────────────────────────────
# Matched on the VERB, never on the server. Any MCP server can expose a tool
# that rewrites a file or a stored memory in place, with no diff for anyone to
# read, and the risk is the verb rather than whose server it came from. Naming
# servers meant the block covered exactly the ones already enumerated and none
# of the ones a member happens to run, so the prefix is stripped and only the
# verb is compared. The comparison stays an exact list rather than a glob:
# `*delete*` would swallow tools a member is entitled to call on their own
# records, such as deleting one of their own journal entries.
case "$TOOL_NAME" in
  mcp__*__*) _verb="${TOOL_NAME#mcp__*__}" ;;
  *)         _verb="" ;;
esac
case "$_verb" in
    delete_memory|safe_delete_symbol|\
    replace_content|rename_symbol|\
    replace_symbol_body|replace_regex)
        log_event "BLOCK" "mcp-silent-rewrite" "$TOOL_NAME" ""
        _m="~Alter guardrail: ${TOOL_NAME} is a silent-rewrite vector. Use Edit/Write instead."
        _j=$(printf '%s' "$_m" | jq -Rs '.') 2>/dev/null || _j='"blocked"'
        printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' "$_j"; exit 0 ;;
esac

[[ "$TOOL_NAME" == "Bash" ]] || emit_pass
ORIG_CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null) || emit_pass
[[ -z "$ORIG_CMD" ]] && emit_pass
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "global"' 2>/dev/null) || SESSION_ID="global"
[[ -z "$SESSION_ID" ]] && SESSION_ID="global"

# ── Data-command guard (first token → segment is data) ───────────────────────
is_data_cmd() {
    case "$1" in
        echo|printf|cat|head|tail|grep|sed|awk|jq|fzf|less|more|\
        wc|sort|uniq|tee|tr|cut|paste|diff|comm|find|ls|stat|file|\
        type|which|whereis|curl|wget|http|python|python3|node|ruby|\
        perl|php|true|false|test|read|wait|sleep) return 0 ;;
    esac; return 1
}

# ── Wrapper unwrapper ─────────────────────────────────────────────────────────
UNWRAPPED=0 UNWRAPPED_INNER=""
extract_inner() {
    local cmd="${1#"${1%%[![:space:]]*}"}"; UNWRAPPED=0; UNWRAPPED_INNER=""
    local rest="" p_interp='(^|[[:space:]])(bash|sh|dash|zsh)([[:space:]]+-[^c][^[:space:]]*)*[[:space:]]+-c[[:space:]]'
    if [[ "$cmd" =~ $p_interp ]]; then
        rest="${cmd#*-c }"; [[ "$rest" == "$cmd" ]] && rest="${cmd#*-c	}"
    elif [[ "$cmd" =~ ^eval[[:space:]] ]]; then
        rest="${cmd#eval }"; [[ "$rest" == "$cmd" ]] && rest="${cmd#eval	}"
    else return 0; fi
    rest="${rest#"${rest%%[![:space:]]*}"}"; [[ -z "$rest" ]] && return 0
    local inner="" remaining
    if [[ "${rest:0:1}" == "'" ]]; then
        remaining="${rest:1}"
        while [[ -n "$remaining" ]]; do
            local ch="${remaining:0:1}"
            if [[ "$ch" == "'" ]]; then
                if [[ "${remaining:1:3}" == "\\'''" || "${remaining:1:2}" == "\\''" ]]; then
                    inner="${inner}'" remaining="${remaining:4}"
                else break; fi
            else inner="${inner}${ch}" remaining="${remaining:1}"; fi
        done
    elif [[ "${rest:0:1}" == '"' ]]; then
        remaining="${rest:1}"
        while [[ -n "$remaining" ]]; do
            local ch="${remaining:0:1}"
            if [[ "$ch" == '\\' ]]; then inner="${inner}${remaining:1:1}" remaining="${remaining:2}"
            elif [[ "$ch" == '"' ]]; then break
            else inner="${inner}${ch}" remaining="${remaining:1}"; fi
        done
    else inner="${rest%%[[:space:]]*}"; fi
    [[ -n "$inner" ]] && { UNWRAPPED=1; UNWRAPPED_INNER="$inner"; }
}

# ── Compound command splitter ─────────────────────────────────────────────────
declare -a SEGMENTS=()
split_compound() {
    local cmd="$1"; SEGMENTS=()
    local seg="" in_sq=0 in_dq=0 depth=0 i=0 len=${#cmd}
    # Heredocs declared on the CURRENT line, drained at the newline that ends it.
    local -a HEREDOC_DELIMS=() HEREDOC_DASH=()
    while (( i < len )); do
        local ch="${cmd:$i:1}" ch2="${cmd:$i:2}"
        # Inside SINGLE quotes a backslash-newline is LITERAL text, not a line
        # continuation, so it is preserved verbatim. This branch must stay first.
        if (( in_sq )); then [[ "$ch" == "'" ]] && in_sq=0; seg="${seg}${ch}"; (( i++ )); continue; fi
        if (( in_dq )); then
            # Bash removes a line continuation inside double quotes too, so drop
            # it here as well: keeping it would corrupt an extracted payload (a
            # psql -c body wrapped across lines) relative to what actually runs.
            #
            # NOTE the comparison form. `[[ $ch == '\\' ]]`, which this branch used
            # to say, compares against the TWO-character string \\ (single quotes
            # are literal, so both backslashes survive) and therefore NEVER matches
            # a one-character $ch. It was dead code, so the escape handling below
            # has never once fired: a `\"` inside a double-quoted payload toggled
            # in_dq off and desynced the quote state. `"\\"` is one backslash.
            if [[ "$ch" == "\\" && "${cmd:$((i+1)):1}" == $'\n' ]]; then (( i+=2 )); continue; fi
            if [[ "$ch" == "\\" ]]; then seg="${seg}${ch}${cmd:$((i+1)):1}"; (( i+=2 )); continue; fi
            [[ "$ch" == '"' ]] && in_dq=0; seg="${seg}${ch}"; (( i++ )); continue
        fi
        # LINE CONTINUATION, unquoted. Bash strips `\<newline>` during parsing,
        # before any word-splitting, so the shell runs `git push --force` while a
        # gate that keeps the backslash tokenises t1 as `\` and dispatches on
        # nothing. That is a fail-OPEN on every class this gate guards, and it
        # fires on the most idiomatic multi-line form there is (`cd <dir> && \`
        # then the real command).
        #
        # Substitute a SPACE, and note this diverges from bash DELIBERATELY. Bash
        # removes the continuation entirely and WELDS the tokens, so `git\<nl>push`
        # really does run as `gitpush` (command not found). Splitting on a space
        # instead means the gate reads `git push --force` where bash would run a
        # harmless typo. That is a false POSITIVE, never a false negative: it can
        # only ever deny something bash would not have run, and the alternative
        # (weld faithfully) would hand back a t1 of `gitpush` that matches no
        # dispatch branch, which is a fail-OPEN the moment a real continuation
        # lands mid-token. Fail closed on the ambiguity.
        if [[ "$ch" == "\\" && "${cmd:$((i+1)):1}" == $'\n' ]]; then
            seg="${seg} "; (( i+=2 )); continue; fi
        # HEREDOC. A heredoc BODY is data to bash: it is fed to the command's stdin
        # and never executed. So the gate must not read it as commands, for exactly
        # the reason it must not miss a real one, the tokeniser has to see what bash
        # sees. This became load-carrying the moment a bare newline started
        # separating segments (below): without it, every body LINE becomes its own
        # segment, and a commit message or doc that merely QUOTES a dangerous
        # command gets denied. Verified: 3 of 4 heredoc-body cases flipped to a
        # false positive before this branch existed. A guard that fights you when
        # you document a fix is a guard you learn to route around.
        #
        # `<<<` is a here-STRING (one word), not a heredoc, so it is excluded AND
        # CONSUMED WHOLE. Skipping it one character at a time re-reads its 2nd and
        # 3rd `<` as a fresh `<<`, which then parses the here-string's argument as a
        # heredoc delimiter and swallows the rest of the input hunting a terminator
        # that never comes. That was a real fail-open (`cat <<<'x'` then a
        # force-push, allowed) caught by probing this branch's own new behaviour.
        # Unterminated heredocs are handled by skipping to end-of-input, which is
        # FAITHFUL: bash swallows the rest as body and executes none of it.
        [[ "$ch" == '(' ]] && (( depth++ ))
        [[ "$ch" == ')' && depth -gt 0 ]] && (( depth-- ))
        # Inside `( … )` everything accumulates into ONE segment, so the heredoc
        # queue must not run here. The drain lives in the newline branch below,
        # which this depth branch PREEMPTS, so a heredoc queued inside a subshell
        # never drains: it survives, then fires at the first depth-0 newline and
        # skips forward hunting a terminator already consumed, swallowing real
        # commands as body. That was a fail-OPEN introduced by the queue model
        # (`(cat <<EOF … EOF)` then a force-push, denied before and allowed after).
        # Ordering IS the fix: nothing queues at depth, so nothing can survive.
        if (( depth > 0 )); then seg="${seg}${ch}"; (( i++ )); continue; fi
        if [[ "${cmd:$i:3}" == '<<<' ]]; then seg="${seg}<<<"; (( i+=3 )); continue; fi
        if [[ "$ch2" == '<<' ]]; then
            local j=$((i+2)) dash=0 delim="" q="" have=0
            [[ "${cmd:$j:1}" == '-' ]] && { dash=1; (( j++ )); }
            while [[ "${cmd:$j:1}" == ' ' || "${cmd:$j:1}" == $'\t' ]]; do (( j++ )); done
            local dq="${cmd:$j:1}"
            if [[ "$dq" == "'" || "$dq" == '"' ]]; then
                # A quoted delimiter may legitimately be EMPTY (`cat <<''`), whose
                # terminator is an empty line. Gate on `have`, never on a non-empty
                # delim: testing `-n $delim` skipped the branch, body lines became
                # segments, and documentation got denied.
                q="$dq"; (( j++ )); have=1
                while (( j < len )) && [[ "${cmd:$j:1}" != "$q" ]]; do delim="${delim}${cmd:$j:1}"; (( j++ )); done
                (( j++ ))
            else
                # `<<\EOF` is bash's third quoting form for a delimiter (suppresses
                # expansion, same as quotes). The backslash is not part of the word.
                [[ "${cmd:$j:1}" == "\\" ]] && (( j++ ))
                while (( j < len )) && [[ "${cmd:$j:1}" =~ [A-Za-z0-9_] ]]; do delim="${delim}${cmd:$j:1}"; (( j++ )); done
                [[ -n "$delim" ]] && have=1
            fi
            if (( have )); then
                # QUEUE the heredoc; do NOT skip the body from here. Bash finishes
                # parsing the REST OF THE LINE first and only then reads bodies, so a
                # `cat <<EOF && git push --force` runs the push. Jumping straight to
                # the body discarded everything after the delimiter on that line, and
                # that was a fail-OPEN this branch INTRODUCED: the gate denied that
                # shape before the heredoc work and allowed it after. Queuing is what
                # makes the parser agree with bash, and it gets `cat <<A <<B` (bodies
                # read in order, on one line) right for the same reason.
                HEREDOC_DELIMS+=("$delim"); HEREDOC_DASH+=("$dash")
                seg="${seg}${cmd:$i:$((j-i))}"; i=$j; continue
            fi
        fi
        if [[ "$ch" == "'" ]]; then in_sq=1; seg="${seg}${ch}"; (( i++ )); continue; fi
        if [[ "$ch" == '"' ]]; then in_dq=1; seg="${seg}${ch}"; (( i++ )); continue; fi
        if [[ "$ch2" == '&&' || "$ch2" == '||' ]]; then
            [[ -n "${seg// }" ]] && SEGMENTS+=("$seg"); seg=""; (( i+=2 )); continue; fi
        # A bare NEWLINE is a command separator in bash, exactly like `;`. The
        # splitter used to append it to the current segment, so `cd /tmp<newline>
        # git push --force` stayed ONE segment, t1 tokenised as `cd` (or `echo`,
        # which is_data_cmd then shields entirely), and every command after the
        # first line was invisible to the gate. That is the same fail-OPEN as the
        # line-continuation hole and it is WIDER: it needs no backslash and no
        # intent, and the Bash tool accepts multi-line commands routinely. Found by
        # the independent re-gate of the continuation fix, verified by execution
        # (bash runs both lines; the gate saw only the first).
        # Carriage return is included so a CRLF line ending separates too, rather
        # than welding \r onto the next token.
        if [[ "$ch" == $'\n' || "$ch" == $'\r' ]]; then
            [[ -n "${seg// }" ]] && SEGMENTS+=("$seg"); seg=""; (( i++ ))
            # THIS is where bash reads the bodies of any heredocs queued on the line
            # just ended, in the order they were declared. Skip each to its
            # terminator: a body is stdin data, never commands.
            if (( ${#HEREDOC_DELIMS[@]} > 0 )); then
                local hd_i
                for hd_i in "${!HEREDOC_DELIMS[@]}"; do
                    local hdelim="${HEREDOC_DELIMS[$hd_i]}" hdash="${HEREDOC_DASH[$hd_i]}"
                    while (( i <= len )); do
                        local eol=$i
                        while (( eol < len )) && [[ "${cmd:$eol:1}" != $'\n' ]]; do (( eol++ )); done
                        local line="${cmd:$i:$((eol-i))}"
                        line="${line%$'\r'}"
                        # `<<-` strips leading TABS ONLY. Stripping all whitespace
                        # made a space-indented line terminate a body bash would have
                        # kept reading, which denied data as a command.
                        if (( hdash )); then while [[ "$line" == $'\t'* ]]; do line="${line#?}"; done; fi
                        (( i = eol + 1 ))
                        [[ "$line" == "$hdelim" ]] && break
                    done
                done
                HEREDOC_DELIMS=(); HEREDOC_DASH=()
            fi
            continue; fi
        if [[ "$ch" == ';' || "$ch" == '|' ]]; then
            [[ -n "${seg// }" ]] && SEGMENTS+=("$seg"); seg=""; (( i++ )); continue; fi
        if [[ "$ch" == '&' && "${cmd:$((i+1)):1}" != '&' ]]; then
            [[ -n "${seg// }" ]] && SEGMENTS+=("$seg"); seg=""; (( i++ )); continue; fi
        seg="${seg}${ch}"; (( i++ ))
    done
    [[ -n "${seg// }" ]] && SEGMENTS+=("$seg")
}

# ── Token extractor ───────────────────────────────────────────────────────────
# HIGH-1: strip leading `exec` / `command` (Bash builtins that replace/bypass
# the shell or skip function/alias lookup) the same way `sudo`/`env` are
# stripped. Without this, `exec flyctl apps destroy …` slipped past.
TOKEN1="" TOKEN2="" TOKEN3=""
extract_tokens() {
    local s="${1#"${1%%[![:space:]]*}"}"; local p_env='^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]'
    while [[ "$s" =~ $p_env ]]; do s="${s#*=}"; s="${s#[^ ]* }"; s="${s#"${s%%[![:space:]]*}"}"; done
    local p_sudo='^(sudo|nice|env|doas|ionice|exec|command|builtin)[[:space:]]'
    while [[ "$s" =~ $p_sudo ]]; do s="${s#* }"; s="${s#"${s%%[![:space:]]*}"}"; done
    TOKEN1="${s%%[[:space:]]*}"; local r1="${s#"$TOKEN1"}"; r1="${r1#"${r1%%[![:space:]]*}"}"
    TOKEN2="${r1%%[[:space:]]*}"; local r2="${r1#"$TOKEN2"}"; r2="${r2#"${r2%%[![:space:]]*}"}"
    TOKEN3="${r2%%[[:space:]]*}"
}

# ── psql -c payload extractor ─────────────────────────────────────────────────
extract_psql_c() {
    local s="$1" a=""
    # Find -c and extract the argument value; avoid regex with embedded quotes
    if [[ "$s" == *" -c "* ]]; then
        a="${s#*-c }"
        local f="${a:0:1}"
        if [[ "$f" == "'" ]]; then a="${a:1}"; a="${a%%\'*}"
        elif [[ "$f" == '"' ]]; then a="${a:1}"; a="${a%%\"*}"
        else a="${a%%[[:space:]]*}"; fi
    fi
    printf '%s' "$a"
}

# ── rm -rf dangerous path check ───────────────────────────────────────────────
check_rm() {
    local seg="$1" has_r=0 has_f=0 path_arg="" tok
    local -a toks; read -ra toks <<< "$seg"
    for tok in "${toks[@]:1}"; do
        if [[ "$tok" == -* ]]; then
            [[ "$tok" == *r* || "$tok" == *R* ]] && has_r=1
            [[ "$tok" == *f* || "$tok" == *F* ]] && has_f=1
        else [[ -z "$path_arg" ]] && path_arg="$tok"; fi
    done
    (( has_r && has_f )) || return 1
    case "$path_arg" in
        /|'~'|'$HOME'|'${HOME}') MATCH_LABEL="rm-rf-root-or-home"; return 0 ;;
        */.git|*/.git/|.git|.git/) MATCH_LABEL="rm-rf-dotgit"; return 0 ;;
    esac; return 1
}

# ── Block check ───────────────────────────────────────────────────────────────
MATCH_LABEL=""
check_segment() {
    local seg="$1"; extract_tokens "$seg"
    local t1="$TOKEN1" t2="$TOKEN2" t3="$TOKEN3"
    is_data_cmd "$t1" && return 1
    case "$t1" in
        fly|flyctl) case "$t2" in
            apps|app)         [[ "$t3" == destroy ]] && { MATCH_LABEL="fly-apps-destroy";    return 0; } ;;
            volumes|volume)   [[ "$t3" == destroy ]] && { MATCH_LABEL="fly-volumes-destroy"; return 0; } ;;
            machines|machine) [[ "$t3" == destroy ]] && { MATCH_LABEL="fly-machines-destroy";return 0; } ;;
            postgres)         [[ "$t3" == destroy ]] && { MATCH_LABEL="fly-postgres-destroy";return 0; } ;;
            secrets|secret)   [[ "$t3" == unset   ]] && { MATCH_LABEL="fly-secrets-unset";   return 0; } ;;
        esac ;;
        wrangler) case "$t2" in
            r2) [[ "$t3" == bucket ]] && {
                    local t4="${seg#*bucket }"; t4="${t4%%[[:space:]]*}"
                    [[ "$t4" == delete ]] && { MATCH_LABEL="wrangler-r2-delete"; return 0; }; } ;;
            "kv:namespace") [[ "$t3" == delete ]] && { MATCH_LABEL="wrangler-kv-delete"; return 0; } ;;
            kv) [[ "$t3" == namespace ]] && {
                    local t4="${seg#*namespace }"; t4="${t4%%[[:space:]]*}"
                    [[ "$t4" == delete ]] && { MATCH_LABEL="wrangler-kv-delete"; return 0; }; } ;;
            d1)     [[ "$t3" == delete ]] && { MATCH_LABEL="wrangler-d1-delete";      return 0; } ;;
            secret) [[ "$t3" == delete ]] && { MATCH_LABEL="wrangler-secret-delete";  return 0; } ;;
            pages) [[ "$t3" == project ]] && {
                    local t4="${seg#*project }"; t4="${t4%%[[:space:]]*}"
                    [[ "$t4" == delete ]] && { MATCH_LABEL="wrangler-pages-delete"; return 0; }; } ;;
            deployments|deployment) [[ "$t3" == delete ]] && { MATCH_LABEL="wrangler-deployment-delete"; return 0; } ;;
        esac ;;
        gh) case "$t2" in
            repo) case "$t3" in
                delete)  MATCH_LABEL="gh-repo-delete";  return 0 ;;
                archive) MATCH_LABEL="gh-repo-archive"; return 0 ;;
            esac ;;
            release) [[ "$t3" == delete ]] && { MATCH_LABEL="gh-release-delete"; return 0; } ;;
        esac ;;
        dropdb) MATCH_LABEL="dropdb"; return 0 ;;
        psql) local pl; pl=$(extract_psql_c "$seg")
            if [[ -n "$pl" ]]; then
                # Portable uppercase (was ${pl^^}, a bash-4-only case-mod
                # expansion that throws a runtime bad-substitution error on
                # stock macOS /bin/bash 3.2, which would silently break this
                # SQL-DROP detection on a security gate. tr is POSIX everywhere.
                local up; up=$(printf '%s' "$pl" | tr '[:lower:]' '[:upper:]')
                case "$up" in
                *'DROP TABLE'*|*'DROP DATABASE'*|*'DROP SCHEMA'*|\
                *'DROP ROLE'*|*'DROP INDEX'*|*'DROP TRIGGER'*)
                    MATCH_LABEL="psql-drop"; return 0 ;;
                *'TRUNCATE'*) MATCH_LABEL="psql-truncate"; return 0 ;;
            esac; fi ;;
        supabase) case "$t2" in
            db)              [[ "$t3" == reset  ]] && { MATCH_LABEL="supabase-db-reset";       return 0; } ;;
            projects|project)[[ "$t3" == delete ]] && { MATCH_LABEL="supabase-projects-delete";return 0; } ;;
        esac ;;
        rm) check_rm "$seg" && return 0 ;;
        git) case "$t2" in
            commit)
                # --no-verify is blocked by policy: it is a convenience bypass
                # around the very checks a commit hook exists to run.
                local nvp='[[:space:]]--no-verify([[:space:]]|$)'
                [[ "$seg" =~ $nvp ]] && { MATCH_LABEL="git-commit-no-verify-banned"; return 0; } ;;
            push) local pp=':(refs/heads/)?(main|master)([[:space:]]|$)'
                [[ "$seg" =~ $pp ]] && { MATCH_LABEL="git-push-delete-main"; return 0; }
                # Both force-push forms are blocked by policy: a force push
                # rewrites published history for everyone sharing the branch.
                local fp='[[:space:]](-f|--force|--force-with-lease(=[^[:space:]]+)?)([[:space:]]|$)'
                [[ "$seg" =~ $fp ]] && { MATCH_LABEL="git-push-force-banned"; return 0; } ;;
            branch) local bp='git[[:space:]]+branch[[:space:]]+(-D|--delete[[:space:]]+--force)[[:space:]]+(main|master)'
                [[ "$seg" =~ $bp ]] && { MATCH_LABEL="git-branch-delete-main"; return 0; } ;;
        esac ;;
        docker) [[ "$t2" == volume && "$t3" == rm && "$seg" == *postgres* ]] && \
            { MATCH_LABEL="docker-volume-rm-pg"; return 0; } ;;
        aws) [[ "$t2" == s3 && "$t3" == rb && "$seg" == *--force* ]] && \
            { MATCH_LABEL="aws-s3-rb-force"; return 0; } ;;
        gcloud) [[ "$t2" == projects && "$t3" == delete ]] && \
            { MATCH_LABEL="gcloud-projects-delete"; return 0; } ;;
    esac; return 1
}

# ── Telemetry-only check ──────────────────────────────────────────────────────
check_telemetry() {
    local seg="$1"; extract_tokens "$seg"
    local t1="$TOKEN1" t2="$TOKEN2" t3="$TOKEN3"
    case "$t1" in
        git) case "$t2" in
            # git push force forms moved to check_segment (hard block) 2026-06-08.
            reset) [[ "$t3" == --hard ]] && \
                { log_event "OBSERVE" "git-reset-hard" "$ORIG_CMD" "$seg"; return 0; } ;;
        esac ;;
        fly|flyctl) [[ "$t2" == secrets || "$t2" == secret ]] && [[ "$t3" == set ]] && \
            { log_event "OBSERVE" "fly-secrets-set" "$ORIG_CMD" "$seg"; return 0; } ;;
    esac; return 1
}

# ── $(…) + backtick extractor (HIGH-2) ────────────────────────────────────────
# A destructive command hidden inside $(…) (e.g. `echo $(flyctl apps destroy x)`)
# used to slip past because TOKEN1 was a data command. Unwrap every $(…)
# (paren-balanced, depth ≤3) and `…` pair; recurse scan on each inner.
declare -a CMDSUB_INNERS=()
extract_cmdsubs() {
    local cmd="$1" len i ch ch2 depth start inner
    CMDSUB_INNERS=(); len=${#cmd}; i=0
    while (( i < len - 1 )); do
        ch="${cmd:$i:1}"; ch2="${cmd:$i:2}"
        if [[ "$ch2" == '$(' ]]; then
            start=$(( i + 2 )); depth=1; (( i+=2 ))
            while (( i < len )) && (( depth > 0 )); do
                ch="${cmd:$i:1}"; ch2="${cmd:$i:2}"
                if [[ "$ch2" == '$(' ]]; then (( depth++ )); (( i+=2 )); continue; fi
                if [[ "$ch" == '(' ]]; then (( depth++ )); (( i++ )); continue; fi
                if [[ "$ch" == ')' ]]; then (( depth-- )); (( i++ )); continue; fi
                (( i++ ))
            done
            if (( depth == 0 )); then
                inner="${cmd:$start:$(( i - start - 1 ))}"
                [[ -n "$inner" ]] && CMDSUB_INNERS+=("$inner")
            fi
            continue
        fi
        (( i++ ))
    done
    local rest="$cmd"
    while [[ "$rest" == *'`'* ]]; do
        rest="${rest#*\`}"
        [[ "$rest" == *'`'* ]] || break
        inner="${rest%%\`*}"; [[ -n "$inner" ]] && CMDSUB_INNERS+=("$inner")
        rest="${rest#*\`}"
    done
}

# UNQUOTED VIEW of a segment: every quoted region replaced by a space, every
# backslash-escaped character dropped, unquoted text kept verbatim.
#
# Shell SYNTAX only ever lives outside quotes. `echo "deploy() {"` prints a
# brace; it does not define a function, and bash never reads it as one. Any
# syntax check that greps the raw segment cannot tell those apart, which is the
# code-versus-data confusion this gate has now resolved in both directions at
# once: fail-open on real interpreters, fail-CLOSED on text that merely looks
# like shell. Deciding "is this character quoted" is decidable and cheap, unlike
# deciding what a quoted payload would DO, so this narrowing is sound where a
# deny-list over payload contents is not.
#
# A space substitutes for each stripped region so token boundaries survive:
# dropping the region entirely would weld `a"x"b` into `ab` and could
# manufacture a match that no bash parse produces.
__unquoted_view() {
    # `s` is assigned in its OWN statement, and `len` only after it. Bash expands
    # every word of a `local` BEFORE the builtin assigns any of them, so the
    # one-liner `local s="$1" len=${#s}` reads an UNSET `s`, sets len=0, and the
    # loop below never runs: the function silently returns the empty string and
    # every caller sees no-match. That is a fail-OPEN, and it is invisible to a
    # re-grep of the diff because the code reads correctly. Caught only by
    # probing the real gate with plain-form controls. `split_compound` survives
    # the same pattern purely by accident, assigning `cmd` on a separate line.
    local s="$1"
    local out="" i=0 ch
    local len=${#s}
    while (( i < len )); do
        ch="${s:$i:1}"
        # ANSI-C quoting, `$'…'`, is bash's FOURTH quoting form and it is the one
        # exception to "a single quote ends a single-quoted string": inside `$'…'`
        # a backslash ESCAPES, so `\'` is a literal quote and does NOT close.
        # Treating it as a plain `'…'` closes one character early and desyncs the
        # rest of the command onto the wrong side of the quote boundary, which
        # blanks a REAL function definition that follows. That is a fail-OPEN:
        # `echo $'a\'b'; f(){ …destroy…; }; f` verified DENY before, ALLOW after,
        # with bash confirmed to execute the payload. Found by an independent
        # re-gate, not by the author's own re-reading of this function.
        if [[ "$ch" == '$' && "${s:$((i+1)):1}" == "'" ]]; then
            (( i+=2 ))
            while (( i < len )) && [[ "${s:$i:1}" != "'" ]]; do
                [[ "${s:$i:1}" == "\\" ]] && (( i++ ))
                (( i++ ))
            done
            (( i++ )); out="${out} "; continue
        fi
        if [[ "$ch" == "'" ]]; then
            # A PLAIN single-quoted string has no escapes at all: the very next
            # quote ends it, backslash included. Do not "fix" this to consume
            # `\'`; bash does not, and doing so would desync in the other
            # direction.
            (( i++ ))
            while (( i < len )) && [[ "${s:$i:1}" != "'" ]]; do (( i++ )); done
            (( i++ )); out="${out} "; continue
        fi
        if [[ "$ch" == '"' ]]; then
            (( i++ ))
            while (( i < len )) && [[ "${s:$i:1}" != '"' ]]; do
                [[ "${s:$i:1}" == "\\" ]] && (( i++ ))
                (( i++ ))
            done
            (( i++ )); out="${out} "; continue
        fi
        if [[ "$ch" == "\\" ]]; then (( i+=2 )); out="${out} "; continue; fi
        # A `#` at WORD START begins a comment, and bash discards the rest of the
        # line. `split_compound` separates on newlines, so a segment holds at most
        # one line and the comment runs to its end. Dropping it here is bash's own
        # semantics, and it closes a fail-OPEN: `f() # c` newline `{ …destroy…; }`
        # put comment text between `)` and `{`, where the regex admits only
        # whitespace, so the definition went unseen. That hole predates this work
        # (it is present in the original raw-string form too, and it is not a
        # regression) but the fix is one branch, so it lands here.
        # NOT a comment when mid-word: `curl http://x/#frag` and `echo a#b` both
        # keep their `#`, exactly as bash does.
        # A `#` opens a comment at the start of a WORD, and a word starts after
        # whitespace OR after a metacharacter, which is why `f()# c` comments just
        # as `f() # c` does: `)` ends the word, so `#` begins a new one. Accepting
        # only whitespace here left `f()# c` newline `{ …destroy…; }` fully open,
        # with bash confirmed to execute it.
        if [[ "$ch" == "#" ]] && (( i == 0 )); then break; fi
        if [[ "$ch" == "#" && "${s:$((i-1)):1}" =~ [[:space:]\;\&\|\(\)\<\>] ]]; then break; fi
        # \x01 is the command-position marker the caller joins segments with. A
        # literal one in the input would forge a boundary, so it is neutralised.
        if [[ "$ch" == $'\x01' ]]; then out="${out} "; (( i++ )); continue; fi
        out="${out}${ch}"; (( i++ ))
    done
    printf '%s' "$out"
}

# CRIT-3: function-def scan. `f(){ flyctl apps destroy x; }; f` hides the
# payload in a function body, and it is the ONLY guard that catches that form:
# `split_compound` tracks paren depth but never BRACE depth, and `check_segment`
# tokenises t1 as `f(){` which dispatches on nothing. Four independent deletion
# qualifiers refused its removal on that evidence (2026-07-17). It is NARROWED
# here, never deleted.
#
# Callers MUST pass a `__code_view`: every segment's `__unquoted_view`, REJOINED.
# All three of those properties are needed and none alone suffices.
#   - going through `split_compound` kills the HEREDOC false positive, because it
#     drains heredoc bodies, so `python3 <<'EOF' … name(){ … EOF` never survives;
#   - the unquoted view kills the QUOTED-STRING false positive, because
#     `split_compound` PRESERVES quotes inside a segment, so `echo "deploy() {"`
#     survives splitting intact and still matches the raw regex;
#   - REJOINING is what keeps this a DENY rather than a fail-open, and it is the
#     half that is easy to miss. `split_compound` separates on a BARE NEWLINE, so
#     the ordinary Allman layout
#         f()
#         { flyctl apps destroy x; }
#         f
#     splits `f()` and `{` into DIFFERENT segments, and a regex needing name, (,)
#     and { in one string can then never match ANY segment. Checking per-segment
#     without rejoining silently allows it. Verified: DENY before, ALLOW after,
#     with bash confirmed to execute the payload. That is a COMMON formatting
#     choice, not an adversarial construction.
# Running on the raw, pre-split `$cmd` (as this did until 2026-07-17) manufactured
# the false positives instead. It denied a read-only probe harness, denied a
# `sed`+`echo` read whose only sin was a brace in a quoted string, and denied the
# commit message documenting this very fix.
# COMMAND POSITION is the rule both patterns below encode, and it is the one the
# rejoin threw away. Bash reads `function` or `name()` as a DEFINITION only at the
# start of a command; anywhere else they are ordinary words. `echo function test`
# prints two words, and joining that segment to a following `{ echo done; }` blind
# fabricated `function test {`, denying two independent statements that no bash
# parse would ever read as a definition. Verified ALLOW before / DENY after: a
# false positive introduced by the join itself, found by an independent re-gate.
#
# So segments are joined with \x01 marking each command boundary, and both
# patterns anchor to `(^|\x01)`. That keeps the cross-segment Allman form visible
# (the definition genuinely STARTS a command) while refusing the mid-segment word.
#
# Command position is `^`, the \x01 marker, OR a bare `;` `&` `|` still sitting
# INSIDE a segment. That last one is not redundant: `split_compound` has its own
# `$'…'` desync, and when it mis-tracks a quote it stops splitting and hands back
# one segment with its separators intact. Anchoring to \x01 alone then rejects a
# real definition on the far side of that desync, which is a fail-OPEN (verified
# DENY, then ALLOW after over-tightening, then DENY again). The gate must agree
# with bash, not with the splitter.
__FN_SEP=$'\x01'
__has_function_def() {
    local cpos="(^|[${__FN_SEP};&|])"
    local p_name="${cpos}[[:space:]]*[[:alnum:]_]+[[:space:]]*\([[:space:]]*\)[[:space:]${__FN_SEP}]*\{"
    local p_kw="${cpos}[[:space:]]*function[[:space:]]+[[:alnum:]_]+([[:space:]]*\([[:space:]]*\))?[[:space:]${__FN_SEP}]*\{"
    [[ "$1" =~ $p_name ]] && return 0
    [[ "$1" =~ $p_kw ]] && return 0
    return 1
}
# MEDIUM: bash <(…) / sh <(…) process-substitution - block the wrapper.
__has_proc_sub_interp() {
    [[ "$1" =~ (^|[[:space:];&|])(bash|sh|dash|zsh|exec[[:space:]]+(bash|sh|dash|zsh)|source|\.)[[:space:]]+\<\( ]] && return 0
    return 1
}

# ── Unpinned git-mutation gate ────────────────────────────────────────────────
# Bash CWD persists across sequential calls; an un-pinned git mutation binds to
# whatever repo the ambient CWD points at.
# A command is PINNED when any of these hold:
#   (a) the mutating segment carries `git -C <path>`;
#   (b) the command contains an `&&`-chained `cd <path> &&` (a failed cd
#       aborts the chain, so the mutation cannot run in the wrong tree);
#   (c) the command asserts `rev-parse --show-toplevel` (toplevel check).
# BLOCK shapes (conservative, targets compound/worktree-aimed only):
#   - `git worktree add|remove|move|prune` unpinned, always (the exact
#     2026-06-05 incident shape - a repo-aimed mutation);
#   - any other mutating op unpinned when the command also mentions a
#     worktree path OR is a compound containing an un-&&-chained `cd`.
# Plain single-segment forms (`git commit -m x`, `git add && git commit`)
# pass untouched.
GIT_CD_PIN_RE='(^|[;&|[:space:](])cd[[:space:]]+[^;&|]+&&'
UNPINNED_SEG=""
cmd_has_pin() {
    [[ "$1" == *"--show-toplevel"* ]] && return 0
    [[ "$1" =~ $GIT_CD_PIN_RE ]] && return 0
    return 1
}
check_git_unpinned() {
    local cmd="$1"; UNPINNED_SEG=""
    cmd_has_pin "$cmd" && return 1
    split_compound "$cmd"
    local nsegs=${#SEGMENTS[@]} has_bare_cd=0 seg
    local p_cd='(^|[;&|[:space:](])cd[[:space:]]'
    [[ "$cmd" =~ $p_cd ]] && has_bare_cd=1
    for seg in "${SEGMENTS[@]}"; do
        extract_tokens "$seg"
        [[ "$TOKEN1" == git ]] || continue
        [[ "$seg" == *" -C "* ]] && continue   # per-segment pin
        case "$TOKEN2" in
            worktree) case "$TOKEN3" in add|remove|move|prune)
                MATCH_LABEL="git-worktree-unpinned"; UNPINNED_SEG="$seg"; return 0 ;;
            esac ;;
            cherry-pick|rebase|reset|apply|restore|commit|checkout|switch|am|revert|merge)
                if [[ "$cmd" == *"/worktrees/"* ]] || { (( nsegs > 1 )) && (( has_bare_cd )); }; then
                    MATCH_LABEL="git-mutation-unpinned"; UNPINNED_SEG="$seg"; return 0
                fi ;;
        esac
    done
    return 1
}

# ── Advisory: unpinned git reads after a cd-bearing call (allow + warn) ──────
# Same lesson family, read side: a bare `git log/branch/status/ls-*` after any
# cd-bearing Bash call may observe the wrong repo. Advisory only - the call
# proceeds with a systemMessage warning. Rate-limited to one per session per
# 30 minutes via a marker stamp.
CD_MARKER="${LOG_DIR}/cd-seen-${SESSION_ID}"
ADV_STAMP="${LOG_DIR}/advisory-stamped-${SESSION_ID}"
check_git_unpinned_reads() {
    local cmd="$1"
    [[ -f "$CD_MARKER" ]] || return 1
    cmd_has_pin "$cmd" && return 1
    split_compound "$cmd"
    local seg
    for seg in "${SEGMENTS[@]}"; do
        extract_tokens "$seg"
        [[ "$TOKEN1" == git ]] || continue
        [[ "$seg" == *" -C "* ]] && continue
        case "$TOKEN2" in
            log|branch|status|ls-files|ls-tree|ls-remote) return 0 ;;
        esac
    done
    return 1
}
emit_advisory() {
    # Once per session, not every 30 minutes. The advice ("pin your git reads")
    # is timeless, so a repeat carried no new information and was then re-read by
    # every later request for the rest of the session.
    if command -v _once_per >/dev/null 2>&1; then
        _once_per "cwd-advisory:${SESSION_ID}" || { printf '{"continue":true}\n'; exit 0; }
    elif [[ -f "$ADV_STAMP" ]] && [[ -n "$(find "$ADV_STAMP" -mmin -30 2>/dev/null)" ]]; then
        printf '{"continue":true}\n'; exit 0
    fi
    mkdir -p "$LOG_DIR" 2>/dev/null; touch "$ADV_STAMP" 2>/dev/null
    log_event "ADVISE" "git-read-unpinned-after-cd" "$ORIG_CMD" ""
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"~Alter CWD advisory: a prior call in this session contained cd, and this git read is unpinned. Bash CWD persists across sequential calls - pin reads feeding any claim or brief (git -C <abs>, or cd <abs> && ..., or assert rev-parse --show-toplevel)."}}\n'
    exit 0
}
mark_cd_seen() {
    local p_cd='(^|[;&|[:space:](])cd[[:space:]]'
    if [[ "$ORIG_CMD" =~ $p_cd ]]; then
        mkdir -p "$LOG_DIR" 2>/dev/null; touch "$CD_MARKER" 2>/dev/null
    fi
}
do_block_unpinned() {   # $1=label $2=segment
    local msg="~Alter CWD guardrail: blocked unpinned git mutation '${1}' (segment: ${2}). Bash CWD persists across calls - pin the target: git -C <abs> ..., or cd <abs> && git ... in ONE chained call, or assert git rev-parse --show-toplevel first. Log: ${LOG_DIR}/events.log"
    local j; j=$(printf '%s' "$msg" | jq -Rs '.') 2>/dev/null || j='"blocked"'
    log_event "BLOCK" "$1" "$ORIG_CMD" "${2:-}"
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' "$j"; exit 0
}

# ── Recursive scan ────────────────────────────────────────────────────────────
scan_command() {
    local cmd="$1" depth="${2:-0}"
    (( depth > MAX_DEPTH )) && return 0
    # NOTE: __has_function_def is NOT called here. It runs per-segment, on an
    # unquoted view, in the loop below. See its own comment block for why the
    # raw pre-split `$cmd` manufactures false positives in two ways at once.
    __has_proc_sub_interp "$cmd" && do_block "proc-sub-interp" "$cmd" "$ORIG_CMD"
    check_git_unpinned "$cmd" && do_block_unpinned "$MATCH_LABEL" "$UNPINNED_SEG"
    # HIGH-2: recurse into every $(…) / `…` inner BEFORE per-segment scan.
    extract_cmdsubs "$cmd"
    local inner seg
    for inner in "${CMDSUB_INNERS[@]}"; do
        scan_command "$inner" $(( depth + 1 ))
    done
    split_compound "$cmd"
    # CODE VIEW of the whole command: heredoc bodies drained (by split_compound),
    # quoted regions blanked (by __unquoted_view), segments REJOINED so a
    # definition spanning a bare-newline separator is still visible as one string.
    # Joined with \x01, which MARKS each command boundary rather than erasing it,
    # so the patterns can require command position. Joining with a plain space
    # erases the boundary and fabricates adjacencies no bash parse produces.
    local code_view=""
    for seg in "${SEGMENTS[@]}"; do
        code_view="${code_view}${__FN_SEP}$(__unquoted_view "$seg")"
    done
    __has_function_def "$code_view" && do_block "shell-function-def" "$ORIG_CMD" "$ORIG_CMD"

    for seg in "${SEGMENTS[@]}"; do
        check_telemetry "$seg" || true
        check_segment "$seg" && do_block "$MATCH_LABEL" "$seg" "$ORIG_CMD"
        extract_inner "$seg"
        (( UNWRAPPED )) && scan_command "$UNWRAPPED_INNER" $(( depth + 1 ))
    done
}

scan_command "$ORIG_CMD" 0
mark_cd_seen
check_git_unpinned_reads "$ORIG_CMD" && emit_advisory
emit_pass
