/** Earlier pages, then the newest one: each row once (by id), in the order given (oldest first). */
export function mergeById<T extends { id: string }>(earlier: readonly T[], latest: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...earlier, ...latest].filter((row) => !seen.has(row.id) && !!seen.add(row.id));
}
