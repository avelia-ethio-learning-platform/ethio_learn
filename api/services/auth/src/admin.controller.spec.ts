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

const PAGING = { page: 1, limit: 20 };

describe('AdminUsersController.list search', () => {
  it('treats a repeated q (an array) as no search term instead of throwing', async () => {
    const t = setup();
    await t.ctrl.list(['a', 'b'] as never, undefined, PAGING);
    expect(t.where()).toEqual({});
  });

  it('matches the name or the email, case-insensitively', async () => {
    const t = setup();
    await t.ctrl.list('Abebe', undefined, PAGING);
    const [byEmail, byName] = t.where() as Record<string, FindOperator<string>>[];
    expect(byEmail.email.type).toBe('ilike');
    expect(pattern(byEmail.email)).toBe('%Abebe%');
    expect(byName.name.type).toBe('ilike');
    expect(pattern(byName.name)).toBe('%Abebe%');
  });

  it('keeps the role filter on both branches', async () => {
    const t = setup();
    await t.ctrl.list('abe', Role.EDUCATOR, PAGING);
    const branches = t.where() as Record<string, unknown>[];
    expect(branches).toHaveLength(2);
    expect(branches.map((b) => b.role)).toEqual([Role.EDUCATOR, Role.EDUCATOR]);
  });

  it('treats % _ and \\ literally', async () => {
    const t = setup();
    await t.ctrl.list(' a_b%c\\d ', undefined, PAGING);
    const [byEmail] = t.where() as Record<string, FindOperator<string>>[];
    expect(pattern(byEmail.email)).toBe('%a\\_b\\%c\\\\d%');
  });

  it('filters by role alone without a term', async () => {
    const t = setup();
    await t.ctrl.list('  ', Role.LEARNER, PAGING);
    expect(t.where()).toEqual({ role: Role.LEARNER });
    const u = setup();
    await u.ctrl.list(undefined, undefined, PAGING);
    expect(u.where()).toEqual({});
  });

  it('refuses a term over 100 characters (400)', async () => {
    const t = setup();
    await expect(t.ctrl.list('x'.repeat(101), undefined, PAGING)).rejects.toThrow(BadRequestException);
    expect(t.users.findAndCount).not.toHaveBeenCalled();
    await t.ctrl.list('x'.repeat(100), undefined, PAGING);
    expect(t.users.findAndCount).toHaveBeenCalled();
  });
});

/**
 * createStaff through the outbox (9c review S2): the account, its invite link,
 * the audit row and StaffInvited commit together, so a failure leaves none of
 * them and the link is never lost. The fake outbox stages the manager's writes
 * and keeps them only when the transaction's body resolves.
 */
describe('AdminUsersController.createStaff', () => {
  type Row = Record<string, unknown>;
  const ADMIN = { id: 'adm', role: Role.PLATFORM_ADMIN } as never;
  const DTO = { email: ' QO@X.et ', name: 'Officer', role: Role.QUALITY_OFFICER } as never;

  function staffSetup(opts: { auditFails?: boolean } = {}) {
    const committed: Record<string, Row[]> = { User: [], AuditLog: [], events: [] };
    const users = { findOne: jest.fn(async () => null) };
    const auth = {
      createInvite: jest.fn(async (userId: string, m: { getRepository(e: string): { save(r: Row): Promise<Row> } }) => {
        await m.getRepository('PasswordReset').save({ user_id: userId });
        return 'tok-1';
      }),
    };
    const outbox = {
      transaction: jest.fn(async (fn: (m: unknown, emit: (type: string, payload: unknown) => void) => Promise<unknown>) => {
        const staged: Record<string, Row[]> = { User: [], AuditLog: [], PasswordReset: [], events: [] };
        const manager = {
          getRepository: (entity: { name?: string } | string) => {
            const name = typeof entity === 'string' ? entity : entity.name!;
            return {
              create: (x: Row) => ({ ...x }),
              save: async (x: Row) => {
                if (name === 'AuditLog' && opts.auditFails) throw new Error('connection reset');
                const row = { id: `${name}-1`, ...x };
                staged[name].push(row);
                return row;
              },
            };
          },
        };
        const result = await fn(manager, (type, payload) => staged.events.push({ type, payload }));
        for (const k of Object.keys(staged)) (committed[k] ??= []).push(...staged[k]);
        return result;
      }),
    };
    const ctrl = new AdminUsersController(users as never, {} as never, auth as never, outbox as never);
    return { ctrl, committed, auth };
  }

  it('commits the account, its link, the audit row and StaffInvited together', async () => {
    const t = staffSetup();
    await expect(t.ctrl.createStaff(ADMIN, DTO)).resolves.toEqual({ user_id: 'User-1', invited: true });
    expect(t.committed.User).toEqual([expect.objectContaining({ email: 'qo@x.et', must_change_password: true })]);
    expect(t.committed.PasswordReset).toEqual([{ id: 'PasswordReset-1', user_id: 'User-1' }]);
    expect(t.committed.AuditLog).toEqual([expect.objectContaining({ actor_id: 'adm', action: 'user.staff_created', target: 'User-1' })]);
    expect(t.committed.events).toEqual([
      { type: 'StaffInvited', payload: expect.objectContaining({ user_id: 'User-1', invite_url: expect.stringContaining('/accept-invite?token=tok-1') }) },
    ]);
  });

  it('a failure before the commit leaves no account, link or email', async () => {
    const t = staffSetup({ auditFails: true });
    await expect(t.ctrl.createStaff(ADMIN, DTO)).rejects.toThrow('connection reset');
    expect(Object.values(t.committed).flat()).toEqual([]);
  });
});
