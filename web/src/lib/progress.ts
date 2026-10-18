/**
 * Course progress from the API is `null` when the course service couldn't be
 * reached (P1-18): show "—", never a made-up 0%.
 */
export function percentLabel(percent: number | null | undefined): string {
  return percent == null ? '—' : `${percent}%`;
}

/** Width for a progress bar: an unknown percent draws an empty bar. */
export function percentWidth(percent: number | null | undefined): string {
  return `${percent ?? 0}%`;
}
