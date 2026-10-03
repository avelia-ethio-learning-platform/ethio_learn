import { describe, expect, it } from 'vitest';
import { assertSiteUrl } from './site-url.mjs';

describe('assertSiteUrl', () => {
  it('fails a Vercel production build without a real https site URL', () => {
    for (const NEXT_PUBLIC_SITE_URL of [undefined, '', 'http://ethiopialearn.example', 'https://REPLACE.vercel.app', 'https://replace-me.example']) {
      expect(() => assertSiteUrl({ VERCEL_ENV: 'production', NEXT_PUBLIC_SITE_URL }), String(NEXT_PUBLIC_SITE_URL)).toThrow(/NEXT_PUBLIC_SITE_URL/);
    }
  });

  it('passes a real URL, and never checks previews, CI or local builds', () => {
    expect(() => assertSiteUrl({ VERCEL_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'https://ethiopialearn.example' })).not.toThrow();
    expect(() => assertSiteUrl({ VERCEL_ENV: 'preview' })).not.toThrow();
    expect(() => assertSiteUrl({ NODE_ENV: 'production' })).not.toThrow();
  });
});
