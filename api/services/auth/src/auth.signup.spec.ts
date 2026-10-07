import { ConflictException } from '@nestjs/common';
import { Role } from '@ethiopialearn/contracts';
import { AuthService } from './auth.service';
import { EmailVerification, User } from './entities';

/**
 * Signup through the outbox (Phase 9b): the user, its first verification link
 * and UserRegistered commit in one transaction, and an error before the commit
 * leaves none of them. The fake outbox stages the manager's writes and the
 * emitted events, and keeps them only when the transaction's body resolves.
 * The service's own repositories can't write here, so every write must go
 * through the transaction's manager.
 */
type Row = Record<string, any>;
type Event = { type: string; payload: unknown };

const DTO = { email: ' New@X.et ', password: 'Strong-passw0rd', name: ' Selam ', role: Role.LEARNER };

function setup(opts: { existing?: Row; linkSaveFails?: boolean } = {}) {
  const committed = { users: [] as Row[], verifications: [] as Row[], events: [] as Event[] };
  const users = { findOne: jest.fn(async () => opts.existing ?? null) };
  const bus = { publish: jest.fn() };
  const outbox = {
    transaction: jest.fn(async (fn: (m: unknown, emit: (type: string, payload: unknown) => void) => Promise<unknown>) => {
      const staged = { users: [] as Row[], verifications: [] as Row[], events: [] as Event[] };
      const repo = (prefix: string, rows: Row[], fails = false) => ({
        create: (x: Row) => ({ ...x }),
        save: async (x: Row) => {
          if (fails) throw new Error('connection reset');
          const row = { id: `${prefix}-${rows.length + 1}`, ...x };
          rows.push(row);
          return row;
        },
      });
      const manager = {
        getRepository: (entity: unknown) => {
          if (entity === User) return repo('user', staged.users);
          if (entity === EmailVerification) return repo('link', staged.verifications, opts.linkSaveFails);
          throw new Error('unexpected repository');
        },
      };
      const result = await fn(manager, (type, payload) => staged.events.push({ type, payload }));
      committed.users.push(...staged.users);
      committed.verifications.push(...staged.verifications);
      committed.events.push(...staged.events);
      return result;
    }),
  };
  const svc = new AuthService(users as never, {} as never, {} as never, {} as never, bus as never, {} as never, outbox as never);
  (svc as unknown as { redis: { disconnect?: () => void } }).redis.disconnect?.();
  return { svc, users, bus, outbox, committed };
}

describe('AuthService.signup (outbox)', () => {
  it('commits the user, its verification link and UserRegistered in one transaction, with the same payload as before', async () => {
    const t = setup();
    await expect(t.svc.signup(DTO)).resolves.toEqual({ user_id: 'user-1' });

    expect(t.outbox.transaction).toHaveBeenCalledTimes(1);
    expect(t.committed.users).toEqual([
      expect.objectContaining({ id: 'user-1', email: 'new@x.et', name: 'Selam', role: Role.LEARNER, email_verified_at: null, phone: null }),
    ]);
    expect(t.committed.users[0].password_hash).toMatch(/^\$2[aby]\$10\$/);
    const [link] = t.committed.verifications;
    expect(t.committed.verifications).toEqual([expect.objectContaining({ user_id: 'user-1', used_at: null })]);
    expect(link.token).toMatch(/^[0-9a-f]{64}$/);
    expect(t.committed.events).toEqual([
      {
        type: 'UserRegistered',
        payload: {
          user_id: 'user-1',
          email: 'new@x.et',
          name: 'Selam',
          role: Role.LEARNER,
          verification_url: `http://localhost:3000/verify-email?token=${link.token}`,
        },
      },
    ]);
    expect(t.bus.publish).not.toHaveBeenCalled(); // the outbox publishes after the commit, never the caller
  });

  it('an error before the commit leaves no user, no link and no event, and reaches the caller', async () => {
    const t = setup({ linkSaveFails: true });
    await expect(t.svc.signup(DTO)).rejects.toThrow('connection reset');
    expect(t.committed).toEqual({ users: [], verifications: [], events: [] });
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it('a taken email still answers 409 "Email already in use", before any transaction opens', async () => {
    const t = setup({ existing: { id: 'u0', email: 'new@x.et' } });
    const err = await t.svc.signup(DTO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).message).toBe('Email already in use');
    expect(t.users.findOne).toHaveBeenCalledWith({ where: { email: 'new@x.et' } });
    expect(t.outbox.transaction).not.toHaveBeenCalled();
    expect(t.committed).toEqual({ users: [], verifications: [], events: [] });
  });
});
