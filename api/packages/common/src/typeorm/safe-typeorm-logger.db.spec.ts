import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SafeTypeOrmLogger } from './safe-typeorm-logger';
import { buildTypeOrmOptions } from './typeorm';

/**
 * SafeTypeOrmLogger behind a real data source: TypeORM calls it for slow queries
 * and query errors with the parameters, and Postgres quotes the input in its
 * messages. Opt-in: runs only when TEST_DATABASE_URL names a scratch database
 * (the CI e2e job creates one). It creates nothing that outlives its connection.
 */
const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;
const email = 'abebe@example.com';

describeWithDb('SafeTypeOrmLogger on Postgres (TEST_DATABASE_URL)', () => {
  const sources: DataSource[] = [];
  let lines: string[];

  async function connect(logging: true | ['schema']): Promise<DataSource> {
    const dataSource = new DataSource({
      ...buildTypeOrmOptions('public', [], []),
      url,
      migrationsRun: false,
      logging,
      logger: new SafeTypeOrmLogger('public', logging),
      maxQueryExecutionTime: 500,
    });
    await dataSource.initialize();
    sources.push(dataSource);
    return dataSource;
  }

  beforeEach(() => {
    lines = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(((msg: unknown) => void lines.push(String(msg))) as never);
    }
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all(sources.map((s) => s.destroy()));
  });

  it('logs a slow query with its SQL and without the parameter value', async () => {
    const db = await connect(['schema']);
    await db.query('SELECT pg_sleep(0.6), $1::text AS who', [email]);
    expect(lines).toEqual([expect.stringMatching(/^slow query \d+ ms: SELECT pg_sleep\(0\.6\), \$1::text AS who$/)]);
  });

  it("logs nothing for a 22P02 or a 23505 under ['schema']", async () => {
    const db = await connect(['schema']);
    const runner = db.createQueryRunner();
    try {
      await expect(runner.query('SELECT $1::uuid', [email])).rejects.toMatchObject({ driverError: { code: '22P02' } });
      await runner.query('CREATE TEMP TABLE safe_logger_probe (e text CONSTRAINT safe_logger_probe_e_key UNIQUE)');
      await runner.query('INSERT INTO safe_logger_probe VALUES ($1)', [email]);
      await expect(runner.query('INSERT INTO safe_logger_probe VALUES ($1)', [email])).rejects.toMatchObject({ driverError: { code: '23505' } });
    } finally {
      await runner.release();
    }
    expect(lines).toEqual([]);
  });

  it('with DB_LOGGING logs the code, the constraint and the SQL, never the value', async () => {
    const db = await connect(true);
    const runner = db.createQueryRunner();
    try {
      await runner.query('SELECT $1::uuid', [email]).catch(() => undefined);
      await runner.query('CREATE TEMP TABLE safe_logger_probe (e text CONSTRAINT safe_logger_probe_e_key UNIQUE)');
      await runner.query('INSERT INTO safe_logger_probe VALUES ($1)', [email]);
      await runner.query('INSERT INTO safe_logger_probe VALUES ($1)', [email]).catch(() => undefined);
    } finally {
      await runner.release();
    }
    expect(lines).toContain('query failed (22P02): SELECT $1::uuid');
    expect(lines).toContain('query failed (23505, constraint safe_logger_probe_e_key): INSERT INTO safe_logger_probe VALUES ($1)');
    expect(lines.join('\n')).not.toContain('abebe');
  });
});
