import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RequireRole } from './RequireRole';

let auth: { user: { role: string } | null; ready: boolean } = { user: null, ready: true };
vi.mock('next/navigation', () => ({ usePathname: () => '/learn/abc' }));
vi.mock('@/lib/hooks', () => ({ useAuth: () => auth }));

afterEach(cleanup);

describe('RequireRole', () => {
  it('signed out: the log-in link carries the current path as next', () => {
    auth = { user: null, ready: true };
    window.history.pushState({}, '', '/learn/abc');
    render(<RequireRole roles={['learner']}>secret</RequireRole>);
    expect(screen.getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe('/login?next=%2Flearn%2Fabc');
    expect(screen.queryByText('secret')).toBeNull();
  });

  it('signed out: the query string is kept in next', () => {
    auth = { user: null, ready: true };
    window.history.pushState({}, '', '/learn/abc?tab=2');
    render(<RequireRole roles={['learner']}>secret</RequireRole>);
    expect(screen.getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe('/login?next=%2Flearn%2Fabc%3Ftab%3D2');
  });

  it('wrong role: h1, the role name and a link to the role home', () => {
    auth = { user: { role: 'institution_admin' }, ready: true };
    render(<RequireRole roles={['educator']}>secret</RequireRole>);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("This page isn't available for your account");
    expect(screen.getByText('Institution admin')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Institution dashboard' }).getAttribute('href')).toBe('/institution');
    expect(screen.queryByText('secret')).toBeNull();
  });

  it('allowed role: renders children', () => {
    auth = { user: { role: 'educator' }, ready: true };
    render(<RequireRole roles={['educator']}>secret</RequireRole>);
    expect(screen.getByText('secret')).toBeTruthy();
  });
});
