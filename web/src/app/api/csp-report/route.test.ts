// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Post = (req: Request) => Promise<Response>;

/** A fresh module per test, so each starts with no reports received. */
async function freshPost(): Promise<Post> {
  vi.resetModules();
  return (await import('./route')).POST;
}

const report = (blocked: string) =>
  new Request('http://localhost:3000/api/csp-report', {
    method: 'POST',
    headers: { 'content-type': 'application/csp-report' },
    body: JSON.stringify({
      'csp-report': {
        'document-uri': 'http://localhost:3000/learn/c1?tab=notes',
        'effective-directive': 'media-src',
        'blocked-uri': blocked,
        disposition: 'enforce',
      },
    }),
  });

describe('POST /api/csp-report', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('logs the useful fields with 204, and drops query strings (signed URLs)', async () => {
    const POST = await freshPost();
    const res = await POST(report('https://acct.r2.cloudflarestorage.com/b/v.m3u8?X-Amz-Signature=secret'));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('"directive":"media-src"');
    expect(line).toContain('"blocked":"https://acct.r2.cloudflarestorage.com/b/v.m3u8"');
    expect(line).toContain('"page":"http://localhost:3000/learn/c1"');
    expect(line).not.toContain('Signature');
  });

  it('refuses a body over 8 KB, by header or by actual size', async () => {
    const POST = await freshPost();
    const big = 'x'.repeat(8 * 1024 + 1);
    expect((await POST(new Request('http://localhost/api/csp-report', { method: 'POST', body: big }))).status).toBe(413);
    const lying = new Request('http://localhost/api/csp-report', {
      method: 'POST',
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      // @ts-expect-error Node's fetch needs this for a stream body
      duplex: 'half',
    });
    expect((await POST(lying)).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs the first 100 reports, then 1 in 10', async () => {
    const POST = await freshPost();
    for (let i = 0; i < 200; i++) await POST(report('https://evil.example/x.js'));
    expect(warn).toHaveBeenCalledTimes(100 + 10);
  });

  it('answers an unparsable body with 204 too', async () => {
    const POST = await freshPost();
    const res = await POST(new Request('http://localhost/api/csp-report', { method: 'POST', body: 'not json' }));
    expect(res.status).toBe(204);
    expect(String(warn.mock.calls[0][0])).toContain('unparsable');
  });
});
