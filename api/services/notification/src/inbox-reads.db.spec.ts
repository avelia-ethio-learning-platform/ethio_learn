import { randomUUID } from 'crypto';
import { DataSource, In } from 'typeorm';
import { buildTypeOrmOptions } from '@ethiopialearn/common';
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
  // Fresh roles per test, which no other row targets, so each test runs alone.
  type Who = { id: string; role: string };
  const people = () => {
    const role = `qo-test-${randomUUID()}`;
    return {
      role,
      officerA: { id: randomUUID(), role } as Who,
      officerB: { id: randomUUID(), role } as Who,
      learner: { id: randomUUID(), role: `learner-test-${randomUUID()}` } as Who,
    };
  };

  beforeAll(async () => {
    dataSource = new DataSource({ ...buildTypeOrmOptions(SCHEMA, entities, migrations), url, migrationsRun: false, logging: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await dataSource.runMigrations({ transaction: 'each' });
    const inbox = dataSource.getRepository(InboxNotification);
    ctrl = new NotificationController({} as never, {} as never, inbox, dataSource.getRepository(InboxNotificationRead), {} as never, {} as never);
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

  const count = async (who: Who) => (await ctrl.unreadCount(who as never)).count;
  const readFlag = async (who: Who, id: string) => (await ctrl.list(who as never)).find((n) => n.id === id)?.read;
  const readsOf = (id: string) => dataSource.getRepository(InboxNotificationRead).count({ where: { notification_id: id } });
  const readAtOf = async (id: string) => (await dataSource.getRepository(InboxNotification).findOneByOrFail({ id })).read_at;

  it('a role row read by one officer stays unread for the other, and repeating the read is a no-op', async () => {
    const { role, officerA, officerB } = people();
    const row = await addRow({ target_role: role });
    expect(await count(officerA)).toBe(1);
    expect(await count(officerB)).toBe(1);

    await ctrl.markRead(officerA as never, row.id);
    await ctrl.markRead(officerA as never, row.id); // ON CONFLICT DO NOTHING

    expect(await count(officerA)).toBe(0);
    expect(await count(officerB)).toBe(1);
    expect(await readFlag(officerA, row.id)).toBe(true);
    expect(await readFlag(officerB, row.id)).toBe(false);
    expect(await readsOf(row.id)).toBe(1);
    // The shared row itself is untouched.
    expect(await readAtOf(row.id)).toBeNull();
  });

  it('read-all by one officer leaves the other officer’s count', async () => {
    const { role, officerA, officerB } = people();
    await addRow({ target_role: role });
    await addRow({ target_role: role });
    expect(await count(officerA)).toBe(2);
    expect(await count(officerB)).toBe(2);

    await ctrl.markAllRead(officerA as never);

    expect(await count(officerA)).toBe(0);
    expect(await count(officerB)).toBe(2);
  });

  it("someone outside the role can't mark its row read, by id or by read-all", async () => {
    const { role, officerA, learner } = people();
    const row = await addRow({ target_role: role });

    await ctrl.markRead(learner as never, row.id);
    await ctrl.markAllRead(learner as never);

    expect(await readsOf(row.id)).toBe(0);
    expect(await readAtOf(row.id)).toBeNull();
    expect(await count(officerA)).toBe(1);
  });

  it('a role row marked read before the migration (read_at set) stays read for everyone', async () => {
    const { role, officerB } = people();
    const row = await addRow({ target_role: role, read_at: new Date() });
    expect(await readFlag(officerB, row.id)).toBe(true);
    expect(await count(officerB)).toBe(0);
  });

  it('a user row still sets read_at, and only for its own user', async () => {
    const { officerA, learner } = people();
    const mine = await addRow({ user_id: learner.id });
    await ctrl.markRead(officerA as never, mine.id); // someone else's row: no effect
    expect(await readAtOf(mine.id)).toBeNull();

    expect(await count(learner)).toBe(1);
    await ctrl.markRead(learner as never, mine.id);
    expect(await readAtOf(mine.id)).not.toBeNull();
    expect(await readFlag(learner, mine.id)).toBe(true);
    expect(await count(learner)).toBe(0);
    expect(await readsOf(mine.id)).toBe(0);
  });
});
