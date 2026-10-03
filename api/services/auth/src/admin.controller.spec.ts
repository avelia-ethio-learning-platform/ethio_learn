import { BadRequestException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { Role } from '@ethiopialearn/contracts';
import { AdminUsersController } from './admin.controller';

/** What the search sends to the database: the ILIKE pattern of each branch. */
function setup() {
  const users = { findAndCount: jest.fn(async (_opts: unknown) => [[], 0]) };
  const ctrl = new AdminUsersController(users as never, {} as never, {} as never, {} as never);
  const where = () => (users.findAndCount.mock.calls[0][0] as { where: unknown }).where;
  return { ctrl, users, where };
}

const pattern = (op: unknown) => (op as FindOperator<string>).value;

describe('AdminUsersController.list search', () => {
  it('treats a repeated q (an array) as no search term instead of throwing', async () => {
    const t = setup();
    await t.ctrl.list(['a', 'b'] as never);
    expect(t.where()).toEqual({});
  });

  it('matches the name or the email, case-insensitively', async () => {
    const t = setup();
    await t.ctrl.list('Abebe');
    const [byEmail, byName] = t.where() as Record<string, FindOperator<string>>[];
    expect(byEmail.email.type).toBe('ilike');
    expect(pattern(byEmail.email)).toBe('%Abebe%');
    expect(byName.name.type).toBe('ilike');
    expect(pattern(byName.name)).toBe('%Abebe%');
  });

  it('keeps the role filter on both branches', async () => {
    const t = setup();
    await t.ctrl.list('abe', Role.EDUCATOR);
    const branches = t.where() as Record<string, unknown>[];
    expect(branches).toHaveLength(2);
    expect(branches.map((b) => b.role)).toEqual([Role.EDUCATOR, Role.EDUCATOR]);
  });

  it('treats % _ and \\ literally', async () => {
    const t = setup();
    await t.ctrl.list(' a_b%c\\d ');
    const [byEmail] = t.where() as Record<string, FindOperator<string>>[];
    expect(pattern(byEmail.email)).toBe('%a\\_b\\%c\\\\d%');
  });

  it('filters by role alone without a term', async () => {
    const t = setup();
    await t.ctrl.list('  ', Role.LEARNER);
    expect(t.where()).toEqual({ role: Role.LEARNER });
    const u = setup();
    await u.ctrl.list();
    expect(u.where()).toEqual({});
  });

  it('refuses a term over 100 characters (400)', async () => {
    const t = setup();
    await expect(t.ctrl.list('x'.repeat(101))).rejects.toThrow(BadRequestException);
    expect(t.users.findAndCount).not.toHaveBeenCalled();
    await t.ctrl.list('x'.repeat(100));
    expect(t.users.findAndCount).toHaveBeenCalled();
  });
});
