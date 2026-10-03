import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDebouncedValue } from './use-debounced-value';

afterEach(() => vi.useRealTimers());

describe('useDebouncedValue', () => {
  it('follows the value only after it has been still for the delay', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 300), { initialProps: { v: 'a' } });
    rerender({ v: 'ab' });
    act(() => void vi.advanceTimersByTime(200));
    rerender({ v: 'abc' });
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current).toBe('a');
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current).toBe('abc');
  });
});
