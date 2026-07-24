import { ForbiddenException } from '@nestjs/common';
import { Role } from '@ethiopialearn/contracts';
import { NotificationController } from './controllers';
import { NotificationPreference } from './entities';

// Minimal in-memory prefs repo: one optional stored row.
function repo(row: Partial<NotificationPreference> | null) {
  let stored = row as NotificationPreference | null;
  return {
    findOne: jest.fn(async () => stored),
    create: jest.fn((p: Partial<NotificationPreference>) => ({ ...p }) as NotificationPreference),
    save: jest.fn(async (p: NotificationPreference) => {
      stored = p;
      return p;
    }),
    _get: () => stored,
  };
}

function controller(prefsRow: Partial<NotificationPreference> | null) {
  const prefs = repo(prefsRow);
  const ctrl = new NotificationController(prefs as never, {} as never, {} as never);
  return { ctrl, prefs };
}

const learner = { id: 'learner-1', role: Role.LEARNER } as never;

describe('NotificationController preferences', () => {
  it('returns defaults when the learner has no stored row', async () => {
    const { ctrl } = controller(null);
    const view = await ctrl.getPrefs(learner, 'learner-1');
    expect(view).toEqual({
      user_id: 'learner-1',
      marketing_opt_out: false,
      new_course_categories: [],
      new_course_instructor_ids: [],
      new_course_email: true,
      new_course_in_app: true,
    });
  });

  it('only touches fields present in the PUT body (partial merge)', async () => {
    const { ctrl } = controller({
      user_id: 'learner-1',
      marketing_opt_out: true,
      new_course_categories: ['design'],
      new_course_instructor_ids: ['edu-9'],
      new_course_email: true,
      new_course_in_app: true,
    });
    const view = await ctrl.putPrefs(learner, 'learner-1', { new_course_email: false } as never);
    expect(view.new_course_email).toBe(false); // changed
    expect(view.new_course_categories).toEqual(['design']); // preserved
    expect(view.new_course_instructor_ids).toEqual(['edu-9']); // preserved
    expect(view.marketing_opt_out).toBe(true); // preserved
  });

  it('de-dupes categories on save', async () => {
    const { ctrl } = controller(null);
    const view = await ctrl.putPrefs(learner, 'learner-1', { new_course_categories: ['design', 'design', 'tech'] } as never);
    expect(view.new_course_categories).toEqual(['design', 'tech']);
  });

  it('rejects editing someone else’s preferences', async () => {
    const { ctrl } = controller(null);
    await expect(ctrl.getPrefs(learner, 'someone-else')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('follow adds the instructor id without duplicating', async () => {
    const { ctrl } = controller({ user_id: 'learner-1', new_course_instructor_ids: ['edu-1'] });
    await ctrl.follow(learner, 'edu-2');
    const again = await ctrl.follow(learner, 'edu-2'); // idempotent
    expect(again).toEqual({ following: true, instructor_id: 'edu-2' });
    const view = await ctrl.getPrefs(learner, 'learner-1');
    expect(view.new_course_instructor_ids).toEqual(['edu-1', 'edu-2']);
  });

  it('unfollow removes the instructor id', async () => {
    const { ctrl } = controller({ user_id: 'learner-1', new_course_instructor_ids: ['edu-1', 'edu-2'] });
    await ctrl.unfollow(learner, 'edu-1');
    const view = await ctrl.getPrefs(learner, 'learner-1');
    expect(view.new_course_instructor_ids).toEqual(['edu-2']);
  });
});
