import { randomUUID } from 'crypto';
import { DataSource, In } from 'typeorm';
import { buildTypeOrmOptions } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { NotificationController } from './controllers';
import { entities, migrations, SCHEMA } from './database';
import { InboxNotification, InboxNotificationRead } from './entities';

/**
 * Per-person reads of role rows (Phase 13a, gap 3), against a real Postgres: a
 * quality-officer row one officer reads stays unread for the other.
 *
 * Opt-in: runs only when TEST_DATABASE_URL names a scratch database (the CI e2e
 * job creates one), so `pnpm -C api test` stays database-free. It runs the
 * notification migrations there and deletes only the rows it created.
 */
const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

describeWithDb('Inbox reads on Postgres (TEST_DATABASE_URL)', () => {
  let dataSource: DataSource;
  let ctrl: NotificationController;
  const created: string[] = [];
  // A role no seeded row targets, so other rows in the database can't change the counts.
  const role = `qo-test-${randomUUID()}`;
  const officerA = { id: randomUUID(), role } as never;
  const officerB = { id: randomUUID(), role } as never;
  const learner = { id: randomUUID(), role: Role.LEARNER } as never;

  beforeAll(async () => {
    dataSource = new DataSource({ ...buildTypeOrmOptions(SCHEMA, entities, migrations), url, migrationsRun: false, logging: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await dataSource.runMigrations({ transaction: 'each' });
    const inbox = dataSource.getRepository(InboxNotification);
    ctrl = new NotificationController({} as never, {} as never, inbox, dataSource.getRepository(InboxNotificationRead), {} as never);
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    // The reads go with their rows (ON DELETE CASCADE).
    if (created.length) await dataSource.getRepository(InboxNotification).delete({ id: In(created) });
    await dataSource.destroy();
  });

  async function addRow(fields: Partial<InboxNotification>) {
    const inbox = dataSource.getRepository(InboxNotification);
    const row = await inbox.save(inbox.create({ user_id: null, target_role: null, type: 'test', title: 'Test', body: '', link: null, read_at: null, ...fields }));
    created.push(row.id);
    return row;
  }

  const count = async (who: never) => (await ctrl.unreadCount(who)).count;
  const readFlag = async (who: never, id: string) => (await ctrl.list(who)).find((n) => n.id === id)?.read;

  it('a role row read by one officer stays unread for the other, and repeating the read is a no-op', async () => {
    const row = await addRow({ target_role: role });
    expect(await count(officerA)).toBe(1);
    expect(await count(officerB)).toBe(1);

    await ctrl.markRead(officerA, row.id);
    await ctrl.markRead(officerA, row.id); // ON CONFLICT DO NOTHING

    expect(await count(officerA)).toBe(0);
    expect(await count(officerB)).toBe(1);
    expect(await readFlag(officerA, row.id)).toBe(true);
    expect(await readFlag(officerB, row.id)).toBe(false);
    expect(await dataSource.getRepository(InboxNotificationRead).count({ where: { notification_id: row.id } })).toBe(1);
    // The shared row itself is untouched.
    expect((await dataSource.getRepository(InboxNotification).findOneByOrFail({ id: row.id })).read_at).toBeNull();
  });

  it('read-all by one officer leaves the other officer’s count', async () => {
    await addRow({ target_role: role });
    await addRow({ target_role: role });
    // Officer A read the first test's row; B has read none.
    expect(await count(officerA)).toBe(2);
    expect(await count(officerB)).toBe(3);

    await ctrl.markAllRead(officerA);

    expect(await count(officerA)).toBe(0);
    expect(await count(officerB)).toBe(3);
  });

  it('a user row still sets read_at, and only for its own user', async () => {
    const mine = await addRow({ user_id: (learner as { id: string }).id });
    await ctrl.markRead(officerA, mine.id); // someone else's row: no effect
    expect((await dataSource.getRepository(InboxNotification).findOneByOrFail({ id: mine.id })).read_at).toBeNull();

    expect(await count(learner)).toBeGreaterThanOrEqual(1);
    await ctrl.markRead(learner, mine.id);
    expect((await dataSource.getRepository(InboxNotification).findOneByOrFail({ id: mine.id })).read_at).not.toBeNull();
    expect(await readFlag(learner, mine.id)).toBe(true);
    expect(await dataSource.getRepository(InboxNotificationRead).count({ where: { notification_id: mine.id } })).toBe(0);
  });
});
