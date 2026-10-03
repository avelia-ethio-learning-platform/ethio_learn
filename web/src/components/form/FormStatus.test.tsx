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

  it('puts an info status in the polite region, styled as a warning, never as success', () => {
    const { rerender } = render(<FormStatus status={null} />);
    const status = screen.getByRole('status');
    rerender(<FormStatus status={{ tone: 'info', text: 'Score: 40 — not passed yet' }} />);
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('Score: 40 — not passed yet');
    expect(status.querySelector('.badge-warn')).not.toBeNull();
    expect(status.querySelector('.badge-success')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('renders the message as a full-width, wrapping text-sm banner, not a 12 px pill', () => {
    render(<FormStatus status={{ tone: 'error', text: 'Something went wrong on our side. Please try again in a minute.' }} />);
    const message = screen.getByRole('alert').firstElementChild!;
    expect(message.className).toContain('w-full');
    expect(message.className).toContain('!text-sm');
    expect(message.className).toContain('!whitespace-normal');
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
  it('returns [status, setOk, setError, clear, setInfo]', () => {
    const { result } = renderHook(() => useFormStatus());
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]('Done'));
    expect(result.current[0]).toEqual({ tone: 'ok', text: 'Done' });
    act(() => result.current[2]('Nope'));
    expect(result.current[0]).toEqual({ tone: 'error', text: 'Nope' });
    act(() => result.current[3]());
    expect(result.current[0]).toBeNull();
    act(() => result.current[4]('Not yet'));
    expect(result.current[0]).toEqual({ tone: 'info', text: 'Not yet' });
  });
});
