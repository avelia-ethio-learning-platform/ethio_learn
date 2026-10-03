import { BadRequestException, ConflictException, ForbiddenException, HttpStatus, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { FindOperator, QueryFailedError } from 'typeorm';
import { UserContext } from '@ethiopialearn/common';
import { Role, UserStatus } from '@ethiopialearn/contracts';
import { AuditLog } from './audit';
import { AuthService } from './auth.service';
import { EducatorProfile, Institution, InstitutionInstructor, User } from './entities';
import { InternalController } from './internal.controller';
import { MembershipService } from './membership.service';

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (want instanceof FindOperator) {
      if (want.type === 'in') return (want.value as unknown[]).includes(row[key]);
      if (want.type === 'moreThan') return row[key] != null && row[key] > (want.value as Date);
      throw new Error(`memRepo: unsupported operator ${want.type}`);
    }
    return (row[key] ?? null) === (want ?? null);
  });
}

const uniqueViolation = () => new QueryFailedError('query', [], Object.assign(new Error('duplicate key value'), { code: '23505' }));

/** In-memory stand-in for the repository calls the auth code makes. `check` plays the unique indexes. */
function memRepo(rows: Row[], idPrefix: string, check: (others: Row[], row: Row) => void = () => undefined) {
  let seq = 0;
  const find = (opts: { where?: Row } = {}) => rows.filter((r) => matches(r, opts.where));
  const persist = (x: Row) => {
    if (!x.id) x.id = `${idPrefix}${++seq}`;
    x.created_at ??= new Date();
    check(rows.filter((r) => r.id !== x.id), x);
    const i = rows.findIndex((r) => r.id === x.id);
    if (i === -1) rows.push({ ...x });
    else rows[i] = { ...x };
    return { ...x };
  };
  return {
    rows,
    create: jest.fn((x: Row) => ({ ...x })),
    find: jest.fn(async (opts?: { where?: Row }) => find(opts).map((r) => ({ ...r }))),
    findOne: jest.fn(async (opts?: { where?: Row }) => {
      const hit = find(opts)[0];
      return hit ? { ...hit } : null;
    }),
    findOneOrFail: jest.fn(async (opts?: { where?: Row }) => {
      const hit = find(opts)[0];
      if (!hit) throw new Error('not found');
      return { ...hit };
    }),
    count: jest.fn(async (opts?: { where?: Row }) => find(opts).length),
    save: jest.fn(async (x: Row) => persist(x)),
    update: jest.fn(async (where: Row, patch: Row) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) check(rows.filter((o) => o !== r), { ...r, ...patch });
      hit.forEach((r) => Object.assign(r, patch));
      return { affected: hit.length };
    }),
  };
}

/** UNIQUE (institution_id, user_id) and UNIQUE (user_id) WHERE status = 'active'. */
function membershipIndexes(others: Row[], row: Row) {
  if (others.some((o) => o.institution_id === row.institution_id && o.user_id === row.user_id)) throw uniqueViolation();
  if (row.status === 'active' && others.some((o) => o.user_id === row.user_id && o.status === 'active')) throw uniqueViolation();
}

const IA1 = { id: 'ia1', role: Role.INSTITUTION_ADMIN, email: 'owner1@x.et' } as UserContext;
const IA2 = { id: 'ia2', role: Role.INSTITUTION_ADMIN, email: 'owner2@x.et' } as UserContext;

const user = (id: string, role: Role, over: Row = {}): Row => ({
  id,
  role,
  email: `${id}@x.et`,
  name: `Name of ${id}`,
  password_hash: 'hash',
  email_verified_at: new Date('2026-01-01'),
  must_change_password: false,
  status: UserStatus.ACTIVE,
  status_reason: null,
  phone: null,
  ...over,
});

const membership = (id: string, institution_id: string, user_id: string, status: string, over: Row = {}): Row => ({
  id,
  institution_id,
  user_id,
  role_in_org: 'instructor',
  status,
  status_reason: null,
  invited_by: 'ia1',
  created_at: new Date('2026-02-01'),
  accepted_at: status === 'invited' || status === 'declined' ? null : new Date('2026-02-02'),
  ...over,
});

