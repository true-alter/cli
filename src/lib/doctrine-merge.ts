/**
 * Pure merge logic for doctrine projection entries.
 *
 * Extracted from src/commands/doctrine.ts so it can be unit-tested
 * without pulling in the @truealter/sdk dependency.
 *
 * No external runtime dependencies.
 */

/** A single doctrine entry as returned by alter_doctrine action="list" */
export interface DoctrineEntry {
  id: string;
  slug: string;
  kind: string;
  body: string;
  created_at: string;
  supersedes_id?: string | null;
  scope?: string;
  [key: string]: unknown;
}

/**
 * Merge-by-slug: for each new entry, if it's newer than what we have (or
 * we have nothing for that slug), it wins. Then drop any entry whose id
 * appears in another entry's supersedes_id chain.
 *
 * Returns the merged map. Pure function - no I/O.
 */
export function mergeEntries(
  existing: Map<string, DoctrineEntry>,
  incoming: DoctrineEntry[],
): Map<string, DoctrineEntry> {
  const merged = new Map(existing);

  for (const entry of incoming) {
    if (!entry.slug) continue;
    const have = merged.get(entry.slug);
    if (!have || entry.created_at > have.created_at) {
      merged.set(entry.slug, entry);
    }
  }

  // Drop superseded entries: collect all supersedes_id values, then remove
  // any entry whose id is superseded.
  const supersededIds = new Set<string>();
  for (const entry of merged.values()) {
    if (entry.supersedes_id) {
      supersededIds.add(entry.supersedes_id);
    }
  }
  for (const [slug, entry] of merged.entries()) {
    if (supersededIds.has(entry.id)) {
      merged.delete(slug);
    }
  }

  return merged;
}
