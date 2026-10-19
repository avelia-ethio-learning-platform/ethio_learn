import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PeerAsleepError, PeerNotFoundError } from '@ethiopialearn/common';
import { CommunityService } from './community.service';

/** Who may post a course comment (13b review S6): comments show on the public course page. */
describe('CommunityService.addComment posting rights', () => {
  const COURSE = { title: 'Python', owner_id: 'edu1', created_by: 'edu1', institution_id: null as string | null };

  function setup(course: typeof COURSE = COURSE, entitlement = 'active') {
    const saved: unknown[] = [];
    const repo = { create: jest.fn((x) => x), save: jest.fn(async (x) => (saved.push(x), { id: 'cm1', ...x })), findOne: jest.fn(async () => null) };
    const internal = {
      get: jest.fn(async (path: string) => {
        if (path.includes('/internal/courses/')) return course;
        if (path.includes('/entitlements')) return { entitlement_status: entitlement };
        if (path.includes('/institutions/by-owner/ia1')) return { id: 'inst1' };
        if (path.includes('/institutions/by-owner/')) throw new Error('404');
        return { name: 'Someone' };
      }),
    };
    const svc = new CommunityService(repo as never, {} as never, {} as never, repo as never, internal as never);
    return { svc, saved };
  }
  const as = (id: string, role: string) => ({ id, role }) as never;
  const forbidden = new ForbiddenException('Only the course’s own educators can post here');

  it("refuses an educator on another educator's course, and posts nothing", async () => {
    const t = setup();
    await expect(t.svc.addComment(as('edu2', 'educator'), 'c1', 'Buy my course instead')).rejects.toThrow(forbidden);
    expect(t.saved).toHaveLength(0);
  });

  it('lets the course educator post', async () => {
    await expect(setup().svc.addComment(as('edu1', 'educator'), 'c1', 'Welcome!')).resolves.toMatchObject({ author_id: 'edu1' });
  });

  it("lets an institution admin post on the institution's courses only", async () => {
    const instCourse = { ...COURSE, institution_id: 'inst1' };
    await expect(setup(instCourse).svc.addComment(as('ia1', 'institution_admin'), 'c1', 'Hi')).resolves.toMatchObject({ author_id: 'ia1' });
    await expect(setup().svc.addComment(as('ia1', 'institution_admin'), 'c1', 'Hi')).rejects.toThrow(forbidden);
    await expect(setup(instCourse).svc.addComment(as('ia2', 'institution_admin'), 'c1', 'Hi')).rejects.toThrow(forbidden);
  });

  it('keeps the learner rule: an active enrollment is required', async () => {
    await expect(setup().svc.addComment(as('lrn1', 'learner'), 'c1', 'Question')).resolves.toMatchObject({ author_id: 'lrn1' });
    await expect(setup(COURSE, 'none').svc.addComment(as('lrn1', 'learner'), 'c1', 'Question')).rejects.toThrow('Enroll in the course');
  });

  it('lets platform staff post anywhere', async () => {
    await expect(setup().svc.addComment(as('adm1', 'platform_admin'), 'c1', 'Moderator note')).resolves.toMatchObject({ author_id: 'adm1' });
  });
});

/** Who a DM thread can be opened to (P2-12): any active account, and nothing else says more than that. */
describe('CommunityService.openThread recipients', () => {
  const ME = { id: '00000000-0000-4000-8000-00000000000a', role: 'learner' } as never;
  const PEER = '00000000-0000-4000-8000-00000000000b';

  function setup(peer: Record<string, unknown> | null, failure: Error = new PeerNotFoundError('User not found')) {
    const threads = {
      findOne: jest.fn(async () => null),
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id: 't1', a_unread: 0, b_unread: 0, ...x })),
    };
    const internal = {
      get: jest.fn(async (path: string) => {
        if (path.endsWith(PEER)) {
          if (!peer) throw failure;
          return peer;
        }
        return { name: 'Me' };
      }),
    };
    const svc = new CommunityService({} as never, threads as never, {} as never, {} as never, internal as never);
    return { svc, threads };
  }

  it('opens a thread to an active account', async () => {
    const t = setup({ name: 'Abebe', role: 'educator', status: 'active' });
    await expect(t.svc.openThread(ME, PEER)).resolves.toMatchObject({ thread_id: 't1', peer: { id: PEER, name: 'Abebe' } });
  });

  it.each([
    ['unknown', null],
    ['suspended', { name: 'S', role: 'learner', status: 'suspended' }],
    ['banned', { name: 'B', role: 'learner', status: 'banned' }],
    ['status-less', { name: 'N', role: 'learner' }],
  ])('answers an %s recipient with the same 404 and creates nothing', async (_label, peer) => {
    const t = setup(peer);
    const err = await t.svc.openThread(ME, PEER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toEqual(new NotFoundException('Recipient not found').getResponse());
    expect(t.threads.save).not.toHaveBeenCalled();
  });

  it.each([
    ['a sleeping auth (503 service_waking)', new PeerAsleepError()],
    ['any other failure', new Error('socket hang up')],
  ])('lets %s through instead of a 404, and creates nothing', async (_label, failure) => {
    const t = setup(null, failure);
    await expect(t.svc.openThread(ME, PEER)).rejects.toBe(failure);
    expect(t.threads.save).not.toHaveBeenCalled();
  });
});
