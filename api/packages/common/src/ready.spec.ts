import { Readiness } from './ready';

function deps(over: { query?: jest.Mock; connected?: boolean; extra?: Record<string, () => Promise<unknown>> } = {}) {
  const db = { query: over.query ?? jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
  const bus = { isConnected: jest.fn(() => over.connected ?? true) };
  return { serviceName: 'quality', db, bus, extra: over.extra };
}

describe('Readiness (/ready)', () => {
  afterEach(() => jest.useRealTimers());

  it('200 ready when the database and the broker are up', async () => {
    await expect(new Readiness(deps()).check()).resolves.toEqual({
      statusCode: 200,
      body: { status: 'ready', service: 'quality', checks: { db: 'ok', broker: 'ok' } },
    });
  });

  it('503 with db down when SELECT 1 fails', async () => {
    const r = await new Readiness(deps({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:5432')) })).check();
    expect(r).toEqual({ statusCode: 503, body: { status: 'not_ready', service: 'quality', checks: { db: 'down', broker: 'ok' } } });
    expect(JSON.stringify(r)).not.toContain('10.0.0.5'); // no hosts or error text
  });

  it('503 with db down when SELECT 1 takes longer than 2 s', async () => {
    jest.useFakeTimers();
    const pending = new Readiness(deps({ query: jest.fn(() => new Promise(() => undefined)) })).check();
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ statusCode: 503, body: { checks: { db: 'down' } } });
  });

  it('503 with broker down when the bus is disconnected', async () => {
    await expect(new Readiness(deps({ connected: false })).check()).resolves.toMatchObject({
      statusCode: 503,
      body: { checks: { db: 'ok', broker: 'down' } },
    });
  });

  it("runs the service's own checks, each with a 1 s timeout (auth: Redis)", async () => {
    jest.useFakeTimers();
    const pending = new Readiness(deps({ extra: { redis: () => new Promise(() => undefined) } })).check();
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ statusCode: 503, body: { checks: { db: 'ok', broker: 'ok', redis: 'down' } } });
    await expect(new Readiness(deps({ extra: { redis: async () => 'PONG' } })).check()).resolves.toMatchObject({
      statusCode: 200,
      body: { checks: { redis: 'ok' } },
    });
  });

  it('a check that throws instead of rejecting counts as down, and /ready still answers', async () => {
    const extra = {
      redis: () => {
        throw new Error('client not created');
      },
    };
    await expect(new Readiness(deps({ extra })).check()).resolves.toMatchObject({ statusCode: 503, body: { checks: { redis: 'down' } } });
  });

  it('50 concurrent calls run one SELECT 1, and the answer is reused for 5 s', async () => {
    let now = 0;
    const d = deps();
    const readiness = new Readiness(d, () => now);

    const answers = await Promise.all(Array.from({ length: 50 }, () => readiness.check()));
    expect(d.db.query).toHaveBeenCalledTimes(1);
    expect(new Set(answers.map((a) => a.statusCode))).toEqual(new Set([200]));

    now = 4_999;
    await readiness.check();
    expect(d.db.query).toHaveBeenCalledTimes(1);

    now = 5_000;
    d.bus.isConnected.mockReturnValue(false);
    await expect(readiness.check()).resolves.toMatchObject({ statusCode: 503 });
    expect(d.db.query).toHaveBeenCalledTimes(2);
  });
});
