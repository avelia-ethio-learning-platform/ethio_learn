/**
 * Counts API calls still pending after SLOW_NOTICE_MS, for the "waking up the
 * server" notice. A tiny external store (no React state), so `api()` can feed
 * it from anywhere and `WakingUpNotice` reads it with useSyncExternalStore.
 */
export const SLOW_NOTICE_MS = 4000;

let slowCount = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function subscribeSlow(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function slowRequestCount(): number {
  return slowCount;
}

/** Start timing a request; call the returned function when it settles. */
export function trackRequest(): () => void {
  let counted = false;
  const timer = setTimeout(() => {
    counted = true;
    slowCount += 1;
    emit();
  }, SLOW_NOTICE_MS);
  return () => {
    clearTimeout(timer);
    if (!counted) return;
    counted = false;
    slowCount -= 1;
    emit();
  };
}
