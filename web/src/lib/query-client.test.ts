import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, WakingError } from './api';
import { makeQueryClient, retryWhileWaking, WAKING_RETRIES, WAKING_RETRY_MS } from './query-client';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('makeQueryClient', () => {
  it('retries a query on WakingError every 10 s and gives up after 90 s', async () => {
    const client = makeQueryClient();
    const fn = vi.fn().mockRejectedValue(new WakingError());
    const result = client.fetchQuery({ queryKey: ['asleep'], queryFn: fn }).catch((e) => e);

    await vi.advanceTimersByTimeAsync(WAKING_RETRY_MS - 1);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(90_000 - WAKING_RETRY_MS);
    expect(fn).toHaveBeenCalledTimes(10); // the first try, then 9 retries over 90 s
    expect(await result).toBeInstanceOf(WakingError);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(10);
  });

  it('recovers when the services wake up', async () => {
    const client = makeQueryClient();
    const fn = vi.fn().mockRejectedValueOnce(new WakingError()).mockRejectedValueOnce(new WakingError()).mockResolvedValue('ok');
    const result = client.fetchQuery({ queryKey: ['waking'], queryFn: fn });
    await vi.advanceTimersByTimeAsync(2 * WAKING_RETRY_MS);
    expect(await result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('other errors keep a single retry', async () => {
    const client = makeQueryClient();
    const fn = vi.fn().mockRejectedValue(new ApiError(500, 'boom'));
    const result = client.fetchQuery({ queryKey: ['broken'], queryFn: fn }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(await result).toBeInstanceOf(ApiError);
  });

  it('retryWhileWaking retries only a WakingError, for the same 90 s', () => {
    expect(retryWhileWaking(0, new WakingError())).toBe(true);
    expect(retryWhileWaking(WAKING_RETRIES - 1, new WakingError())).toBe(true);
    expect(retryWhileWaking(WAKING_RETRIES, new WakingError())).toBe(false);
    expect(retryWhileWaking(0, new ApiError(404, 'Request not found'))).toBe(false);
    expect(retryWhileWaking(0, new ApiError(500, 'boom'))).toBe(false);
  });

  it('mutations never retry a WakingError', async () => {
    const client = makeQueryClient();
    const fn = vi.fn().mockRejectedValue(new WakingError());
    const mutation = client.getMutationCache().build(client, { mutationFn: fn });
    const result = mutation.execute(undefined).catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBeInstanceOf(WakingError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
