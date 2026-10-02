import { InternalHttpClient, internalPath } from './internal-client';

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
});
