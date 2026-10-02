import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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
});
