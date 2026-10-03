import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PanelError } from './PanelError';

afterEach(cleanup);

describe('<PanelError />', () => {
  it('names the panel in an alert and Retry calls the refetch', () => {
    const refetch = vi.fn(() => Promise.resolve());
    render(<PanelError panel="assessments" onRetry={refetch} />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load assessments.");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
