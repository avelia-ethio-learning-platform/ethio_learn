import { Logger } from '@nestjs/common';
import type { MigrationInterface } from 'typeorm';
import { buildSchemaCheckOptions } from './schema-check';
import { buildTypeOrmOptions } from './typeorm';

class Baseline1700000000000 implements MigrationInterface {
  async up(): Promise<void> {}
  async down(): Promise<void> {}
}
class Entity {}

const ENV_KEYS = ['DB_SYNC', 'DB_LOGGING'] as const;

describe('buildTypeOrmOptions', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let warn: jest.SpyInstance;
  beforeEach(() => {
    ENV_KEYS.forEach((k) => delete process.env[k]);
    warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
    warn.mockRestore();
  });

  it('runs the given migrations on boot, one transaction each, with synchronize off', () => {
    const opts = buildTypeOrmOptions('auth', [Entity], [Baseline1700000000000]);
    expect(opts).toMatchObject({
      schema: 'auth',
      entities: [Entity],
      migrations: [Baseline1700000000000],
      synchronize: false,
      migrationsRun: true,
      migrationsTransactionMode: 'each',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores DB_SYNC=true, keeps synchronize off and warns once', () => {
    process.env.DB_SYNC = 'true';
    expect(buildTypeOrmOptions('auth', [Entity], []).synchronize).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DB_SYNC is ignored'), 'TypeORM');
  });

  it("logs only 'schema' (migration progress, no failing-query parameters) unless DB_LOGGING is on", () => {
    expect(buildTypeOrmOptions('auth', [Entity], []).logging).toEqual(['schema']);
    process.env.DB_LOGGING = 'true';
    expect(buildTypeOrmOptions('auth', [Entity], []).logging).toBe(true);
  });
});

describe('buildSchemaCheckOptions', () => {
  it('never writes: no migrations run, no synchronize, no extension install', () => {
    const opts = buildSchemaCheckOptions('financial', [Entity], [Baseline1700000000000]);
    expect(opts).toMatchObject({
      schema: 'financial',
      entities: [Entity],
      migrationsRun: false,
      synchronize: false,
      installExtensions: false,
    });
  });
});
