import { requireInternalToken } from './bootstrap';

/** The service-side check that a request came through the gateway (REQUIRE_INTERNAL_TOKEN, Phase 11b P1-29). */
const TOKEN = 'common-spec-internal-token-not-real';

function run(path: string, headers: Record<string, string> = {}) {
  const res: { statusCode: number; body: string; setHeader: jest.Mock; end: jest.Mock } = { statusCode: 200, body: '', setHeader: jest.fn(), end: jest.fn() };
  res.end.mockImplementation((b: string) => {
    res.body = b;
  });
  const next = jest.fn();
  requireInternalToken(Buffer.from(TOKEN))({ path, headers }, res, next);
  return { res, next };
}

describe('requireInternalToken', () => {
  it.each([
    ['no token', {}],
    ['a wrong token of the same length', { 'x-internal-token': TOKEN.replace(/.$/, 'X') }],
    ['a prefix of the token', { 'x-internal-token': TOKEN.slice(0, 10) }],
  ])('refuses %s with 401', (_label, headers) => {
    const { res, next } = run('/api/v1/enrollments', headers);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ statusCode: 401 });
  });

  it('passes the right token', () => {
    const { res, next } = run('/api/v1/enrollments', { 'x-internal-token': TOKEN });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
  });

  it.each(['/health', '/ready'])('leaves %s open for probes', (path) => {
    expect(run(path).next).toHaveBeenCalledTimes(1);
  });
});
