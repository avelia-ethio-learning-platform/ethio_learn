import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventBusService } from './event-bus.service';
import { OutboxService } from './outbox';
import { runOnce } from './run-once';

interface Row {
  id: string;
  event_type: string;
  payload: unknown;
  correlation_id: string | null;
  created_at: number;
  published_at: number | null;
  attempts: number;
  last_error: string | null;
}

/**
 * The outbox table in memory, with a transaction that rolls back on throw.
 * Speaks the statements OutboxService sends (and runOnce's, for the nesting spec).
 */
function fakeDataSource() {
  let rows: Row[] = [];
  let clock = 0; // clock_timestamp(): strictly increasing
  const unpublished = () => rows.filter((r) => r.published_at === null).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('INSERT INTO quality.outbox')) {
      const [id, event_type, payload, correlation_id] = params as [string, string, string, string | null];
      const row: Row = { id, event_type, payload: JSON.parse(payload), correlation_id, created_at: (clock += 1), published_at: null, attempts: 0, last_error: null };
      rows.push(row);
      return [{ created_at: new Date(row.created_at) }];
    }
    if (sql.startsWith('INSERT INTO quality.processed_events')) return [{ '?column?': 1 }];
    if (sql.startsWith('SELECT 1 FROM quality.outbox')) {
      const own = rows.find((r) => r.id === params[0])!;
      return unpublished().filter((r) => r.created_at < own.created_at || (r.created_at === own.created_at && r.id < own.id)).slice(0, 1);
    }
    if (sql.startsWith('SELECT id, event_type')) {
      return unpublished()
        .slice(0, 50)
        .map((r) => ({ ...r, created_at: new Date(r.created_at) }));
    }
    if (sql.startsWith('UPDATE quality.outbox SET published_at')) {
      const row = rows.find((r) => r.id === params[0] && r.published_at === null);
      if (row) row.published_at = Date.now();
      return [[], row ? 1 : 0];
    }
    if (sql.startsWith('UPDATE quality.outbox SET attempts')) {
      const row = rows.find((r) => r.id === params[0])!;
      row.attempts += 1;
      row.last_error = params[1] as string;
      return [[], 1];
    }
    if (sql.startsWith('DELETE FROM quality.outbox')) {
      const cutoff = Date.now() - (params[0] as number) * 86_400_000;
      const old = rows.filter((r) => r.published_at !== null && r.published_at < cutoff).slice(0, 500);
      rows = rows.filter((r) => !old.includes(r));
      return [[], old.length];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const tablePaths: Record<string, string> = { OutboxEvent: 'quality.outbox', ProcessedEvent: 'quality.processed_events' };
  const manager = {
    query,
    getRepository: (entity: { name: string }) => ({ metadata: { tablePath: tablePaths[entity.name] } }),
  };
  const dataSource = {
    query,
    getRepository: manager.getRepository,
    transaction: async <T>(fn: (m: typeof manager) => Promise<T>): Promise<T> => {
      const before = rows.map((r) => ({ ...r }));
      try {
        return await fn(manager);
      } catch (err) {
        rows = before;
        throw err;
      }
    },
  } as unknown as DataSource;
  return { dataSource, rows: () => rows, query };
}

