import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Pager } from './Pager';

afterEach(cleanup);

describe('<Pager />', () => {
  it('shows the range and disables Previous on the first page', () => {
    render(<Pager page={1} pageSize={20} total={132} onPage={() => undefined} />);
    expect(screen.getByRole('status').textContent).toBe('Showing 1–20 of 132');
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clamps the last range and disables Next on the last page', () => {
    const onPage = vi.fn();
    render(<Pager page={7} pageSize={20} total={132} onPage={onPage} />);
    expect(screen.getByRole('status').textContent).toBe('Showing 121–132 of 132');
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPage).toHaveBeenCalledWith(6);
  });

  it('renders nothing for an empty list', () => {
    const { container } = render(<Pager page={1} pageSize={20} total={0} onPage={() => undefined} />);
    expect(container.textContent).toBe('');
  });
});
