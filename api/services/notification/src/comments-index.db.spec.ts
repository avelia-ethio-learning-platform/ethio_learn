import { randomUUID } from 'crypto';
import { DataSource, In } from 'typeorm';
import { buildTypeOrmOptions } from '@ethiopialearn/common';
import { entities, migrations, SCHEMA } from './database';
import { CourseComment } from './entities';
import { CommentsCourseCreatedIndex1792400000000 } from './migrations/1792400000000-CommentsCourseCreatedIndex';

/**
 * The (course_id, created_at) index on course_comments, against a real Postgres:
 * a course page's newest-50 read uses it, and down() restores the old index.
 *
 * Opt-in: runs only when TEST_DATABASE_URL names a scratch database (the CI e2e
 * job creates one), so `pnpm -C api test` stays database-free. It runs the
 * notification migrations there and deletes only the rows it created.
 */
const url = process.env.TEST_DATABASE_URL;
const describeWithDb = url ? describe : describe.skip;

const NEW_INDEX = 'IDX_course_comments_course_id_created_at';
const OLD_INDEX = 'IDX_2fe6d118a6e60842d38b1e5fe1';

describeWithDb('course_comments (course_id, created_at) index on Postgres (TEST_DATABASE_URL)', () => {
  let dataSource: DataSource;
  const courses = Array.from({ length: 40 }, () => randomUUID());

  beforeAll(async () => {
    dataSource = new DataSource({ ...buildTypeOrmOptions(SCHEMA, entities, migrations), url, migrationsRun: false, logging: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await dataSource.runMigrations({ transaction: 'each' });
    // 40 courses x 100 top-level comments, an hour apart, so one course is a small slice of the table.
    await dataSource.query(
      `INSERT INTO "${SCHEMA}"."course_comments" (course_id, author_id, author_name, body, created_at)
       SELECT c, gen_random_uuid(), 'Test', 'hello', now() - n * interval '1 hour'
       FROM unnest($1::uuid[]) AS c, generate_series(1, 100) AS n`,
      [courses],
    );
    await dataSource.query(`ANALYZE "${SCHEMA}"."course_comments"`);
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.getRepository(CourseComment).delete({ course_id: In(courses) });
    await dataSource.destroy();
  });

  const indexes = async () =>
    ((await dataSource.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'course_comments'`, [SCHEMA])) as { indexname: string }[]).map(
      (r) => r.indexname,
    );

  it("a course's newest-50 read uses the index", async () => {
    const plan = (await dataSource.query(
      `EXPLAIN SELECT * FROM "${SCHEMA}"."course_comments" c
       WHERE c.course_id = $1 AND c.parent_id IS NULL
       ORDER BY c.created_at DESC, c.id DESC LIMIT 51`,
      [courses[0]],
    )) as { 'QUERY PLAN': string }[];
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toContain(NEW_INDEX);
    expect(text).not.toMatch(/Seq Scan/);
  });

  it('replaces the single-column index, and down() puts it back', async () => {
    expect(await indexes()).toEqual(expect.arrayContaining([NEW_INDEX]));
    expect(await indexes()).not.toContain(OLD_INDEX);
    const migration = new CommentsCourseCreatedIndex1792400000000();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      expect(await indexes()).toContain(OLD_INDEX);
      expect(await indexes()).not.toContain(NEW_INDEX);
      await migration.up(runner);
      await migration.up(runner); // safe to repeat
    } finally {
      await runner.release();
    }
    expect(await indexes()).toContain(NEW_INDEX);
    expect(await indexes()).not.toContain(OLD_INDEX);
  });
});
