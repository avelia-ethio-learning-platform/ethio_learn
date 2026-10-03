import { QueryRunner } from 'typeorm';
import { EmailVerificationCreatedAt1791018655934 } from './1791018655934-EmailVerificationCreatedAt';
import { EmailVerificationCreatedAtIndex1791018655935 } from './1791018655935-EmailVerificationCreatedAtIndex';
import { migrations } from './index';

function recorder() {
  const sql: string[] = [];
  const queryRunner = { query: jest.fn(async (statement: string) => void sql.push(statement)) } as unknown as QueryRunner;
  return { sql, queryRunner };
}

const INDEX = '"auth"."IDX_email_verifications_user_id_created_at"';

describe('email_verifications.created_at migrations', () => {
  it('adds created_at as NOT NULL with a now() default in one statement, so old rows need no backfill', async () => {
    const { sql, queryRunner } = recorder();
    await new EmailVerificationCreatedAt1791018655934().up(queryRunner);
    expect(sql).toEqual([
      'ALTER TABLE "auth"."email_verifications" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()',
    ]);
  });

  it('builds the (user_id, created_at) index concurrently, outside a transaction, one statement per query', async () => {
    const migration = new EmailVerificationCreatedAtIndex1791018655935();
    expect(migration.transaction).toBe(false);

    const up = recorder();
    await migration.up(up.queryRunner);
    expect(up.sql).toEqual([
      `DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`,
      `CREATE INDEX CONCURRENTLY "IDX_email_verifications_user_id_created_at" ON "auth"."email_verifications" ("user_id", "created_at")`,
    ]);

    const down = recorder();
    await migration.down(down.queryRunner);
    expect(down.sql).toEqual([`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`]);
  });

  it("runs after Phase 6a's invite migrations", () => {
    const names = migrations.map((m) => m.name);
    const from = names.indexOf('InvitedAt1790964028397');
    expect(names.slice(from, from + 4)).toEqual([
      'InvitedAt1790964028397',
      'InvitedAtIndex1790964028398',
      'EmailVerificationCreatedAt1791018655934',
      'EmailVerificationCreatedAtIndex1791018655935',
    ]);
  });
});
