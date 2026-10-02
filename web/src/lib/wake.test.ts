import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

// wake.ts keeps a module-level timestamp; load a fresh copy per test.
async function load() {
  vi.resetModules();
  return import('./wake');
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('wakeServices', () => {
  it('does nothing when NEXT_PUBLIC_WAKE_URLS is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_WAKE_URLS', '');
    const { wakeServices } = await load();
    wakeServices();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pings each URL once, no-cors and uncached', async () => {
    vi.stubEnv('NEXT_PUBLIC_WAKE_URLS', 'https://gw.example/health, https://auth.example/health,');
    const { wakeServices } = await load();
    wakeServices();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://gw.example/health', { mode: 'no-cors', cache: 'no-store' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://auth.example/health', { mode: 'no-cors', cache: 'no-store' });
  });

  it('pings again only after a minute', async () => {
    vi.stubEnv('NEXT_PUBLIC_WAKE_URLS', 'https://gw.example/health');
    const { wakeServices, WAKE_INTERVAL_MS } = await load();
    wakeServices();
    vi.advanceTimersByTime(WAKE_INTERVAL_MS - 1);
    wakeServices();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    wakeServices();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('swallows ping failures', async () => {
    vi.stubEnv('NEXT_PUBLIC_WAKE_URLS', 'https://gw.example/health');
    fetchMock.mockRejectedValue(new TypeError('blocked'));
    const { wakeServices } = await load();
    expect(() => wakeServices()).not.toThrow();
    await vi.runAllTimersAsync();
  });
});
