import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, wakeServices } = vi.hoisted(() => ({ refresh: vi.fn(), wakeServices: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/lib/wake', () => ({ wakeServices }));

import { WakingUp } from './WakingUp';

beforeEach(() => {
  refresh.mockReset();
  wakeServices.mockReset();
});
afterEach(cleanup);

describe('<WakingUp />', () => {
  it('announces the state and wakes the services on mount', () => {
    render(<WakingUp />);
    expect(screen.getByRole('status').textContent).toMatch(/waking up the server/i);
    expect(wakeServices).toHaveBeenCalledTimes(1);
  });

  it('Retry re-renders the page on the server', () => {
    render(<WakingUp />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(wakeServices).toHaveBeenCalledTimes(2);
  });

  it('on a client-fetched page, Retry calls onRetry instead and says it is checking', async () => {
    let settle!: () => void;
    const onRetry = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    render(<WakingUp onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(wakeServices).toHaveBeenCalledTimes(2);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => settle());
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
