import { describe, expect, it } from 'vitest';
import { buildCsp, cspEnforced, securityHeaders } from './csp.mjs';

/** The policy as { directive: sources[] }, failing on a repeated directive. */
function parse(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(';').map((p) => p.trim())) {
    const [name, ...sources] = part.split(/\s+/);
    expect(out[name], `directive ${name} appears twice`).toBeUndefined();
    out[name] = sources;
  }
  return out;
}

const production = {
  NODE_ENV: 'production',
  VERCEL_ENV: 'production',
  NEXT_PUBLIC_API_URL: 'https://api.example.et/',
  NEXT_PUBLIC_S3_PUBLIC_URL: 'https://pub-1.r2.dev/bucket/thumbs',
  NEXT_PUBLIC_MEDIA_ORIGINS: 'https://acct.r2.cloudflarestorage.com/bucket, https://stream.example.et:8443/x',
  NEXT_PUBLIC_WAKE_URLS: 'https://svc-a.onrender.com/health,https://svc-b.onrender.com/health, not a url,',
  NEXT_PUBLIC_GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
};

describe('buildCsp', () => {
  it('reduces every configured URL to its origin, once', () => {
    const csp = parse(buildCsp(production));
    expect(csp['connect-src']).toEqual([
      "'self'",
      'https://api.example.et',
      'https://svc-a.onrender.com',
      'https://svc-b.onrender.com',
      'https://acct.r2.cloudflarestorage.com',
      'https://stream.example.et:8443',
      'https://accounts.google.com/gsi/',
    ]);
    // Proctoring snapshots are signed storage URLs, so images allow the media origins too.
    expect(csp['img-src']).toEqual([
      "'self'",
      'data:',
      'blob:',
      'https://pub-1.r2.dev',
      'https://acct.r2.cloudflarestorage.com',
      'https://stream.example.et:8443',
      'https://*.googleusercontent.com',
    ]);
    expect(csp['media-src']).toEqual(["'self'", 'blob:', 'https://acct.r2.cloudflarestorage.com', 'https://stream.example.et:8443']);
  });

  it('allows Google sign-in only when a client id is set', () => {
    const withGoogle = buildCsp(production);
    expect(parse(withGoogle)['script-src']).toContain('https://accounts.google.com/gsi/client');
    expect(parse(withGoogle)['style-src']).toContain('https://accounts.google.com/gsi/style');
    expect(parse(withGoogle)['frame-src']).toEqual(['https://accounts.google.com/gsi/']);

    const without = buildCsp({ ...production, NEXT_PUBLIC_GOOGLE_CLIENT_ID: '' });
    expect(without).not.toContain('google');
    expect(parse(without)['frame-src']).toEqual(["'none'"]);
  });

  it("adds 'unsafe-eval' under next dev only (plan-review S1)", () => {
    expect(parse(buildCsp({ NODE_ENV: 'development' }))['script-src']).toContain("'unsafe-eval'");
    expect(buildCsp({ NODE_ENV: 'production' })).not.toContain("'unsafe-eval'");
    expect(buildCsp(production)).not.toContain("'unsafe-eval'");
    expect(parse(buildCsp(production))['script-src']).toEqual(
      expect.arrayContaining(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"]),
    );
  });

  it('falls back to the local API and MinIO, which also serves uploads and video', () => {
    const csp = parse(buildCsp({ NODE_ENV: 'production' }));
    expect(csp['connect-src']).toEqual(["'self'", 'http://localhost:4000', 'http://localhost:9000']);
    expect(csp['media-src']).toEqual(["'self'", 'blob:', 'http://localhost:9000']);
    expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:', 'http://localhost:9000']);
  });

  it('locks down framing, plugins, <base> and form targets, and reports to the app', () => {
    const csp = parse(buildCsp({}));
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(csp['report-uri']).toEqual(['/api/csp-report']);
    expect(csp['report-to']).toEqual(['csp-endpoint']);
    expect(csp).not.toHaveProperty('upgrade-insecure-requests');
    expect(parse(buildCsp(production))).toHaveProperty('upgrade-insecure-requests');
  });

  it('never allows a wildcard host or placehold.co', () => {
    const policy = buildCsp(production);
    expect(policy).not.toMatch(/(^|\s)(\*|https:|http:)(\s|;|$)/);
    expect(policy).not.toContain('placehold.co');
  });
});

describe('enforced or Report-Only', () => {
  it('is Report-Only on Vercel production until CSP_ENFORCE=true', () => {
    expect(cspEnforced({ VERCEL_ENV: 'production' })).toBe(false);
    expect(cspEnforced({ VERCEL_ENV: 'production', CSP_ENFORCE: 'true' })).toBe(true);
  });

  it('is enforced everywhere else, including a production build (CI next start) and Vercel previews', () => {
    expect(cspEnforced({ NODE_ENV: 'production' })).toBe(true);
    expect(cspEnforced({ VERCEL_ENV: 'preview' })).toBe(true);
    expect(cspEnforced({ NODE_ENV: 'development' })).toBe(true);
    expect(cspEnforced({ CSP_ENFORCE: 'false' })).toBe(false);
  });

  it('names the header accordingly', () => {
    const names = (env: Record<string, string>) => securityHeaders(env).map((h) => h.key);
    expect(names({ VERCEL_ENV: 'production' })).toContain('Content-Security-Policy-Report-Only');
    expect(names({ VERCEL_ENV: 'production' })).not.toContain('Content-Security-Policy');
    expect(names({ NODE_ENV: 'production' })).toContain('Content-Security-Policy');
  });
});

describe('securityHeaders', () => {
  it('sends the fixed headers everywhere and HSTS on Vercel production only', () => {
    const local = Object.fromEntries(securityHeaders({ NODE_ENV: 'production' }).map((h) => [h.key, h.value]));
    expect(local).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
      'Reporting-Endpoints': 'csp-endpoint="/api/csp-report"',
    });
    expect(local).not.toHaveProperty('Strict-Transport-Security');

    const prod = Object.fromEntries(securityHeaders(production).map((h) => [h.key, h.value]));
    expect(prod['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains');
  });
});
