import { DataSource } from 'typeorm';
import { EventBusService } from './events/event-bus.service';

export type CheckState = 'ok' | 'down';

export interface ReadyResult {
  statusCode: 200 | 503;
  body: { status: 'ready' | 'not_ready'; service: string; checks: Record<string, CheckState> };
}

export interface ReadinessDeps {
  serviceName: string;
  db: Pick<DataSource, 'query'>;
  bus: Pick<EventBusService, 'isConnected'>;
  /** The service's own dependencies (auth: Redis), each given 1 s. */
  extra?: Record<string, () => Promise<unknown>>;
}

const CACHE_MS = 5_000;
const DB_TIMEOUT_MS = 2_000;
const EXTRA_TIMEOUT_MS = 1_000;

/** 'ok' when `fn` settles within `ms`, 'down' when it throws, rejects or takes longer. */
async function probe(fn: () => Promise<unknown>, ms: number): Promise<CheckState> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CheckState>((resolve) => {
    timer = setTimeout(() => resolve('down'), ms);
  });
  try {
    // `.then(fn)` turns a synchronous throw into a rejection, so /ready always answers.
    const settled = Promise.resolve().then(fn).then((): CheckState => 'ok', (): CheckState => 'down');
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `/ready`: whether this instance can do its work (database, broker, and the
 * service's own extras). Unlike `/health`, which only says the process is up.
 * The body names the failing check and nothing else: no hosts, URLs or errors.
 *
 * `/ready` is public on each service's Render URL, outside the gateway's rate
 * limits, so it's computed at most once every 5 s, and callers during a check
 * share it: a request loop can't take the pool's connections.
 */
export class Readiness {
  private last?: { at: number; result: ReadyResult };
  private inFlight?: Promise<ReadyResult>;

  constructor(
    private readonly deps: ReadinessDeps,
    private readonly now: () => number = Date.now,
  ) {}

  check(): Promise<ReadyResult> {
    if (this.last && this.now() - this.last.at < CACHE_MS) return Promise.resolve(this.last.result);
    this.inFlight ??= this.run()
      .then((result) => {
        this.last = { at: this.now(), result };
        return result;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async run(): Promise<ReadyResult> {
    const extra = Object.entries(this.deps.extra ?? {});
    const [db, ...extraStates] = await Promise.all([
      probe(() => this.deps.db.query('SELECT 1'), DB_TIMEOUT_MS),
      ...extra.map(([, fn]) => probe(fn, EXTRA_TIMEOUT_MS)),
    ]);
    const checks: Record<string, CheckState> = { db, broker: this.deps.bus.isConnected() ? 'ok' : 'down' };
    extra.forEach(([name], i) => (checks[name] = extraStates[i]));
    const ready = Object.values(checks).every((state) => state === 'ok');
    return { statusCode: ready ? 200 : 503, body: { status: ready ? 'ready' : 'not_ready', service: this.deps.serviceName, checks } };
  }
}