function setup(memberships: Row[] = []) {
  const users = memRepo(
    [
      user('ia1', Role.INSTITUTION_ADMIN),
      user('ia2', Role.INSTITUTION_ADMIN),
      user('lrn1', Role.LEARNER),
      user('lrn2', Role.LEARNER),
      user('edu1', Role.EDUCATOR),
      user('qo1', Role.QUALITY_OFFICER),
    ],
    'u-new',
  );
  const institutions = memRepo(
    [
      { id: 'inst1', name: 'Addis Academy', owner_user_id: 'ia1', logo_url: null },
      { id: 'inst2', name: 'Bahir Dar Tech', owner_user_id: 'ia2', logo_url: null },
    ],
    'inst-new',
  );
  const members = memRepo(memberships, 'm-new', membershipIndexes);
  const profiles = memRepo([{ id: 'p-edu1', user_id: 'edu1', bio: '', expertise_area: '' }], 'p-new');
  const audit = memRepo([], 'a');

  // Transactions snapshot every table and restore it on failure, like Postgres would.
  const byEntity = new Map<unknown, ReturnType<typeof memRepo>>([
    [User, users],
    [Institution, institutions],
    [InstitutionInstructor, members],
    [EducatorProfile, profiles],
    [AuditLog, audit],
  ]);
  const manager = { getRepository: (entity: unknown) => byEntity.get(entity) };
  const dataSource = {
    transaction: jest.fn(async (fn: (m: typeof manager) => Promise<unknown>) => {
      const snapshot = [...byEntity.values()].map((repo) => repo.rows.map((r) => ({ ...r })));
      try {
        return await fn(manager);
      } catch (err) {
        [...byEntity.values()].forEach((repo, i) => repo.rows.splice(0, repo.rows.length, ...snapshot[i]));
        throw err;
      }
    }),
  };
  const bus = { publish: jest.fn(async () => undefined) };
  const auth = { createInvite: jest.fn(async () => 'invite-token') };
  const svc = new MembershipService(
    users as never,
    institutions as never,
    members as never,
    audit as never,
    dataSource as never,
    bus as never,
    auth as never,
  );
  const published = (type: string) => bus.publish.mock.calls.filter((c: unknown[]) => c[0] === type).map((c: unknown[]) => c[1]);
  const userRow = (id: string) => users.rows.find((r) => r.id === id)!;
  const memberRow = (id: string) => members.rows.find((r) => r.id === id)!;
  return { svc, users, institutions, members, profiles, audit, bus, auth, published, userRow, memberRow };
}

