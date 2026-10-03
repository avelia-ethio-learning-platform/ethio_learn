import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusBadge } from './PageChrome';

afterEach(cleanup);

describe('<StatusBadge />', () => {
  it('shows a human label and the tone from labels.ts', () => {
    render(<StatusBadge status="under_review" />);
    const badge = screen.getByText('Under review');
    expect(badge.className).toBe('badge-warn');
  });

  it('keeps the tone of every lifecycle status', () => {
    render(
      <>
        <StatusBadge status="published" />
        <StatusBadge status="banned" />
        <StatusBadge status="draft" />
      </>,
    );
    expect(screen.getByText('Published').className).toBe('badge-success');
    expect(screen.getByText('Banned').className).toBe('badge-danger');
    expect(screen.getByText('Draft').className).toBe('badge-neutral');
  });

  it('lets a caller override the wording, and appends the suffix', () => {
    render(<StatusBadge status="initiated" label="Payment not finished" suffix="2 days" />);
    const badge = screen.getByText('Payment not finished · 2 days');
    expect(badge.className).toBe('badge-warn');
  });

  it('never shows a raw enum for an unknown status', () => {
    render(<StatusBadge status="pending_claim" />);
    expect(screen.getByText('Pending claim').className).toBe('badge-neutral');
  });
});
