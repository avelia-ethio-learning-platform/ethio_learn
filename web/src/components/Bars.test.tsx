import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Bars } from './Bars';

afterEach(cleanup);

const data = [
  { label: '2026-09', value: 600 },
  { label: '2026-10', value: 1200 },
  { label: '2026-11', value: 0 },
];

describe('<Bars />', () => {
  it('draws non-zero bars at their share of the tallest', () => {
    const { container } = render(<Bars data={data} title="Revenue" />);
    const heights = Array.from(container.querySelectorAll<HTMLElement>('li > div > div')).map((el) => el.style.height);
    expect(heights).toEqual(['50%', '100%']);
  });

  it('is a named list with month and value text for a screen reader', () => {
    render(<Bars data={data} title="Revenue" format={(v) => `${v.toLocaleString('en-GB')} ETB`} />);
    const list = screen.getByRole('list', { name: 'Revenue' });
    expect(list.querySelectorAll('li')).toHaveLength(3);
    expect(list.textContent).toContain('October 2026: 1,200 ETB');
    expect(list.textContent).toContain('September 2026: 600 ETB');
  });

  it('shows month names and values, and the year on January', () => {
    const { container } = render(<Bars data={[{ label: '2026-01', value: 5 }, { label: '2026-02', value: 3 }]} />);
    const visible = Array.from(container.querySelectorAll('[aria-hidden="true"]')).map((el) => el.textContent);
    expect(visible).toContain('Jan2026');
    expect(visible).toContain('Feb');
    expect(visible).toContain('5');
  });

  it('says so instead of drawing flat bars when every value is zero', () => {
    render(<Bars data={[{ label: '2026-09', value: 0 }]} empty="No revenue in the last 12 months" />);
    expect(screen.getByText('No revenue in the last 12 months')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('draws large values compactly and lets columns shrink, keeping the full value for screen readers', () => {
    const { container } = render(<Bars data={[{ label: '2026-09', value: 125000 }]} format={(v) => `${v.toLocaleString('en-GB')} ETB`} />);
    const li = container.querySelector('li')!;
    expect(li.className).toContain('min-w-0');
    expect(li.querySelector('[aria-hidden="true"]')!.textContent).toBe('125K');
    expect(li.querySelector('.sr-only')!.textContent).toContain('125,000 ETB');
  });
});