describe('MembershipService.invite', () => {
  it('invites an existing learner without touching their account', async () => {
    const t = setup();
    const before = { ...t.userRow('lrn1') };
    const res = await t.svc.invite(IA1, 'inst1', { email: ' LRN1@x.et ' });
    expect(res).toEqual({ membership: { id: expect.any(String), status: 'invited', email: 'lrn1@x.et' } });
    expect(t.userRow('lrn1')).toEqual(before);
    expect(t.memberRow(res.membership.id)).toMatchObject({ institution_id: 'inst1', user_id: 'lrn1', status: 'invited', invited_by: 'ia1' });
    expect(t.published('InstructorInvited')).toEqual([
      { user_id: 'lrn1', email: 'lrn1@x.et', name: 'Name of lrn1', institution_id: 'inst1', institution_name: 'Addis Academy' },
    ]);
    expect(t.published('StaffInvited')).toEqual([]);
    expect(t.audit.rows).toEqual([expect.objectContaining({ actor_id: 'ia1', action: 'institution.member_invited', target: res.membership.id })]);
  });

  it('gives a new email a placeholder LEARNER and a setup link that names the institution', async () => {
    const t = setup();
    const res = await t.svc.invite(IA1, 'inst1', { email: 'new.person@x.et', name: 'New Person' });
    expect(res).toEqual({ membership: { id: expect.any(String), status: 'invited', email: 'new.person@x.et' } });
    const placeholder = t.users.rows.find((r) => r.email === 'new.person@x.et')!;
    expect(placeholder).toMatchObject({ role: Role.LEARNER, name: 'New Person', must_change_password: true });
    expect(t.profiles.rows.find((p) => p.user_id === placeholder.id)).toBeUndefined();
    expect(t.auth.createInvite).toHaveBeenCalledWith(placeholder.id);
    expect(t.published('StaffInvited')).toEqual([
      expect.objectContaining({ user_id: placeholder.id, role: 'instructor', institution_name: 'Addis Academy', invite_url: expect.stringContaining('/accept-invite?token=invite-token') }),
    ]);
    expect(t.published('InstructorInvited')).toEqual([]);
  });

  it('answers the same for a new email without a name (no 400 that reveals the address is unknown)', async () => {
    const t = setup();
    const res = await t.svc.invite(IA1, 'inst1', { email: 'nobody@x.et' });
    expect(res.membership).toMatchObject({ status: 'invited', email: 'nobody@x.et' });
    expect(t.users.rows.find((r) => r.email === 'nobody@x.et')).toMatchObject({ name: 'nobody' });
  });

  it.each(['qo1@x.et', 'ia2@x.et'])('gives staff and institution owners (%s) the same response, and no email', async (email) => {
    const t = setup();
    const learner = await t.svc.invite(IA1, 'inst1', { email: 'lrn1@x.et' });
    t.bus.publish.mockClear();
    const res = await t.svc.invite(IA1, 'inst1', { email });
    expect(Object.keys(res.membership)).toEqual(Object.keys(learner.membership));
    expect(res.membership).toMatchObject({ status: 'invited', email });
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it.each(['declined', 'removed'])('re-invites a %s membership as a fresh invitation', async (status) => {
    const t = setup([membership('m1', 'inst1', 'lrn1', status, { status_reason: 'old reason' })]);
    const res = await t.svc.invite(IA1, 'inst1', { email: 'lrn1@x.et' });
    expect(res.membership.id).toBe('m1');
    expect(t.memberRow('m1')).toMatchObject({ status: 'invited', status_reason: null, accepted_at: null });
    expect(t.published('InstructorInvited')).toHaveLength(1);
  });

  it('refuses an active or suspended member of this institution (409)', async () => {
    const t = setup([membership('m1', 'inst1', 'edu1', 'active'), membership('m2', 'inst1', 'lrn1', 'suspended')]);
    await expect(t.svc.invite(IA1, 'inst1', { email: 'edu1@x.et' })).rejects.toThrow(ConflictException);
    await expect(t.svc.invite(IA1, 'inst1', { email: 'lrn1@x.et' })).rejects.toThrow(ConflictException);
  });

  it("refuses someone else's institution (403) before looking at the email", async () => {
    const t = setup();
    await expect(t.svc.invite(IA2, 'inst1', { email: 'lrn1@x.et' })).rejects.toThrow(ForbiddenException);
    expect(t.users.findOne).not.toHaveBeenCalled();
    expect(t.members.rows).toEqual([]);
  });
  describe('daily invite cap', () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const OLD_ENV = process.env.INSTITUTION_INVITES_PER_DAY;
    afterEach(() => {
      if (OLD_ENV === undefined) delete process.env.INSTITUTION_INVITES_PER_DAY;
      else process.env.INSTITUTION_INVITES_PER_DAY = OLD_ENV;
    });

    it('stamps invited_at on a new invitation', async () => {
      const t = setup();
      const res = await t.svc.invite(IA1, 'inst1', { email: 'lrn1@x.et' });
      expect(t.memberRow(res.membership.id).invited_at).toBeInstanceOf(Date);
    });

    it('answers 429 at the cap, counting only this institution and the last 24 h, and changes nothing', async () => {
      process.env.INSTITUTION_INVITES_PER_DAY = '2';
      const t = setup([
        membership('m1', 'inst1', 'lrn2', 'invited', { invited_at: hoursAgo(1) }),
        membership('m2', 'inst1', 'qo1', 'declined', { invited_at: hoursAgo(23) }),
        membership('m3', 'inst1', 'edu1', 'removed', { invited_at: hoursAgo(30) }), // outside the window
        membership('m4', 'inst2', 'edu1', 'invited', { invited_at: hoursAgo(1) }), // another institution
      ]);
      const err = await t.svc.invite(IA1, 'inst1', { email: 'lrn1@x.et' }).catch((e) => e);
      expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(err.message).toBe("You've reached today's limit for instructor invites. Try again tomorrow.");
      expect(t.members.rows).toHaveLength(4);
      expect(t.bus.publish).not.toHaveBeenCalled();
      // Another institution still has room.
      await expect(t.svc.invite(IA2, 'inst2', { email: 'lrn1@x.et' })).resolves.toBeDefined();
    });

    it('also checks a re-invite against the cap', async () => {
      process.env.INSTITUTION_INVITES_PER_DAY = '1';
      const t = setup([membership('m1', 'inst1', 'lrn1', 'invited', { invited_at: hoursAgo(2) })]);
      await expect(t.svc.invite(IA1, 'inst1', { email: 'lrn1@x.et' })).rejects.toMatchObject({ status: 429 });
    });

    it('re-invites within 24 h of the last invite without a second email, and refreshes invited_at', async () => {
      const t = setup([membership('m1', 'inst1', 'lrn1', 'invited', { invited_at: hoursAgo(3) })]);
      const before = t.memberRow('m1').invited_at;
      const res = await t.svc.invite(IA1, 'inst1', { email: 'lrn1@x.et' });
      expect(res.membership).toMatchObject({ id: 'm1', status: 'invited' });
      expect(t.bus.publish).not.toHaveBeenCalled();
      expect(t.memberRow('m1').invited_at.getTime()).toBeGreaterThan(before.getTime());
    });

    it('re-sends once the last invite is more than 24 h old', async () => {
      const t = setup([membership('m1', 'inst1', 'lrn1', 'declined', { invited_at: hoursAgo(25) })]);
      await t.svc.invite(IA1, 'inst1', { email: 'lrn1@x.et' });
      expect(t.published('InstructorInvited')).toHaveLength(1);
    });

    it('invite, cancel, re-invite within a day: one email in total, and the re-invite counts toward the cap', async () => {
      process.env.INSTITUTION_INVITES_PER_DAY = '2';
      const t = setup();
      const first = await t.svc.invite(IA1, 'inst1', { email: 'lrn1@x.et' });
      expect(t.published('InstructorInvited')).toHaveLength(1);
      await t.svc.setStatus(IA1, 'inst1', first.membership.id, { status: 'removed' } as never);
      const again = await t.svc.invite(IA1, 'inst1', { email: 'lrn1@x.et' });
      expect(again.membership).toMatchObject({ id: first.membership.id, status: 'invited' });
      expect(t.published('InstructorInvited')).toHaveLength(1);
      // The re-invite stamped invited_at again; with one row stamped now, a second address still fits, a third does not.
      await t.svc.invite(IA1, 'inst1', { email: 'lrn2@x.et' });
      await expect(t.svc.invite(IA1, 'inst1', { email: 'edu1@x.et' })).rejects.toMatchObject({ status: 429 });
    });
  });
});

describe('MembershipService.list', () => {
  it('shows name and role only after acceptance, loading users in one query', async () => {
    const t = setup([
      membership('m1', 'inst1', 'lrn1', 'invited'),
      membership('m2', 'inst1', 'edu1', 'active'),
      membership('m3', 'inst1', 'lrn2', 'declined'),
      membership('m4', 'inst2', 'qo1', 'invited'),
    ]);
    const rows = await t.svc.list(IA1, 'inst1');
    expect(rows).toEqual([
      { membership_id: 'm1', status: 'invited', status_reason: null, email: 'lrn1@x.et' },
      { membership_id: 'm2', status: 'active', status_reason: null, email: 'edu1@x.et', user: { id: 'edu1', name: 'Name of edu1', role: Role.EDUCATOR } },
      { membership_id: 'm3', status: 'declined', status_reason: null, email: 'lrn2@x.et' },
    ]);
    expect(t.users.find).toHaveBeenCalledTimes(1);
  });

  it("refuses another institution's list", async () => {
    await expect(setup().svc.list(IA2, 'inst1')).rejects.toThrow(ForbiddenException);
  });
});

describe('MembershipService.accept', () => {
  it('upgrades a learner to educator in their own session, with an educator profile and one InstructorLinked', async () => {
    const t = setup([membership('m1', 'inst1', 'lrn1', 'invited')]);
    await expect(t.svc.accept('lrn1', 'm1')).resolves.toEqual({ role: Role.EDUCATOR });
    expect(t.userRow('lrn1')).toMatchObject({ role: Role.EDUCATOR, status: UserStatus.ACTIVE });
    expect(t.memberRow('m1')).toMatchObject({ status: 'active', accepted_at: expect.any(Date) });
    expect(t.profiles.rows.filter((p) => p.user_id === 'lrn1')).toHaveLength(1);
    expect(t.published('InstructorLinked')).toEqual([
      { user_id: 'lrn1', email: 'lrn1@x.et', name: 'Name of lrn1', institution_id: 'inst1', institution_name: 'Addis Academy', upgraded_from_learner: true },
    ]);
    expect(t.audit.rows).toEqual([expect.objectContaining({ actor_id: 'lrn1', action: 'institution.member_accepted', target: 'm1' })]);
  });

  it('keeps an educator an educator and their existing profile', async () => {
    const t = setup([membership('m1', 'inst1', 'edu1', 'invited')]);
    await expect(t.svc.accept('edu1', 'm1')).resolves.toEqual({ role: Role.EDUCATOR });
    expect(t.profiles.rows.filter((p) => p.user_id === 'edu1')).toHaveLength(1);
    expect(t.published('InstructorLinked')).toEqual([expect.objectContaining({ upgraded_from_learner: false })]);
  });

  it('accepts once: a second accept is 404 and publishes nothing more', async () => {
    const t = setup([membership('m1', 'inst1', 'lrn1', 'invited')]);
    await t.svc.accept('lrn1', 'm1');
    await expect(t.svc.accept('lrn1', 'm1')).rejects.toThrow(NotFoundException);
    expect(t.published('InstructorLinked')).toHaveLength(1);
  });

  it("can't accept someone else's invitation", async () => {
    const t = setup([membership('m1', 'inst1', 'lrn1', 'invited')]);
    await expect(t.svc.accept('lrn2', 'm1')).rejects.toThrow(NotFoundException);
    expect(t.memberRow('m1').status).toBe('invited');
    expect(t.userRow('lrn2').role).toBe(Role.LEARNER);
  });

  it.each(['qo1', 'ia2'])('refuses %s (staff or an institution owner) and leaves the invitation pending', async (id) => {
    const t = setup([membership('m1', 'inst1', id, 'invited')]);
    const role = t.userRow(id).role;
    await expect(t.svc.accept(id, 'm1')).rejects.toThrow(ForbiddenException);
    expect(t.memberRow('m1')).toMatchObject({ status: 'invited', accepted_at: null });
    expect(t.userRow(id).role).toBe(role);
    expect(t.published('InstructorLinked')).toEqual([]);
  });

  it('refuses while active with another institution (409), changing nothing', async () => {
    const t = setup([membership('m1', 'inst2', 'lrn1', 'active'), membership('m2', 'inst1', 'lrn1', 'invited')]);
    await expect(t.svc.accept('lrn1', 'm2')).rejects.toThrow(ConflictException);
    expect(t.memberRow('m2').status).toBe('invited');
    expect(t.userRow('lrn1').role).toBe(Role.LEARNER);
    expect(t.published('InstructorLinked')).toEqual([]);
  });
});

describe('MembershipService.decline and myInvites', () => {
  it('lists pending invitations with the institution named, and declines one', async () => {
    const t = setup([membership('m1', 'inst1', 'lrn1', 'invited'), membership('m2', 'inst2', 'lrn1', 'removed')]);
    await expect(t.svc.myInvites('lrn1')).resolves.toEqual([{ id: 'm1', institution: { id: 'inst1', name: 'Addis Academy' }, invited_at: expect.any(Date) }]);
    await expect(t.svc.decline('lrn1', 'm1')).resolves.toEqual({ status: 'declined' });
    expect(t.memberRow('m1').status).toBe('declined');
    await expect(t.svc.myInvites('lrn1')).resolves.toEqual([]);
    await expect(t.svc.decline('lrn1', 'm1')).rejects.toThrow(NotFoundException);
  });

  it("can't decline someone else's invitation", async () => {
    const t = setup([membership('m1', 'inst1', 'lrn1', 'invited')]);
    await expect(t.svc.decline('lrn2', 'm1')).rejects.toThrow(NotFoundException);
    expect(t.memberRow('m1').status).toBe('invited');
  });
});

describe('MembershipService.setStatus', () => {
  it.each([
    ['active', 'suspended', 'late grading', 'late grading'],
    ['suspended', 'active', 'ignored', null],
    ['active', 'removed', undefined, null],
    ['suspended', 'removed', 'left', 'left'],
    ['invited', 'removed', undefined, null], // cancel an invitation
    ['declined', 'removed', undefined, null],
  ])('%s → %s changes only the membership', async (from, to, reason, storedReason) => {
    const t = setup([membership('m1', 'inst1', 'lrn1', from)]);
    const before = t.users.rows.map((r) => ({ ...r }));
    const res = await t.svc.setStatus(IA1, 'inst1', 'm1', { status: to as 'active' | 'suspended' | 'removed', reason });
    expect(res).toEqual({ membership_id: 'm1', status: to, status_reason: storedReason });
    expect(t.users.rows).toEqual(before);
    expect(t.users.update).not.toHaveBeenCalled();
    expect(t.audit.rows).toEqual([expect.objectContaining({ action: 'institution.member_status', target: 'm1', detail: expect.objectContaining({ status: to }) })]);
  });

  it.each([
    ['invited', 'active'], // only the user accepts an invitation
    ['removed', 'active'],
    ['declined', 'active'],
    ['suspended', 'suspended'],
    ['removed', 'removed'],
  ])('refuses %s → %s (400)', async (from, to) => {
    const t = setup([membership('m1', 'inst1', 'lrn1', from)]);
    await expect(t.svc.setStatus(IA1, 'inst1', 'm1', { status: to as 'active' | 'suspended' | 'removed' })).rejects.toThrow(BadRequestException);
    expect(t.memberRow('m1').status).toBe(from);
    expect(t.audit.rows).toEqual([]);
  });

  it("404s a membership that isn't in this institution", async () => {
    const t = setup([membership('m9', 'inst2', 'lrn1', 'active')]);
    await expect(t.svc.setStatus(IA1, 'inst1', 'm9', { status: 'suspended' })).rejects.toThrow(NotFoundException);
    await expect(t.svc.setStatus(IA1, 'inst1', 'nope', { status: 'suspended' })).rejects.toThrow(NotFoundException);
    expect(t.memberRow('m9').status).toBe('active');
  });

  it('409s reactivating someone who is active with another institution now', async () => {
    const t = setup([membership('m1', 'inst1', 'lrn1', 'suspended'), membership('m2', 'inst2', 'lrn1', 'active')]);
    await expect(t.svc.setStatus(IA1, 'inst1', 'm1', { status: 'active' })).rejects.toThrow(ConflictException);
    expect(t.memberRow('m1').status).toBe('suspended');
  });

  it("refuses another institution's member (403)", async () => {
    const t = setup([membership('m1', 'inst1', 'lrn1', 'active')]);
    await expect(t.svc.setStatus(IA2, 'inst1', 'm1', { status: 'suspended' })).rejects.toThrow(ForbiddenException);
  });
});

describe('Internal institution lookup', () => {
  it.each(['invited', 'suspended', 'removed', 'declined'])('routes nothing for a %s membership', async (status) => {
    const t = setup([membership('m1', 'inst1', 'lrn1', status)]);
    const ctrl = new InternalController(t.users as never, t.profiles as never, t.institutions as never, t.members as never);
    await expect(ctrl.userInstitution('lrn1')).resolves.toEqual({ institution_id: null, institution_admin_user_id: null, institution_name: null });
  });

  it('routes to the active membership', async () => {
    const t = setup([membership('m1', 'inst2', 'edu1', 'removed'), membership('m2', 'inst1', 'edu1', 'active')]);
    const ctrl = new InternalController(t.users as never, t.profiles as never, t.institutions as never, t.members as never);
    await expect(ctrl.userInstitution('edu1')).resolves.toEqual({ institution_id: 'inst1', institution_admin_user_id: 'ia1', institution_name: 'Addis Academy' });
  });
});

describe('AuthService.acceptInvite (the emailed setup link)', () => {
  const savedSecret = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
  });
  afterAll(() => {
    if (savedSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedSecret;
  });

  function authFor(t: ReturnType<typeof setup>, userId: string) {
    const resets = memRepo([{ id: 'r1', user_id: userId, token: 'tok', expires_at: new Date(Date.now() + 3600_000), used_at: null }], 'r');
    const auth = new AuthService(t.users as never, {} as never, resets as never, t.members as never, t.bus as never);
    // Swap the ioredis connection opened at field init for a stub (only token issuing is used here).
    const real = (auth as unknown as { redis: { disconnect?: () => void } }).redis;
    real?.disconnect?.();
    (auth as unknown as { redis: object }).redis = { set: async () => 'OK', sadd: async () => 1, expire: async () => 1 };
    return { auth, resets };
  }

  it('sets the password only: the institution invitation stays pending and is counted', async () => {
    const t = setup([membership('m1', 'inst1', 'lrn1', 'invited')]);
    t.userRow('lrn1').must_change_password = true;
    const { auth, resets } = authFor(t, 'lrn1');
    const res = await auth.acceptInvite('tok', 'A-new-passw0rd');
    expect(res.pending_institution_invites).toBe(1);
    expect(res.user).toMatchObject({ id: 'lrn1', role: Role.LEARNER, must_change_password: false });
    expect(t.userRow('lrn1').password_hash).not.toBe('hash');
    expect(t.memberRow('m1')).toMatchObject({ status: 'invited', accepted_at: null });
    expect(resets.rows[0].used_at).toEqual(expect.any(Date));
  });

  it('still onboards staff: a quality officer sets a password and keeps their role', async () => {
    const t = setup();
    t.userRow('qo1').must_change_password = true;
    const { auth } = authFor(t, 'qo1');
    const res = await auth.acceptInvite('tok', 'A-new-passw0rd');
    expect(res.user).toMatchObject({ id: 'qo1', role: Role.QUALITY_OFFICER });
    expect(res.pending_institution_invites).toBe(0);
  });

  it.each([UserStatus.BANNED, UserStatus.SUSPENDED])('refuses a %s account and leaves the link unused', async (status) => {
    const t = setup();
    t.userRow('lrn1').status = status;
    const { auth, resets } = authFor(t, 'lrn1');
    await expect(auth.acceptInvite('tok', 'A-new-passw0rd')).rejects.toThrow(UnauthorizedException);
    expect(resets.rows[0].used_at).toBeNull();
    expect(t.userRow('lrn1').password_hash).toBe('hash');
  });
});
