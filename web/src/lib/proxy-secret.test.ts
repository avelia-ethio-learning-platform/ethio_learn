import { describe, expect, it } from 'vitest';
import { assertProxySecret } from './proxy-secret.mjs';

describe('assertProxySecret', () => {
  const long = 'x'.repeat(32);

  it('fails a Vercel production build without a 32+ character secret', () => {
    for (const WEB_PROXY_SECRET of [undefined, '', 'short', ` ${'x'.repeat(31)}\n`]) {
      expect(() => assertProxySecret({ VERCEL_ENV: 'production', WEB_PROXY_SECRET }), JSON.stringify(WEB_PROXY_SECRET)).toThrow(/WEB_PROXY_SECRET/);
    }
  });

  it('never puts the value in the error', () => {
    let message = '';
    try {
      assertProxySecret({ VERCEL_ENV: 'production', WEB_PROXY_SECRET: 'secret-value' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/12 characters/);
    expect(message).not.toContain('secret-value');
  });

  it('passes a long secret, and never checks previews, CI or local builds', () => {
    expect(() => assertProxySecret({ VERCEL_ENV: 'production', WEB_PROXY_SECRET: long })).not.toThrow();
    expect(() => assertProxySecret({ VERCEL_ENV: 'preview' })).not.toThrow();
    expect(() => assertProxySecret({ NODE_ENV: 'production' })).not.toThrow();
  });
});
