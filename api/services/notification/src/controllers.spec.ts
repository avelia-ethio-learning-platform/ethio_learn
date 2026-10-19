import { randomUUID } from 'crypto';
import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { PeerAsleepError, PeerNotFoundError } from '@ethiopialearn/common';
import { COURSE_CATEGORIES, Role } from '@ethiopialearn/contracts';
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
  // Every followed id is a known account here; NotificationController.follow below covers unknown ones.
  const internal = { get: jest.fn(async () => ({ id: 'x', name: 'Edu', role: 'educator' })) };
  const ctrl = new NotificationController(prefs as never, {} as never, {} as never, {} as never, {} as never, internal as never);
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
      course_updates_email: true,
      progress_emails: true,
      inactivity_emails: true,
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

/** Preference lists are bounded (P2-11), through the pipe the services install at boot. */
describe('PUT notification-preferences body bounds', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const PrefsDto = (Reflect.getMetadata('design:paramtypes', NotificationController.prototype, 'putPrefs') as (new () => object)[])[2];
  const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: PrefsDto });

  it('accepts each category once and refuses a longer list', async () => {
    const all = COURSE_CATEGORIES as string[];
    await expect(check({ new_course_categories: all })).resolves.toBeDefined();
    await expect(check({ new_course_categories: [...all, all[0]] })).rejects.toThrow(BadRequestException);
  });

  it('accepts 500 followed instructors and refuses 501', async () => {
    const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
    await expect(check({ new_course_instructor_ids: ids(500) })).resolves.toBeDefined();
    await expect(check({ new_course_instructor_ids: ids(501) })).rejects.toThrow(BadRequestException);
  });
});

/** The follow button's path (POST notifications/follow/:id) is bounded too, and follows real accounts only. */
describe('NotificationController.follow', () => {
  const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
  function setup(followed: string[] | null, failure: Error | null = null) {
    const prefs = repo(followed ? ({ user_id: 'learner-1', new_course_instructor_ids: followed } as Partial<NotificationPreference>) : null);
    const internal = {
      get: jest.fn(async () => {
        if (failure) throw failure;
        return { id: 'x', name: 'Edu', role: 'educator' };
      }),
    };
    const ctrl = new NotificationController(prefs as never, {} as never, {} as never, {} as never, {} as never, internal as never);
    return { ctrl, prefs, internal };
  }

  it('adds a known instructor', async () => {
    const { ctrl, prefs } = setup(null);
    const id = randomUUID();
    await expect(ctrl.follow(learner, id)).resolves.toEqual({ following: true, instructor_id: id });
    expect(prefs._get()?.new_course_instructor_ids).toEqual([id]);
  });

  it(`refuses a new follow once 500 are followed, and changes nothing`, async () => {
    const full = ids(500);
    const { ctrl, prefs, internal } = setup(full);
    await expect(ctrl.follow(learner, randomUUID())).rejects.toThrow(new BadRequestException('You can follow at most 500 instructors'));
    expect(prefs.save).not.toHaveBeenCalled();
    expect(internal.get).not.toHaveBeenCalled();
    // Re-following someone already on the list is still fine.
    await expect(ctrl.follow(learner, full[0])).resolves.toEqual({ following: true, instructor_id: full[0] });
    expect(prefs._get()?.new_course_instructor_ids).toHaveLength(500);
  });

  it('refuses an id that is no account, and stores nothing', async () => {
    const { ctrl, prefs } = setup([], new PeerNotFoundError('User not found'));
    await expect(ctrl.follow(learner, randomUUID())).rejects.toThrow(new NotFoundException('Instructor not found'));
    expect(prefs.save).not.toHaveBeenCalled();
  });

  it.each([
    ['a sleeping auth (503 service_waking)', new PeerAsleepError()],
    ['any other failure', new Error('socket hang up')],
  ])('lets %s through instead of a 404, and stores nothing', async (_label, failure) => {
    const { ctrl, prefs } = setup([], failure);
    await expect(ctrl.follow(learner, randomUUID())).rejects.toBe(failure);
    expect(prefs.save).not.toHaveBeenCalled();
  });
});
