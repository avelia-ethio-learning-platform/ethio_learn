import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { buildTypeOrmOptions } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { CommunityService } from './community.service';
import { entities, migrations, SCHEMA } from './database';
import { CourseComment, DmMessage, DmThread, InboxNotification } from './entities';

/**
 * Phase 9e bounded lists on Postgres: a conversation pages by its own
 * (created_at, id), so a tie at the page edge is neither lost nor repeated;
 * comments take the newest 50 discussions and every reply below them at any
 * depth (WITH RECURSIVE), and nothing outside the page.
 *
 * Opt-in: runs only when TEST_DATABASE_URL names a scratch database (the CI
 * e2e job creates one). It runs the notification migrations there and
 * deletes only the rows it created.
 */
const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

describeWithDb('CommunityService bounded lists on Postgres (TEST_DATABASE_URL)', () => {
  let dataSource: DataSource;
  let comments: Repository<CourseComment>;
  let threads: Repository<DmThread>;
  let messages: Repository<DmMessage>;
  let service: CommunityService;
  const me = randomUUID();
  const courseId = randomUUID();
  let threadId = '';
  const t0 = Date.UTC(2026, 0, 1);

  beforeAll(async () => {
    dataSource = new DataSource({ ...buildTypeOrmOptions(SCHEMA, entities, migrations), url, migrationsRun: false, logging: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await dataSource.runMigrations({ transaction: 'each' });
    comments = dataSource.getRepository(CourseComment);
    threads = dataSource.getRepository(DmThread);
    messages = dataSource.getRepository(DmMessage);
    service = new CommunityService(comments, threads, messages, dataSource.getRepository(InboxNotification), {} as never);

    // 150 messages a second apart, oldest first; m50 and m51 share one timestamp at the page edge.
    const thread = await threads.save(threads.create({ a_id: me, b_id: randomUUID() }));
    threadId = thread.id;
    await dataSource.query(
      `INSERT INTO ${messages.metadata.tablePath} (thread_id, sender_id, body, created_at)
       SELECT $1, $2, 'm' || g, $3::timestamptz + make_interval(secs => CASE WHEN g = 51 THEN 50 ELSE g END) FROM generate_series(1, 150) g`,
      [threadId, me, new Date(t0).toISOString()],
    );

    // 60 discussions; the newest one has a reply, a reply to it and a reply to that; the oldest has a reply.
    const insert = async (body: string, at: number, parent: string | null = null) => {
      const row = await comments.save(comments.create({ course_id: courseId, parent_id: parent, author_id: me, author_name: 'Me', author_role: Role.LEARNER, body }));
      await comments.update({ id: row.id }, { created_at: new Date(t0 + at * 1000) });
      return row.id;
    };
    const tops: string[] = [];
    for (let i = 1; i <= 60; i++) tops.push(await insert(`t${i}`, i * 10));
    const r1 = await insert('reply to t60', 1000, tops[59]);
    const r2 = await insert('reply to reply', 1001, r1);
    await insert('third level', 1002, r2);
    await insert('reply to t1', 1003, tops[0]);
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await messages.delete({ thread_id: threadId });
    await threads.delete({ id: threadId });
    await comments.delete({ course_id: courseId });
    await dataSource.destroy();
  });

  it('a thread opens on its newest 100 in order; before pages back to the oldest 50; a tie at the edge appears once', async () => {
    const ctx = { id: me, role: Role.LEARNER } as never;
    const first = await service.threadMessages(ctx, threadId);
    expect(first.has_more).toBe(true);
    expect(first.thread.thread_id).toBe(threadId);
    expect(first.messages).toHaveLength(100);
    expect(first.messages[99].body).toBe('m150');
    expect(first.messages.map((m) => m.body)).toContain('m52');
    // m50 and m51 tie at the edge: exactly one of them is on this page.
    expect(first.messages.filter((m) => m.body === 'm50' || m.body === 'm51')).toHaveLength(1);

    const older = await service.threadMessages(ctx, threadId, first.messages[0].id);
    expect(older.has_more).toBe(false);
    expect(older.messages).toHaveLength(50);
    const all = [...older.messages, ...first.messages].map((m) => m.body);
    expect(new Set(all).size).toBe(150);
    expect(all).toEqual(expect.arrayContaining(['m1', 'm50', 'm51', 'm150']));
  });

  it('comments: the newest 50 discussions with every reply below them, and nothing outside the page', async () => {
    const page = await service.listComments(courseId);
    expect(page.has_more).toBe(true);
    const bodies = page.items.map((c) => c.body);
    expect(bodies.filter((b) => /^t\d+$/.test(b))).toHaveLength(50);
    expect(bodies).toEqual(expect.arrayContaining(['t60', 't11', 'reply to t60', 'reply to reply', 'third level']));
    expect(bodies).not.toContain('t10');
    expect(bodies).not.toContain('reply to t1');
    // Flat and oldest first, as before.
    const times = page.items.map((c) => new Date(c.created_at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    const oldestTop = page.items.find((c) => c.body === 't11')!;
    const older = await service.listComments(courseId, oldestTop.id);
    expect(older.has_more).toBe(false);
    expect(older.items.map((c) => c.body)).toEqual([...Array.from({ length: 10 }, (_, i) => `t${i + 1}`), 'reply to t1']);
  });
});
