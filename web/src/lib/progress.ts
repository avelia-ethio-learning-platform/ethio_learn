/**
 * Course progress from the API is `null` when the course service couldn't be
 * reached (P1-18): show "—", never a made-up 0%.
 */
export function percentLabel(percent: number | null | undefined): string {
  return percent == null ? '—' : `${percent}%`;
}

/** The `.progress-fill` transform: an unknown percent draws an empty bar. */
export function percentScale(percent: number | null | undefined): string {
  return `scaleX(${(percent ?? 0) / 100})`;
}
