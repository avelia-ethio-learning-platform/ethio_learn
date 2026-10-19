import { afterEach, describe, expect, it, vi } from 'vitest';
import Layout from './layout';

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.notFound.mockClear();
});

describe('dev checkout layout (P2-31)', () => {
  it('is a 404 on Vercel production', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(() => Layout({ children: 'checkout' })).toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it.each([['preview'], ['development'], [undefined]])('serves the mock checkout when VERCEL_ENV is %s (local dev, compose, CI e2e)', (vercelEnv) => {
    vi.stubEnv('VERCEL_ENV', vercelEnv);
    expect(Layout({ children: 'checkout' })).toBe('checkout');
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});
