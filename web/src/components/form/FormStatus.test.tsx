import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { FormStatus, useFormStatus } from './FormStatus';

afterEach(cleanup);

describe('<FormStatus />', () => {
  it('mounts both live regions, empty, before any status is set', () => {
    render(<FormStatus status={null} />);
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('puts an ok status in the status region only, styled as success', () => {
    const { rerender } = render(<FormStatus status={null} />);
    const status = screen.getByRole('status');
    const alert = screen.getByRole('alert');
    rerender(<FormStatus status={{ tone: 'ok', text: 'Saved' }} />);
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('Saved');
    expect(status.querySelector('.badge-success')).not.toBeNull();
    expect(alert.textContent).toBe('');
  });

  it('puts an error in the alert region only, and clears the other region on a tone change', () => {
    const { rerender } = render(<FormStatus status={{ tone: 'ok', text: 'Saved' }} />);
    rerender(<FormStatus status={{ tone: 'error', text: 'Failed' }} />);
    expect(screen.getByRole('alert').textContent).toBe('Failed');
    expect(screen.getByRole('alert').querySelector('.badge-danger')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('useFormStatus', () => {
  it('returns [status, setOk, setError, clear]', () => {
    const { result } = renderHook(() => useFormStatus());
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]('Done'));
    expect(result.current[0]).toEqual({ tone: 'ok', text: 'Done' });
    act(() => result.current[2]('Nope'));
    expect(result.current[0]).toEqual({ tone: 'error', text: 'Nope' });
    act(() => result.current[3]());
    expect(result.current[0]).toBeNull();
  });
});
