import { currentContext, requestContext } from '../context';
import { JobRunner, startJob } from './job-lease';
import { createJobsController } from './jobs.controller';

/** A data source whose lease upsert wins while `free` is true (the SQL itself is covered by job-lease.db.spec.ts). */
function stubDataSource() {
  const state = { free: true, released: [] as unknown[][] };
  const dataSource = {
    getRepository: () => ({ metadata: { tablePath: 'svc.job_leases' } }),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('INSERT')) {
        if (!state.free) return [];
        state.free = false;
        return [{ name: params[0] }];
      }
      if (sql.startsWith('UPDATE')) {
        state.released.push(params);
        state.free = true;
        return [[], 1];
      }
      return [];
    }),
  };
  return { dataSource, state };
}

describe('startJob', () => {
  it('starts the job without awaiting it, and records its counts when it finishes', async () => {
    const { dataSource, state } = stubDataSource();
    let finish!: (v: { checked: number }) => void;
    const start = await startJob(dataSource as never, 'sweep', 60_000, () => new Promise((r) => (finish = r)));
    expect(start.started).toBe(true);
    expect(state.released).toHaveLength(0);
    finish({ checked: 3 });
    expect(await (start as { finished: Promise<unknown> }).finished).toEqual({ checked: 3 });
    expect(state.released[0]).toEqual(['sweep', expect.any(String), JSON.stringify({ checked: 3 })]);
  });

  it('a failed run is recorded as { failed: true }, with no message (no personal data)', async () => {
    const { dataSource, state } = stubDataSource();
    const start = await startJob(dataSource as never, 'sweep', 60_000, async () => {
      throw new Error('user someone@x.et broke it');
    });
    expect(await (start as { finished: Promise<unknown> }).finished).toEqual({ failed: true });
    expect(state.released[0][2]).toBe(JSON.stringify({ failed: true }));
  });

  it('runs the job under its own request id, not the one that started it', async () => {
    const { dataSource } = stubDataSource();
    let seen: unknown = 'unset';
    const start = await requestContext.run({ request_id: 'r-1', user_id: 'u-1' }, () =>
      startJob(dataSource as never, 'sweep', 60_000, async () => {
        seen = currentContext();
      }),
    );
    await (start as { finished: Promise<unknown> }).finished;
    expect(seen).toEqual({ request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('does not start while another run holds the lease', async () => {
    const { dataSource, state } = stubDataSource();
    state.free = false;
    const fn = jest.fn();
    expect(await startJob(dataSource as never, 'sweep', 60_000, fn)).toEqual({ started: false });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('JobRunner and the jobs endpoint', () => {
  const setup = () => {
    const { dataSource, state } = stubDataSource();
    let finish!: () => void;
    const run = jest.fn(() => new Promise<{ sent: number }>((r) => (finish = () => r({ sent: 1 }))));
    const runner = new JobRunner(dataSource as never, { nudges: { ttlMs: 60_000, run } }, 'Test');
    const Controller = createJobsController('test') as new (runner: JobRunner) => {
      start(job: string): Promise<unknown>;
      status(): Promise<unknown>;
    };
    return { controller: new Controller(runner), runner, run, state, finish: () => finish() };
  };

  it('answers before the job finishes, and a second start while it runs reports running', async () => {
    const t = setup();
    expect(await t.controller.start('nudges')).toEqual({ job: 'nudges', started: true });
    expect(t.state.released).toHaveLength(0);
    expect(await t.controller.start('nudges')).toEqual({ job: 'nudges', started: false, reason: 'running' });
    expect(t.run).toHaveBeenCalledTimes(1);
    t.finish();
  });

  it('refuses unknown job names, including inherited properties', async () => {
    const t = setup();
    expect(t.runner.has('toString')).toBe(false);
    await expect(t.controller.start('toString')).rejects.toThrow('Unknown job');
    await expect(t.controller.start('sweep')).rejects.toThrow('Unknown job');
  });

  it('run() (the crons) never throws, even when the lease query fails', async () => {
    const t = setup();
    (t.runner as unknown as { dataSource: { query: jest.Mock } }).dataSource.query.mockRejectedValueOnce(new Error('db down'));
    await expect(t.runner.run('nudges')).resolves.toBeNull();
  });
});
