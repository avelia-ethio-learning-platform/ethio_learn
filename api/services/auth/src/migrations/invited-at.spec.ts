import { QueryRunner } from 'typeorm';
import { InvitedAt1790964028397 } from './1790964028397-InvitedAt';

describe('InvitedAt migration', () => {
  it('adds the column, backfills it from created_at, then sets the now() default', async () => {
    const sql: string[] = [];
    const queryRunner = { query: jest.fn(async (statement: string) => void sql.push(statement)) } as unknown as QueryRunner;
    await new InvitedAt1790964028397().up(queryRunner);

    const add = sql.findIndex((s) => s.includes('ADD "invited_at"'));
    const backfill = sql.findIndex((s) => s.startsWith('UPDATE') && s.includes('"invited_at" = "created_at"'));
    const defaultNow = sql.findIndex((s) => s.includes('SET DEFAULT now()'));
    expect(add).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeGreaterThan(add);
    expect(defaultNow).toBeGreaterThan(backfill);
  });
});
