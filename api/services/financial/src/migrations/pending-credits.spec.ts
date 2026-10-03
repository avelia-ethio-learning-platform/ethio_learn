import { QueryRunner } from 'typeorm';
import { PendingCreditsRefundMark1790966512490 } from './1790966512490-PendingCreditsRefundMark';
import { PendingCreditIndexes1790966512491 } from './1790966512491-PendingCreditIndexes';

/** Records every statement. */
function runner() {
  const sql: string[] = [];
  const query = jest.fn(async (statement: string) => {
    sql.push(statement);
    return [];
  });
  return { sql, queryRunner: { query } as unknown as QueryRunner };
}

describe('PendingCreditsRefundMark migration', () => {
  it('adds the refund mark, then the state column with the named CHECK and the credit columns', async () => {
    const { sql, queryRunner } = runner();
    await new PendingCreditsRefundMark1790966512490().up(queryRunner);

    expect(sql.some((s) => s.includes(`ADD "state" character varying(16) NOT NULL DEFAULT 'available'`))).toBe(true);
    expect(sql.some((s) => s.includes('"CHK_wallet_transactions_state"') && s.includes(`'available', 'pending', 'void'`))).toBe(true);
    expect(sql.some((s) => s.includes('ADD "available_at" TIMESTAMP WITH TIME ZONE'))).toBe(true);
    expect(sql.some((s) => s.includes('ADD "payment_id" uuid'))).toBe(true);
    expect(sql.some((s) => s.includes('ADD "refund_requested_at" TIMESTAMP WITH TIME ZONE'))).toBe(true);
    // The app's lock order: every payments statement before any wallet_transactions one.
    const lastPayments = sql.map((s) => s.includes('"financial"."payments"')).lastIndexOf(true);
    expect(lastPayments).toBeLessThan(sql.findIndex((s) => s.includes('"financial"."wallet_transactions"')));
  });

  it('backfills the mark only from pending refund requests, after adding the column', async () => {
    const { sql, queryRunner } = runner();
    await new PendingCreditsRefundMark1790966512490().up(queryRunner);

    const update = sql.findIndex((s) => s.startsWith('UPDATE'));
    expect(sql.filter((s) => s.startsWith('UPDATE'))).toHaveLength(1);
    expect(sql[update]).toContain(`r.status = 'pending'`);
    expect(sql[update]).toContain('r.created_at');
    expect(sql.findIndex((s) => s.includes('ADD "refund_requested_at"'))).toBeLessThan(update);
  });

  it('down drops the columns and the CHECK', async () => {
    const { sql, queryRunner } = runner();
    await new PendingCreditsRefundMark1790966512490().down(queryRunner);

    for (const part of ['DROP COLUMN "refund_requested_at"', 'DROP COLUMN "payment_id"', 'DROP COLUMN "available_at"', 'DROP CONSTRAINT "CHK_wallet_transactions_state"', 'DROP COLUMN "state"']) {
      expect(sql.some((s) => s.includes(part))).toBe(true);
    }
  });
});

describe('PendingCreditIndexes migration', () => {
  it('runs outside a transaction, one CONCURRENTLY statement per query, dropping before creating', async () => {
    const migration = new PendingCreditIndexes1790966512491();
    expect(migration.transaction).toBe(false);
    const { sql, queryRunner } = runner();
    await migration.up(queryRunner);

    expect(sql).toHaveLength(4);
    for (const s of sql) expect(s).toMatch(/^(DROP|CREATE) INDEX CONCURRENTLY/);
    expect(sql[0]).toContain('IF EXISTS');
    expect(sql[2]).toContain('IF EXISTS');
  });

  it('creates both partial indexes with their predicates', async () => {
    const { sql, queryRunner } = runner();
    await new PendingCreditIndexes1790966512491().up(queryRunner);

    expect(sql.some((s) => s.includes('("user_id", "available_at") WHERE state = \'pending\''))).toBe(true);
    expect(sql.some((s) => s.includes('("payment_id") WHERE payment_id IS NOT NULL'))).toBe(true);
  });
});
