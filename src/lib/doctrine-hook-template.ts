/**
 * Lazy doctrine-sync hook body - shipped as a string constant compiled
 * into dist/. Written by `alter cutover` into ~/.claude/doctrine-sync.sh
 * as a UserPromptSubmit hook. Marker-guarded to run once per session.
 *
 * NO package.json `files` change, NO bin field, NO prepublishOnly.
 * The hook reaches users via `alter cutover` writing it at runtime.
 *
 * THE MARKER LIVES IN A DIRECTORY THE MEMBER OWNS, and every step of
 * reaching it fails closed. The earlier form put a guessable name straight
 * into the shared temp root and reached it with `touch`, which follows a
 * symlink. On a machine with other people on it, one of them could plant a
 * symlink under that name and the member's own hook would then create or
 * stamp a file of the planter's choosing, under the member's uid. Pointing
 * it at a file the product reads as an on/off sentinel flips a setting the
 * member never set.
 *
 * So: a per-uid directory, made with bare `mkdir`, which refuses a name
 * already taken and never walks a path; then the name is proven not to be a
 * symlink BEFORE ownership is asserted, because `[ -O ]` resolves a link and
 * would pass on a planted one whose target the member happens to own; and
 * the marker itself created under noclobber, which is an exclusive create
 * that cannot be redirected through a link. `XDG_RUNTIME_DIR` is preferred
 * where it exists because it is already a private per-user directory, and it
 * is cleared at logout, which is the lifetime this marker actually wants.
 *
 * `mkdir -p` is the wrong primitive here and was the one shipped in 0.8.42's
 * first cut. It walks every component and follows a symlink it meets, so the
 * plant this whole block exists to defeat succeeded against it, and the
 * ownership test that followed resolved through the same link. Only one
 * component is ever created, so there was nothing for `-p` to do.
 *
 * Every refusal exits 0 and syncs nothing. Somebody who squats the directory
 * can stop the sync running, which they could already do by writing the old
 * marker name, and that is the harmless half. What they can no longer do is
 * make the member write anywhere.
 *
 * Portable to stock macOS bash 3.2 and Git Bash: `id -u`, `[ -L ]`, `[ -d ]`,
 * `[ -O ]`, `set -C` and bare `mkdir` only, no GNU-only binaries and no
 * bash-4 syntax.
 */

export const DOCTRINE_SYNC_HOOK_BODY = `#!/usr/bin/env bash
# ~Alter lazy doctrine sync - UserPromptSubmit hook
# Written by \`alter cutover\`. Do not edit manually.
# Runs \`alter doctrine sync --quiet --if-stale\` once per session,
# then sets a marker so subsequent prompts in the same session skip it.

_uid=\$(id -u 2>/dev/null) || exit 0
MARKER_DIR="\${XDG_RUNTIME_DIR:-\${TMPDIR:-/tmp}}/alter-\$_uid"

# Bare mkdir, never -p. Only one component is ever created, and -p would walk
# the path and follow a planted symlink instead of refusing it. A failure here
# usually just means we made this directory on an earlier prompt.
mkdir "\$MARKER_DIR" 2>/dev/null || :

# A link is refused before ownership is even asked about, because -O resolves
# the link and passes whenever its target happens to belong to us, which is
# precisely the plant.
[ -L "\$MARKER_DIR" ] && exit 0
[ -d "\$MARKER_DIR" ] || exit 0

# Somebody else's directory is not ours to write into.
[ -O "\$MARKER_DIR" ] || exit 0
chmod 700 "\$MARKER_DIR" 2>/dev/null || true

MARKER="\$MARKER_DIR/doctrine-synced"

# Already ran this session - skip. -e rather than -f, so anything at all
# sitting at that name stops us instead of being written through.
[ -e "\$MARKER" ] && exit 0

# Mark first so a failed sync doesn't retry on every prompt. noclobber makes
# this an exclusive create, which fails rather than following a link.
( set -C; : > "\$MARKER" ) 2>/dev/null || exit 0

# Run the sync in the background so it doesn't block the first prompt.
alter doctrine sync --quiet --if-stale 2>/dev/null &

exit 0
`;
