import { Logger } from '@nestjs/common';
import { SafeTypeOrmLogger } from './safe-typeorm-logger';

const email = 'abebe@example.com';

function spies() {
  return {
    log: jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  };
}

function pgError(code: string, message: string, constraint?: string): Error {
  return Object.assign(new Error(message), { code, constraint });
}

describe('SafeTypeOrmLogger', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs a slow query as its duration and SQL, never its parameters', () => {
    const { warn } = spies();
    new SafeTypeOrmLogger('auth', ['schema']).logQuerySlow(612, 'SELECT *\n  FROM auth.users WHERE email = $1', [email]);
    expect(warn).toHaveBeenCalledWith('slow query 612 ms: SELECT * FROM auth.users WHERE email = $1');
  });

  it('cuts the SQL at 1,000 characters', () => {
    const { warn } = spies();
    new SafeTypeOrmLogger('auth', ['schema']).logQuerySlow(600, `SELECT ${'x'.repeat(2000)}`, []);
    expect(String(warn.mock.calls[0][0])).toHaveLength('slow query 600 ms: '.length + 1000 + 1);
  });

  it("logs no query error under ['schema'], expected unique violations included", () => {
    const { error, log } = spies();
    const logger = new SafeTypeOrmLogger('auth', ['schema']);
    logger.logQueryError(pgError('23505', `Key (email)=(${email}) already exists.`, 'UQ_users_email'), 'INSERT …', [email]);
    logger.logQuery('SELECT 1', []);
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('with DB_LOGGING (logging: true) logs the SQLSTATE code, the constraint and the SQL, never the message', () => {
    const { error, log } = spies();
    const logger = new SafeTypeOrmLogger('auth', true);
    logger.logQueryError(pgError('22P02', `invalid input syntax for type uuid: "${email}"`), 'SELECT $1::uuid', [email]);
    logger.logQueryError(pgError('23505', `Key (email)=(${email}) already exists.`, 'UQ_users_email'), 'INSERT INTO auth.users …', [email]);
    logger.logQuery('SELECT id FROM auth.users WHERE email = $1', [email]);

    expect(error.mock.calls.map((c) => c[0])).toEqual([
      'query failed (22P02): SELECT $1::uuid',
      'query failed (23505, constraint UQ_users_email): INSERT INTO auth.users …',
    ]);
    expect(log).toHaveBeenCalledWith('SELECT id FROM auth.users WHERE email = $1');
    expect(JSON.stringify([...error.mock.calls, ...log.mock.calls])).not.toContain('abebe');
  });

  it('logs migrations, and schema-build messages only under schema, as TypeORM does', () => {
    const { log } = spies();
    new SafeTypeOrmLogger('auth', ['schema']).logSchemaBuild('No migrations are pending');
    new SafeTypeOrmLogger('auth', false).logSchemaBuild('hidden');
    new SafeTypeOrmLogger('auth', false).logMigration('Migration Baseline has been executed successfully.');
    expect(log.mock.calls.map((c) => c[0])).toEqual(['No migrations are pending', 'Migration Baseline has been executed successfully.']);
  });
});
