/**
 * A sleeping Render free-tier service answers with an immediate plain-text
 * `429` carrying `x-render-routing: hibernate-rate-limited`, and stays that
 * way until something outside Render wakes it (see `wake.ts`).
 *
 * In the browser the gateway is cross-origin and exposes no extra headers, so
 * the header usually can't be read there. The body decides instead: the
 * gateway's own limiter (and the services' throttlers) answer JSON
 * `{ statusCode: 429, … }`; anything else on a 429 is hibernation.
 */
export function isHibernation(status: number, headers: Headers, bodyText: string): boolean {
  if (status !== 429) return false;
  if (headers.get('x-render-routing')?.includes('hibernate')) return true;
  try {
    const body = JSON.parse(bodyText) as { statusCode?: unknown } | null;
    return body?.statusCode !== 429;
  } catch {
    return true;
  }
}