function fakeBus() {
  const sent: Array<{ type: string; payload: unknown; eventId: string; correlationId?: string }> = [];
  const state = { connected: true };
  const bus = {
    get connected(): boolean {
      return state.connected;
    },
    set connected(value: boolean) {
      state.connected = value;
    },
    isConnected: jest.fn((): boolean => state.connected),
    publishConfirmed: jest.fn(async (type: string, payload: unknown, opts: { eventId: string; correlationId?: string }) => {
      sent.push({ type, payload, eventId: opts.eventId, correlationId: opts.correlationId });
    }),
  };
  return { bus, sent };
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

function setup() {
  const db = fakeDataSource();
  const { bus, sent } = fakeBus();
  const outbox = new OutboxService(db.dataSource, bus as unknown as EventBusService);
  return { ...db, bus, sent, outbox };
}

describe('OutboxService.transaction', () => {
  afterEach(() => jest.restoreAllMocks());

  it('an emit in a transaction that rolls back leaves no row and publishes nothing', async () => {
    const t = setup();
    await expect(
      t.outbox.transaction(async (_m, emit) => {
        emit('CourseRated', { course_id: 'c1' });
        throw new Error('constraint violation');
      }),
    ).rejects.toThrow('constraint violation');

    await tick();
    expect(t.rows()).toEqual([]);
    expect(t.bus.publishConfirmed).not.toHaveBeenCalled();
  });

  it('after commit, publishes each row with its id as the event id, and marks it published', async () => {
    const t = setup();
    const result = await t.outbox.transaction(async (_m, emit) => {
      emit('RefundApproved', { refund_request_id: 'r1' }, { correlationId: 'corr-1' });
      emit('CourseRated', { course_id: 'c1' });
      return 'done';
    });

    expect(result).toBe('done');
    await until(() => t.rows().every((r) => r.published_at !== null), 'both rows published');
    const [first, second] = t.rows();
    expect(t.sent).toEqual([
      { type: 'RefundApproved', payload: { refund_request_id: 'r1' }, eventId: first.id, correlationId: 'corr-1' },
      { type: 'CourseRated', payload: { course_id: 'c1' }, eventId: second.id, correlationId: undefined },
    ]);
  });

  it('a failed publish leaves the row, counted, and the relay sends it later with the same id', async () => {
    const t = setup();
    t.bus.publishConfirmed.mockRejectedValueOnce(new Error('broker did not confirm'));
    await t.outbox.transaction(async (_m, emit) => emit('CourseRated', { course_id: 'c1' }));
    await until(() => t.rows()[0].attempts === 1, 'the failure to be counted');
    expect(t.rows()[0]).toMatchObject({ published_at: null, last_error: 'broker did not confirm' });

    await t.outbox.relay();
    expect(t.sent.map((s) => s.eventId)).toEqual([t.rows()[0].id]);
    expect(t.rows()[0].published_at).not.toBeNull();
  });

  it('skips the fast path while the broker is down; the relay sends once it is back', async () => {
    const t = setup();
    t.bus.connected = false;
    await t.outbox.transaction(async (_m, emit) => emit('CourseRated', { course_id: 'c1' }));
    await t.outbox.relay();
    await tick();
    expect(t.bus.publishConfirmed).not.toHaveBeenCalled();
    expect(t.rows()[0].attempts).toBe(0); // an outage isn't counted against the row

    t.bus.connected = true;
    await t.outbox.relay();
    expect(t.sent).toHaveLength(1);
  });

  it('defers to the relay when an older row is unpublished, which then sends both in order', async () => {
    const t = setup();
    t.bus.connected = false;
    await t.outbox.transaction(async (_m, emit) => emit('CourseSubmitted', { course_id: 'c1' }));
    t.bus.connected = true;
    await t.outbox.transaction(async (_m, emit) => emit('CourseReviewWithdrawn', { course_id: 'c1' }));
    await tick();
    await tick();
    expect(t.bus.publishConfirmed).not.toHaveBeenCalled();

    await t.outbox.relay();
    expect(t.sent.map((s) => s.type)).toEqual(['CourseSubmitted', 'CourseReviewWithdrawn']);
  });

  it('a relay tick during the fast path confirm wait leaves the row to it, so the row is sent once (9b review S1)', async () => {
    const t = setup();
    let release: () => void = () => undefined;
    t.bus.publishConfirmed.mockImplementationOnce(async (type: string, payload: unknown, opts: { eventId: string }) => {
      await new Promise<void>((r) => (release = r));
      t.sent.push({ type, payload, eventId: opts.eventId });
    });
    await t.outbox.transaction(async (_m, emit) => {
      emit('CourseRated', { course_id: 'c1' });
      emit('CourseRated', { course_id: 'c2' });
    });
    await until(() => t.bus.publishConfirmed.mock.calls.length === 1, 'the fast path to publish');

    await t.outbox.relay(); // the first row is in flight: the relay sends nothing
    expect(t.bus.publishConfirmed).toHaveBeenCalledTimes(1);
    release();
    await until(() => t.rows().every((r) => r.published_at !== null), 'both rows published');
    await t.outbox.relay();

    expect(t.sent.map((s) => (s.payload as { course_id: string }).course_id)).toEqual(['c1', 'c2']);
  });

  it('refuses to run inside runOnce or another outbox transaction', async () => {
    const t = setup();
    const nested = () => t.outbox.transaction(async (_m, emit) => emit('TrustTierChanged', { educator_id: 'e1' }));

    await expect(runOnce(t.dataSource, 'quality:test', 'evt-1', nested)).rejects.toThrow(/inside another transaction/);
    await expect(t.outbox.transaction(nested)).rejects.toThrow(/inside another transaction/);
    expect(t.rows()).toEqual([]);
  });
});

describe('OutboxService.relay', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Rows committed while the broker was down, so only the relay sends them. */
  async function queued(t: ReturnType<typeof setup>, types: string[]) {
    t.bus.connected = false;
    for (const type of types) await t.outbox.transaction(async (_m, emit) => emit(type as never, { type }));
    t.bus.connected = true;
  }

  it('stops the batch at the first failure, so nothing overtakes the failed row', async () => {
    const t = setup();
    await queued(t, ['CourseSubmitted', 'CourseReviewWithdrawn', 'CourseAppealSubmitted']);
    t.bus.publishConfirmed.mockImplementation(async (type: string, payload: unknown, opts: { eventId: string }) => {
      if (type === 'CourseReviewWithdrawn') throw new Error('nacked');
      t.sent.push({ type, payload, eventId: opts.eventId });
    });

    await t.outbox.relay();
    expect(t.sent.map((s) => s.type)).toEqual(['CourseSubmitted']);
    expect(t.rows().map((r) => [r.event_type, r.published_at !== null, r.attempts])).toEqual([
      ['CourseSubmitted', true, 0],
      ['CourseReviewWithdrawn', false, 1],
      ['CourseAppealSubmitted', false, 0],
    ]);
  });

  it('logs at error when a row has failed 20 times', async () => {
    const t = setup();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await queued(t, ['CourseSubmitted']);
    t.bus.publishConfirmed.mockRejectedValue(new Error('PRECONDITION_FAILED'));

    for (let i = 0; i < 20; i += 1) await t.outbox.relay();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain(`outbox row ${t.rows()[0].id} (CourseSubmitted) failed 20 times`);
  });

  it('warns about rows still unpublished after 10 minutes', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const t = setup();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    t.bus.connected = false;
    await t.outbox.transaction(async (_m, emit) => emit('CourseRated', { course_id: 'c1' }));
    t.rows()[0].created_at = Date.now() - 11 * 60_000;

    await t.outbox.relay();
    expect(warn).toHaveBeenCalledWith('outbox relay: 1 event(s) older than 10 min still unpublished');
  });

  it('deletes published rows older than the retention, and nothing else', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const t = setup();
    await t.outbox.transaction(async (_m, emit) => emit('CourseRated', { course_id: 'old' }));
    await until(() => t.rows()[0].published_at !== null, 'the old row published');
    jest.setSystemTime(Date.now() + 8 * 86_400_000);
    await t.outbox.transaction(async (_m, emit) => emit('CourseRated', { course_id: 'new' }));
    await until(() => t.rows()[1].published_at !== null, 'the new row published');
    t.bus.connected = false;
    await t.outbox.transaction(async (_m, emit) => emit('CourseRated', { course_id: 'unpublished' }));
    t.rows()[2].created_at = 0; // older than everything, but never published: kept

    await t.outbox.relay();
    expect(t.rows().map((r) => (r.payload as { course_id: string }).course_id)).toEqual(['new', 'unpublished']);
  });
});
