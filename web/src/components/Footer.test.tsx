import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Footer } from './Footer';

let auth: { user: { role: string } | null; ready: boolean } = { user: null, ready: true };
vi.mock('@/lib/hooks', () => ({ useAuth: () => auth }));

afterEach(cleanup);

const href = (name: string) => screen.getByRole('link', { name }).getAttribute('href');

describe('Footer', () => {
  it('signed out: Log in and Sign up, no Account', () => {
    auth = { user: null, ready: true };
    render(<Footer />);
    expect(href('Log in')).toBe('/login');
    expect(href('Sign up')).toBe('/signup');
    expect(screen.queryByRole('link', { name: 'Account' })).toBeNull();
    expect(href('Verify a certificate')).toBe('/verify');
    expect(href('Educators')).toBe('/educators');
    expect(href('Help')).toBe('/help');
  });

  it('learner: their home and Account, no Log in', () => {
    auth = { user: { role: 'learner' }, ready: true };
    render(<Footer />);
    expect(href('My learning')).toBe('/dashboard');
    expect(href('Account')).toBe('/account');
    expect(screen.queryByRole('link', { name: 'Log in' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Sign up' })).toBeNull();
  });

  it('educator: the educator dashboard and Account', () => {
    auth = { user: { role: 'educator' }, ready: true };
    render(<Footer />);
    expect(href('Educator dashboard')).toBe('/teach');
    expect(href('Account')).toBe('/account');
  });
});
