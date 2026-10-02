/**
 * Wake sleeping Render free-tier services from the browser.
 *
 * A sleeping service answers the gateway's calls with a hibernation 429 and
 * stays asleep; a request from outside Render to its public `/health` wakes it
 * (~25 s). The browser is outside Render, so it pings every URL in
 * `NEXT_PUBLIC_WAKE_URLS` (comma-separated public `/health` URLs). `no-cors`
 * gives an opaque response, which is enough to wake a service and needs no
 * CORS change on it. Fire-and-forget, at most once per minute per tab; a no-op
 * when the variable is unset (local, CI).
 */
export const WAKE_INTERVAL_MS = 60_000;

let lastWake: number | null = null;

export function wakeServices(): void {
  if (typeof window === 'undefined') return;
  const urls = (process.env.NEXT_PUBLIC_WAKE_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length === 0) return;
  const now = Date.now();
  if (lastWake !== null && now - lastWake < WAKE_INTERVAL_MS) return;
  lastWake = now;
  for (const url of urls) {
    fetch(url, { mode: 'no-cors', cache: 'no-store' }).catch(() => undefined);
  }
}
