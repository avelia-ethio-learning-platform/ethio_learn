import { Response } from 'express';
import { clearRefreshCookie, setRefreshCookie } from './refresh-cookie';

/** The refresh cookie's security attributes (Phase 11b, S2). */
function header(write: (res: Response) => void): string {
  let value = '';
  write({ setHeader: (_name: string, v: string) => (value = v) } as unknown as Response);
  return value;
}

describe('setRefreshCookie', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('in production: HttpOnly, Secure, SameSite=Lax, scoped to /api/v1/auth', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COOKIE_SAMESITE;
    const cookie = header((res) => setRefreshCookie(res, 'tok', 60));
    expect(cookie).toMatch(/^el_refresh=tok;/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/v1/auth');
    expect(cookie).toContain('Max-Age=60');
  });

  it('SameSite=None always forces Secure, even outside production', () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SAMESITE = 'none';
    const cookie = header((res) => setRefreshCookie(res, 'tok', 60));
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
  });

  it('clearing uses the same attributes and expires it', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COOKIE_SAMESITE;
    const cookie = header((res) => clearRefreshCookie(res));
    expect(cookie).toMatch(/^el_refresh=;/);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/api/v1/auth');
  });
});
