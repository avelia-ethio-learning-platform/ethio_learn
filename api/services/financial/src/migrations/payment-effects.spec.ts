import { QueryRunner } from 'typeorm';
import { PaymentEffects1790966512486 } from './1790966512486-PaymentEffects';

/** Records every statement; answers the to_regclass probe as told. */
function runner(enrollmentTableExists: boolean) {
  const sql: string[] = [];
  const query = jest.fn(async (statement: string) => {
    sql.push(statement);
    if (statement.includes('to_regclass')) return [{ exists: enrollmentTableExists }];
    return [];
  });
  return { sql, queryRunner: { query } as unknown as QueryRunner };
}

describe('PaymentEffects migration', () => {
  it('on a fresh database (no enrollment table yet) marks every settled payment without reading enrollment', async () => {
    const { sql, queryRunner } = runner(false);
    await new PaymentEffects1790966512486().up(queryRunner);

    const backfill = sql.filter((s) => s.startsWith('UPDATE'));
    expect(backfill).toHaveLength(1);
    expect(backfill[0]).toContain(`status IN ('confirmed', 'refunded')`);
    expect(sql.some((s) => s.includes('"enrollment"."enrollments"'))).toBe(false);
  });

  it('leaves confirmed course payments with no enrollment unmarked, so the cron heals them', async () => {
    const { sql, queryRunner } = runner(true);
    await new PaymentEffects1790966512486().up(queryRunner);

    const backfill = sql.filter((s) => s.startsWith('UPDATE'));
    expect(backfill).toHaveLength(1);
    expect(backfill[0]).toContain('NOT EXISTS');
    expect(backfill[0]).toContain('"enrollment"."enrollments"');
  });

  it('adds the column before backfilling it', async () => {
    const { sql, queryRunner } = runner(true);
    await new PaymentEffects1790966512486().up(queryRunner);
    const add = sql.findIndex((s) => s.includes('ADD "effects_completed_at"'));
    const update = sql.findIndex((s) => s.startsWith('UPDATE'));
    expect(add).toBeGreaterThanOrEqual(0);
    expect(add).toBeLessThan(update);
  });
});
