/**
 * Opener - the first-line greeting that anchors an interactive
 * `alter` session.
 *
 * The default ships a single canonical positioning line. Per-entrant
 * pools (dotfiles / agentic-discovery / AUR / fresh-machine / long-
 * timer / claude-code-user / polyglot) are intentionally deferred;
 * until they land the rotation is a single deterministic entry rather
 * than AI-drafted prose.
 *
 * Users override the default with a single authored line via the
 * `opener.line` config key. When the override is set the library is
 * ignored.
 *
 * Future libraries (per-entrant pools, community-authored theme packs)
 * register here with their own id + entries array.
 */

export interface OpenerLibrary {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly string[];
}

/**
 * The only first-party library ALTER ships. Single canonical line.
 * Additions are a brand decision held intentionally tight to resist
 * shipping "official themes".
 */
export const DEFAULT_OPENERS: OpenerLibrary = {
  id: "default",
  label: "Alter default opener",
  entries: [
    "where your identity earns",
  ],
};

const REGISTRY: Map<string, OpenerLibrary> = new Map([
  [DEFAULT_OPENERS.id, DEFAULT_OPENERS],
]);

export function registerLibrary(lib: OpenerLibrary): void {
  REGISTRY.set(lib.id, lib);
}

export function getLibrary(id: string): OpenerLibrary | undefined {
  return REGISTRY.get(id);
}

/**
 * Substitute `{handle}` with the caller's `~handle`. Intentionally
 * simple (no full template engine) - opener lines are short,
 * user-visible strings, and we want the substitution contract legible
 * to anyone reading a library.
 */
export function render(template: string, handle: string): string {
  return template.replace(/\{handle\}/g, handle);
}

/**
 * Pick a random line from a library. Caller passes an optional
 * deterministic index for tests and for a future "daily" cadence.
 */
export function pick(library: OpenerLibrary, index?: number): string {
  if (library.entries.length === 0) {
    throw new Error(`opener library ${library.id} is empty`);
  }
  const i =
    typeof index === "number"
      ? ((index % library.entries.length) + library.entries.length) %
        library.entries.length
      : Math.floor(Math.random() * library.entries.length);
  return library.entries[i]!;
}
