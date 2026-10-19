import { requestContext } from '../context';
import { InternalHttpClient, internalPath } from './internal-client';
import { PeerAsleepError, PeerNotFoundError, PeerUnavailableError } from './internal-errors';

describe('internalPath', () => {
  it('encodes a traversal-looking value into one segment', () => {
    expect(internalPath`/api/v1/internal/lessons/${'../users/x'}`).toBe(
      '/api/v1/internal/lessons/..%2Fusers%2Fx',
    );
  });

  it('encodes an already-encoded slash again', () => {
    expect(internalPath`/api/v1/internal/lessons/${'a%2Fb'}`).toBe('/api/v1/internal/lessons/a%252Fb');
  });

  it('encodes ?, # and & in values', () => {
    expect(internalPath`/api/v1/internal/x?q=${'a?b#c&d=e'}`).toBe('/api/v1/internal/x?q=a%3Fb%23c%26d%3De');
  });

  it('stringifies numbers', () => {
    expect(internalPath`/api/v1/internal/x?limit=${25}`).toBe('/api/v1/internal/x?limit=25');
  });

  it('joins array items with a literal comma, each item encoded', () => {
    expect(internalPath`/api/v1/internal/x?course_ids=${['a', 'b/c', 'd,e']}`).toBe(
      '/api/v1/internal/x?course_ids=a,b%2Fc,d%2Ce',
    );
  });
});

describe('InternalHttpClient.get', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let client: InternalHttpClient;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: 1 }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.INTERNAL_API_TOKEN = 'test-internal-token';
    client = new InternalHttpClient();
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('fetches a valid path under the gateway with the internal token', async () => {
    const path = internalPath`/api/v1/internal/lessons/${'abc'}?q=${'a b'}`;
    await expect(client.get(path)).resolves.toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/v1\/internal\/lessons\/abc\?q=a%20b$/);
    expect(init.headers['x-internal-token']).toBe('test-internal-token');
  });

  it('logs a failed call with the path redacted, and throws without it', async () => {
    const warn = jest.spyOn((client as unknown as { logger: { warn(msg: string): void } }).logger, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue({ ok: false, status: 503, headers: new Headers(), text: async () => '' });
    const error = await client.get<never>(internalPath`/api/v1/internal/users/by-email/${'abebe@example.com'}`).catch((err: Error) => err);

    expect(warn).toHaveBeenCalledWith('internal GET /api/v1/internal/users/by-email/[email] failed (503)');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain('abebe');
  });

  it("forwards the current request's id, and sends none outside a request", async () => {
    const path = internalPath`/api/v1/internal/lessons/${'abc'}`;
    await requestContext.run({ request_id: '0b6f3c1e-5d2a-4f8e-9c71-2a4d6e8f0b13' }, () => client.get(path));
    await client.get(path);
    expect(fetchMock.mock.calls[0][1].headers['x-request-id']).toBe('0b6f3c1e-5d2a-4f8e-9c71-2a4d6e8f0b13');
    expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty('x-request-id');
  });

  it.each([
    ['a prefix outside /api/v1/internal/', '/api/v1/users/x'],
    ['a prefix without the trailing slash', '/api/v1/internal'],
    ['a dot segment', '/api/v1/internal/a/../users/x'],
    ['an encoded dot segment', '/api/v1/internal/a/%2e%2e/users/x'],
    ['a backslash', '/api/v1/internal/a\\..\\users'],
    ['a fragment', '/api/v1/internal/a#b'],
  ])('refuses %s without fetching', async (_label, raw) => {
    await expect(client.get(raw as never)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a value of exactly ".." that encodeURIComponent leaves alone', async () => {
    const path = internalPath`/api/v1/internal/lessons/${'..'}/x`;
    expect(path).toBe('/api/v1/internal/lessons/../x');
    await expect(client.get(path)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a ".." value in the middle of the path', async () => {
    await expect(client.get(internalPath`/api/v1/internal/${'..'}/users/x`)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('failures', () => {
    const reply = (status: number, body = '', headers: Record<string, string> = {}) => ({
      ok: false,
      status,
      headers: new Headers(headers),
      text: async () => body,
    });
    const refused = () => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    const path = internalPath`/api/v1/internal/users/${'jane.doe@example.com'}`;

    it('404 is PeerNotFoundError', async () => {
      fetchMock.mockResolvedValue(reply(404));
      await expect(client.get(path)).rejects.toBeInstanceOf(PeerNotFoundError);
    });

    it('429 with the hibernate routing header is PeerAsleepError', async () => {
      fetchMock.mockResolvedValue(reply(429, 'Too Many Requests', { 'x-render-routing': 'hibernate-rate-limited' }));
      await expect(client.get(path)).rejects.toBeInstanceOf(PeerAsleepError);
    });

    it('a plain-text 429 without the header is PeerAsleepError', async () => {
      fetchMock.mockResolvedValue(reply(429, 'rate limited'));
      await expect(client.get(path)).rejects.toBeInstanceOf(PeerAsleepError);
    });

    it('a JSON 429 is a limiter: PeerUnavailableError', async () => {
      fetchMock.mockResolvedValue(reply(429, JSON.stringify({ statusCode: 429 })));
      await expect(client.get(path)).rejects.toBeInstanceOf(PeerUnavailableError);
    });

    it.each([500, 502])('%i is PeerUnavailableError and is not retried', async (status) => {
      fetchMock.mockResolvedValue(reply(status));
      await expect(client.get(path)).rejects.toBeInstanceOf(PeerUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a timeout is PeerUnavailableError and is not retried', async () => {
      fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
      await expect(client.get(path)).rejects.toBeInstanceOf(PeerUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries once after ECONNREFUSED and returns the second answer', async () => {
      fetchMock.mockRejectedValueOnce(refused()).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: 2 }) });
      await expect(client.get(path)).resolves.toEqual({ ok: 2 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('ECONNREFUSED twice is PeerUnavailableError after exactly two attempts', async () => {
      fetchMock.mockRejectedValue(refused());
      await expect(client.get(path)).rejects.toBeInstanceOf(PeerUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries once after a dropped keep-alive socket (UND_ERR_SOCKET)', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } }))
        .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: 3 }) });
      await expect(client.get(path)).resolves.toEqual({ ok: 3 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a timeout while reading the body is PeerUnavailableError, not retried', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: () => Promise.reject(new DOMException('timed out', 'TimeoutError')) });
      await expect(client.get(path)).rejects.toBeInstanceOf(PeerUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('neither the error message nor its body carries any part of the path', async () => {
      for (const status of [404, 500, 429]) {
        fetchMock.mockResolvedValue(reply(status));
        const err = (await client.get(path).catch((e) => e)) as PeerUnavailableError;
        expect(JSON.stringify([err.message, err.getResponse()])).not.toMatch(/jane|example|users/);
      }
    });
  });
});
