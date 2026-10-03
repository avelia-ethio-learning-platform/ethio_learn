import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from '@ethiopialearn/common';
import { Role, UserStatus } from '@ethiopialearn/contracts';
import { AuthService } from './auth.service';
import { entities, migrations, SCHEMA } from './database';
import { EmailVerification, InstitutionInstructor, PasswordReset, User } from './entities';

/**
 * The resend caps under a burst, against a real Postgres (round-1 B1): five
 * parallel resends for one unverified account must produce one link and one
 * event. Without the row lock every request reads "none in the last minute"
 * and each one sends an email.
 *
 * Opt-in: runs only when TEST_DATABASE_URL names a scratch database (the CI
 * e2e job creates one), so `pnpm -C api test` stays database-free. It runs the
 * auth migrations there and deletes only the rows it created. It calls the
 * service directly, never through the gateway, whose auth-strict budget the
 * other e2e steps share.
 */
const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

describeWithDb('AuthService.resendVerification on Postgres (TEST_DATABASE_URL)', () => {
  let dataSource: DataSource;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    dataSource = new DataSource({ ...buildTypeOrmOptions(SCHEMA, entities, migrations), url, migrationsRun: false, logging: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await dataSource.runMigrations({ transaction: 'each' });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    if (createdUserIds.length) {
      await dataSource.getRepository(EmailVerification).delete(createdUserIds.map((user_id) => ({ user_id })));
      await dataSource.getRepository(User).delete(createdUserIds);
    }
    await dataSource.destroy();
  });

  it('5 parallel resends for one unverified account create exactly 1 row and publish exactly 1 event', async () => {
    const users = dataSource.getRepository(User);
    const verifications = dataSource.getRepository(EmailVerification);
    const user = await users.save(
      users.create({
        email: `resend-burst-${randomUUID()}@test.invalid`,
        name: 'Burst Test',
        role: Role.LEARNER,
        password_hash: null,
        email_verified_at: null,
        status: UserStatus.ACTIVE,
        phone: null,
      }),
    );
    createdUserIds.push(user.id);
    expect(await verifications.count({ where: { user_id: user.id } })).toBe(0);

    const bus = { publish: jest.fn().mockResolvedValue(undefined) };
    const svc = new AuthService(
      users,
      verifications,
      dataSource.getRepository(PasswordReset),
      dataSource.getRepository(InstitutionInstructor),
      bus as never,
      dataSource,
      {} as never, // the outbox: resend publishes on the bus
    );
    (svc as unknown as { redis: { disconnect(): void } }).redis.disconnect();

    // Open the connections first. The pool opens them lazily, and the time that
    // takes would stagger the five transactions into a queue, hiding the race.
    await Promise.all(Array.from({ length: 10 }, () => dataSource.query('SELECT pg_sleep(0.05)')));

    const answers = await Promise.all(Array.from({ length: 5 }, () => svc.resendVerification(user.email)));

    expect(new Set(answers.map((a) => a.message)).size).toBe(1);
    const rows = await verifications.find({ where: { user_id: user.id } });
    expect(rows).toHaveLength(1);
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish).toHaveBeenCalledWith(
      'VerificationEmailRequested',
      expect.objectContaining({ user_id: user.id, verification_url: expect.stringMatching(new RegExp(`/verify-email\\?token=${rows[0].token}$`)) }),
    );
  });
});
