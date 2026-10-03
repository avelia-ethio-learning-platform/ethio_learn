import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Header } from './Header';

vi.mock('next/navigation', () => ({
  usePathname: () => '/courses',
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Test Learner', email: 'l@example.test', role: 'learner' }, ready: true }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: vi.fn(async (path: string) => (path.includes('unread-count') ? { count: 0 } : [])),
}));

function renderHeader() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Header />
    </QueryClientProvider>,
  );
}

// The header renders desktop and mobile copies of the toggles; both exist in the DOM.
const themeButtons = () => screen.getAllByRole('button', { name: 'Theme' });
const bellButtons = () => screen.getAllByRole('button', { name: 'Notifications' });

beforeEach(() => {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('Header overlays', () => {
  it('theme menu: aria-expanded toggles, Escape closes it and returns focus to the trigger', async () => {
    renderHeader();
    const trigger = themeButtons()[0];
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    const option = within(panel).getByRole('button', { name: /dark/i });
    expect(option.getAttribute('aria-pressed')).toBe('false');
    option.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('notification panel: aria-expanded toggles, Escape closes it and returns focus to the trigger', async () => {
    renderHeader();
    const trigger = bellButtons()[0];
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).not.toBeNull();
    screen.getAllByRole('button', { name: 'Notifications' })[0].focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('opening the bell closes the theme menu', () => {
    renderHeader();
    const theme = themeButtons()[0];
    const bell = bellButtons()[0];
    fireEvent.click(theme);
    expect(theme.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(bell);
    expect(bell.getAttribute('aria-expanded')).toBe('true');
    expect(theme.getAttribute('aria-expanded')).toBe('false');
  });

  it('mobile menu: aria-expanded toggles and Escape closes it with focus back on the burger', async () => {
    renderHeader();
    const burger = screen.getByRole('button', { name: 'Menu' });
    expect(burger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(burger);
    expect(burger.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(burger.getAttribute('aria-controls')!)).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(burger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(burger);
    await waitFor(() => expect(screen.queryByTestId('mobile-menu-panel')).toBeNull());
  });

  it('mobile menu: focus moves to the first link, and Tab wraps at both ends', () => {
    renderHeader();
    const burger = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(burger);
    const panel = screen.getByTestId('mobile-menu-panel');
    const controls = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    expect(document.activeElement).toBe(controls[0]);
    expect(controls[0].textContent).toBe('Home');

    // Forward from the last control lands on the burger, and on from there to the first link.
    controls[controls.length - 1].focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(burger);
    // Backward from the burger lands on the last control.
    fireEvent.keyDown(burger, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(controls[controls.length - 1]);
  });

  it('mobile menu: lists Help and Educators, and the theme menu inside it does not close it', () => {
    renderHeader();
    const burger = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(burger);
    const panel = screen.getByTestId('mobile-menu-panel');
    expect(within(panel).getByRole('link', { name: 'Help' }).getAttribute('href')).toBe('/help');
    expect(within(panel).getByRole('link', { name: 'Educators' }).getAttribute('href')).toBe('/educators');
    expect(within(panel).getByRole('link', { name: 'My learning' })).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Theme' }));
    expect(burger.getAttribute('aria-expanded')).toBe('true');
  });

  it('Escape with the theme menu open in the mobile menu closes only the theme menu, then the mobile menu', () => {
    renderHeader();
    const burger = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(burger);
    const panel = screen.getByTestId('mobile-menu-panel');
    const themeTrigger = within(panel).getByRole('button', { name: 'Theme' });
    fireEvent.click(themeTrigger);
    expect(themeTrigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(themeTrigger.getAttribute('aria-expanded')).toBe('false');
    expect(burger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(themeTrigger);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(burger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(burger);
  });

  it('keeps the selectors the e2e specs use: nav "Main" and both test ids', () => {
    renderHeader();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByTestId('menu-backdrop')).toBeTruthy();
    expect(screen.getByTestId('mobile-menu-panel')).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('menu-backdrop'));
    fireEvent.click(screen.getByTestId('menu-backdrop'));
    expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Header nav', () => {
  it('renders visible in the server HTML, with no framer entrance state', () => {
    const { container } = renderHeader();
    const nav = container.querySelector('nav[aria-label="Main"]')!;
    expect(nav.getAttribute('style')).toBeNull();
  });
});
