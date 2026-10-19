import { describe, expect, it } from 'vitest';
import { percentLabel, percentWidth } from './progress';

describe('progress display', () => {
  it('shows a known percent as is, including 0', () => {
    expect(percentLabel(42)).toBe('42%');
    expect(percentLabel(0)).toBe('0%');
    expect(percentWidth(42)).toBe('42%');
  });

  it('shows "—" for an unknown percent (null), never 0%', () => {
    expect(percentLabel(null)).toBe('—');
    expect(percentLabel(undefined)).toBe('—');
    expect(percentWidth(null)).toBe('0%');
  });
});
