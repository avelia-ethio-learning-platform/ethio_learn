/**
 * Rows loaded with "Load earlier" plus the live newest page: each row once (by id),
 * the newest page's copy winning (a comment deleted since), oldest first by (created_at, id).
 */
export function mergeById<T extends { id: string; created_at: string }>(earlier: readonly T[], latest: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of earlier) byId.set(row.id, row);
  for (const row of latest) byId.set(row.id, row);
  return Array.from(byId.values()).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** A `paged=1` list response; an API that predates it sends the bare array, read as the one page there is. */
export function asPage<T>(data: T[] | { items: T[]; total: number }): { items: T[]; total: number } {
  return Array.isArray(data) ? { items: data, total: data.length } : data;
}
