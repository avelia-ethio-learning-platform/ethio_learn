import { ForbiddenException } from '@nestjs/common';
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
