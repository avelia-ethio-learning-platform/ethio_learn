import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { AssessmentType, Role } from '@ethiopialearn/contracts';
import { AssessmentService } from './assessment.service';

/**
 * Starting an attempt: one transaction per start under an advisory lock per
 * learner and assessment, so concurrent starts end up with one open attempt;
 * the open attempt is reused for every type; max_attempts and the cooldown
 * count finished attempts only, for every type; AI and storage calls happen
 * after commit.
 */
type Row = Record<string, any>;

const learner = { id: 'l1', role: Role.LEARNER, email: 'l@x.et' };
const educator = { id: 'edu1', role: Role.EDUCATOR, email: 'edu1@x.et' };
const LOCK_SQL = /^SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)$/;
const MINUTE = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE);

function matchValue(value: unknown, want: unknown): boolean {
  if (want instanceof FindOperator) {
    if (want.type === 'isNull') return value === null || value === undefined;
    // Not(IsNull()): `.child` is the nested operator.
    if (want.type === 'not') return !matchValue(value, want.child ?? want.value);
    throw new Error(`fake repo: unsupported operator ${want.type}`);
  }
  return value === want;
}

/**
 * The attempts repository, its manager's transactions and the conditional
 * update. `pg_advisory_xact_lock` is a per-key promise mutex held until the
 * transaction callback settles; a callback that throws restores the rows as
 * they were (there is no isolation between concurrent transactions, so race
 * tests must not throw).
 */
function attemptStore(seed: Row[]) {
  const rows = seed;
  const inserted: Row[] = [];
  const lockKeys: unknown[] = [];
  const held = new Map<string, Promise<void>>();
  let clock = Date.now() - 1_000;
  let openTransactions = 0;

  const select = ({ where, order }: { where: Row; order?: Record<string, 'ASC' | 'DESC'> }) => {
    const hits = rows.filter((r) => Object.entries(where).every(([k, v]) => matchValue(r[k], v)));
    const [key, dir] = Object.entries(order ?? {})[0] ?? [];
    if (key) hits.sort((a, b) => (dir === 'DESC' ? -1 : 1) * (a[key]?.getTime() - b[key]?.getTime()));
    return hits;
  };

  const repo: Row = {
    rows,
    inserted,
    lockKeys,
    get openTransactions() {
      return openTransactions;
    },
    findOne: jest.fn(async (q: { where: Row; order?: Record<string, 'ASC' | 'DESC'> }) => select(q)[0] ?? null),
    find: jest.fn(async (q: { where: Row; order?: Record<string, 'ASC' | 'DESC'> }) => select(q)),
    create: jest.fn((r: Row) => ({ proctor_log: [], flagged: false, terminated: false, ...r })),
    save: jest.fn(async (r: Row) => {
      if (!r.id) {
        Object.assign(r, { id: `att-${rows.length + 1}`, created_at: new Date((clock += 1)) });
        rows.push(r);
        inserted.push(structuredClone(r));
      }
      return r;
    }),
    createQueryBuilder: jest.fn(() => {
      const wheres: string[] = [];
      const params: Row = {};
      let patch: Row = {};
      const qb = {
        update: () => qb,
        set: (p: Row) => ((patch = p), qb),
        where: (sql: string, p: Row = {}) => (wheres.push(sql), Object.assign(params, p), qb),
        andWhere: (sql: string, p: Row = {}) => (wheres.push(sql), Object.assign(params, p), qb),
        execute: async () => {
          const guarded = wheres.some((w) => /detail\s*->>\s*'question'\s+IS NULL/i.test(w));
          const hit = rows.filter((r) => Object.values(params).includes(r.id) && (!guarded || r.detail?.question == null));
          hit.forEach((r) => Object.assign(r, patch));
          return { affected: hit.length, raw: [], generatedMaps: [] };
        },
      };
      return qb;
    }),
  };

  repo.manager = {
    transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => {
      const releases: (() => void)[] = [];
      const snapshot = rows.map((r) => [r, structuredClone(r)] as const);
      const m = {
        query: jest.fn(async (sql: string, params: unknown[]) => {
          if (!LOCK_SQL.test(sql)) throw new Error(`fake db: unexpected SQL ${sql}`);
          const key = String(params[0]);
          lockKeys.push(params[0]);
          while (held.has(key)) await held.get(key);
          let release!: () => void;
          held.set(key, new Promise<void>((resolve) => (release = resolve)));
          releases.push(() => {
            held.delete(key);
            release();
          });
          return [{ pg_advisory_xact_lock: '' }];
        }),
        getRepository: () => repo,
      };
      openTransactions += 1;
      try {
        return await work(m);
      } catch (err) {
        // Rollback: every row back to its state at BEGIN, inserts dropped.
        rows.splice(0, rows.length, ...snapshot.map(([row, copy]) => {
          for (const k of Object.keys(row)) delete row[k];
          return Object.assign(row, copy);
        }));
        throw err;
      } finally {
        openTransactions -= 1;
        releases.forEach((release) => release());
      }
    }),
  };
  return repo;
}

function harness(type: AssessmentType, config: Row = {}, prior: Row[] = []) {
  const assessment = { id: 'as1', course_id: 'c1', type, pass_score: 50, config, is_required: true, state: 'live' };
  const attempts = attemptStore(
    prior.map((r, i) => ({
      assessment_id: 'as1',
      learner_id: 'l1',
      enrollment_id: 'en1',
      score: null,
      passed: null,
      detail: {},
      proctor_log: [],
      flagged: false,
      terminated: false,
      created_at: ago(1_000 - i),
      submitted_at: null,
      ...r,
    })),
  );
  const assessments = {
    findOne: jest.fn(async () => assessment),
    create: jest.fn((a: Row) => ({ ...a })),
    save: jest.fn(async (a: Row) => a),
  };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.startsWith('/api/v1/internal/entitlements')) return { entitlement_status: 'active', enrollment_id: 'en1' };
      if (path.startsWith('/api/v1/internal/courses/')) return { title: 'Soil Science', owner_id: 'edu1', status: 'draft' };
      throw new Error(`unexpected internal GET ${path}`);
    }),
  };
  // External calls record whether a transaction was open when they ran.
  const outsideTx: boolean[] = [];
  const storage = {
    getSignedUploadUrl: jest.fn(async (key: string) => {
      outsideTx.push(attempts.openTransactions === 0);
      return { url: `https://r2/put/${key}` };
    }),
    headObject: jest.fn(async () => null as { size: number; content_type: string | null } | null),
    deleteObject: jest.fn(async () => undefined),
  };
  let generated = 0;
  const ai = {
    generateVivaQuestion: jest.fn(async () => {
      outsideTx.push(attempts.openTransactions === 0);
      generated += 1;
      return `Generated question ${generated}?`;
    }),
  };
  const svc = new AssessmentService(assessments as never, attempts as never, { publish: jest.fn() } as never, internal as never, storage as never);
  (svc as unknown as { ai: typeof ai }).ai = ai;
  return { svc, attempts, assessments, storage, ai, outsideTx };
}

const finished = (minutesAgo: number, passed: boolean | null = false): Row => ({
  submitted_at: ago(minutesAgo),
  passed,
  score: passed ? 100 : 0,
});

const bankOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ kind: 'mcq', prompt: `Q${i}`, options: ['A', 'B', 'C'], correct_index: 0, points: 1 }));

let logSpy: jest.SpyInstance;
beforeEach(() => {
  logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('startAttempt(): concurrent starts', () => {
  it('five parallel quiz starts serialise on the lock: one attempt, one insert', async () => {
    const { svc, attempts } = harness(AssessmentType.QUIZ, { questions: bankOf(5), time_limit_minutes: 30 });
    const papers: any[] = await Promise.all(Array.from({ length: 5 }, () => svc.startAttempt(learner, 'as1', { file_size: 100 })));
    expect(new Set(papers.map((p) => p.attempt_id)).size).toBe(1);
    expect(attempts.inserted).toHaveLength(1);
    // One lock per learner and assessment, the key bound as a parameter.
    expect(attempts.lockKeys).toEqual(Array(5).fill('attempt:as1:l1'));
  });

  it('parallel viva starts share one attempt and all show the one stored question', async () => {
    const { svc, attempts } = harness(AssessmentType.AI_VIVA, { topic_context: 'liming' });
    const res: any[] = await Promise.all(Array.from({ length: 3 }, () => svc.startAttempt(learner, 'as1', { file_size: 100 })));
    expect(attempts.inserted).toHaveLength(1);
    expect(new Set(res.map((r) => r.attempt_id)).size).toBe(1);
    const stored = attempts.rows[0].detail.question;
    expect(stored).toMatch(/^Generated question \d\?$/);
    expect(res.map((r) => r.question)).toEqual([stored, stored, stored]);
  });
});

describe('startAttempt(): the open attempt is reused for every type', () => {
  it('viva: a reused attempt that has its question returns it with no AI call and no insert', async () => {
    const { svc, attempts, ai } = harness(AssessmentType.AI_VIVA, {}, [{ id: 'open-1', detail: { question: 'Why lime acidic soil?' } }]);
    const res: any = await svc.startAttempt(learner, 'as1', { file_size: 100 });
    expect(res).toEqual({ attempt_id: 'open-1', type: AssessmentType.AI_VIVA, question: 'Why lime acidic soil?' });
    expect(ai.generateVivaQuestion).not.toHaveBeenCalled();
    expect(attempts.inserted).toHaveLength(0);
  });

  it('viva: an orphaned open attempt without a question gets one, generated after commit and saved', async () => {
    const { svc, attempts, ai, outsideTx } = harness(AssessmentType.AI_VIVA, {}, [{ id: 'orphan', detail: {} }]);
    const res: any = await svc.startAttempt(learner, 'as1', { file_size: 100 });
    expect(ai.generateVivaQuestion).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ attempt_id: 'orphan', type: AssessmentType.AI_VIVA, question: 'Generated question 1?' });
    expect(attempts.rows[0].detail.question).toBe('Generated question 1?');
    expect(attempts.inserted).toHaveLength(0);
    expect(outsideTx).toEqual([true]);
  });

  it('viva: a save that loses to a concurrent start re-reads and returns the stored question', async () => {
    const { svc, attempts, ai } = harness(AssessmentType.AI_VIVA, {}, [{ id: 'orphan', detail: {} }]);
    ai.generateVivaQuestion.mockImplementationOnce(async () => {
      attempts.rows[0].detail = { question: 'The winner’s question?' }; // another start saved first
      return 'The loser’s question?';
    });
    const res: any = await svc.startAttempt(learner, 'as1', { file_size: 100 });
    expect(res.question).toBe('The winner’s question?');
    expect(attempts.rows[0].detail.question).toBe('The winner’s question?');
  });

  it('viva: only the newest open row is reused', async () => {
    const { svc } = harness(AssessmentType.AI_VIVA, {}, [
      { id: 'older', detail: { question: 'Old?' } },
      { id: 'newest', detail: { question: 'New?' } },
    ]);
    const res: any = await svc.startAttempt(learner, 'as1', { file_size: 100 });
    expect(res).toMatchObject({ attempt_id: 'newest', question: 'New?' });
  });

  it('project: a reused attempt presigns its stored key, after commit, with no insert', async () => {
    const { svc, attempts, storage, outsideTx } = harness(AssessmentType.PROJECT, { instructions: 'Map a plot' }, [
      { id: 'open-1', detail: { file_key: 'projects/l1/first-key' } },
    ]);
    const res: any = await svc.startAttempt(learner, 'as1', { file_size: 1234 });
    expect(res).toEqual({
      attempt_id: 'open-1',
      type: AssessmentType.PROJECT,
      instructions: 'Map a plot',
      upload_url: 'https://r2/put/projects/l1/first-key',
      file_key: 'projects/l1/first-key',
      max_bytes: 50 * 1024 * 1024,
    });
    expect(storage.getSignedUploadUrl).toHaveBeenCalledWith('projects/l1/first-key', 'application/octet-stream', 900, 1234);
    expect(attempts.inserted).toHaveLength(0);
    expect(outsideTx).toEqual([true]);
  });

  it('project: a new attempt stores its key at insert and presigns that key', async () => {
    const { svc, attempts, storage } = harness(AssessmentType.PROJECT, {});
    const res: any = await svc.startAttempt(learner, 'as1', { file_size: 2048 });
    expect(attempts.inserted).toHaveLength(1);
    const key = attempts.inserted[0].detail.file_key;
    expect(key).toMatch(/^projects\/l1\/[0-9a-f-]{36}$/);
    expect(res.file_key).toBe(key);
    expect(storage.getSignedUploadUrl).toHaveBeenCalledWith(key, 'application/octet-stream', 900, 2048);
    expect(attempts.save).toHaveBeenCalledTimes(1);
  });

  it('project: a reused open row left without a key gets one, kept for the next start', async () => {
    const { svc, attempts } = harness(AssessmentType.PROJECT, {}, [{ id: 'orphan', detail: {} }]);
    const first: any = await svc.startAttempt(learner, 'as1', { file_size: 10 });
    expect(first.attempt_id).toBe('orphan');
    expect(first.file_key).toMatch(/^projects\/l1\/[0-9a-f-]{36}$/);
    expect(attempts.rows[0].detail.file_key).toBe(first.file_key);
    const second: any = await svc.startAttempt(learner, 'as1', { file_size: 10 });
    expect(second.file_key).toBe(first.file_key);
    expect(attempts.inserted).toHaveLength(0);
  });
});

describe('startAttempt(): project file size', () => {
  const cap = 50 * 1024 * 1024;

  it.each([undefined, {}])('a start without a file size opens the attempt with no upload URL and no storage call (%j)', async (body) => {
    const { svc, attempts, storage } = harness(AssessmentType.PROJECT, { instructions: 'Map a plot' });
    const res: any = await svc.startAttempt(learner, 'as1', body as never);
    expect(attempts.inserted).toHaveLength(1);
    expect(res).toEqual({
      attempt_id: attempts.inserted[0].id,
      type: AssessmentType.PROJECT,
      instructions: 'Map a plot',
      file_key: attempts.inserted[0].detail.file_key,
      max_bytes: cap,
    });
    expect(res).not.toHaveProperty('upload_url');
    expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('a reused attempt started without a size, then with one, gets its URL on the second call', async () => {
    const { svc, storage } = harness(AssessmentType.PROJECT, {}, [{ id: 'open-1', detail: { file_key: 'projects/l1/k' } }]);
    const first: any = await svc.startAttempt(learner, 'as1');
    expect(first).toMatchObject({ attempt_id: 'open-1', file_key: 'projects/l1/k' });
    expect(first.upload_url).toBeUndefined();
    const second: any = await svc.startAttempt(learner, 'as1', { file_size: 77 });
    expect(second.upload_url).toBe('https://r2/put/projects/l1/k');
    expect(storage.getSignedUploadUrl).toHaveBeenCalledTimes(1);
    expect(storage.getSignedUploadUrl).toHaveBeenCalledWith('projects/l1/k', 'application/octet-stream', 900, 77);
  });

  it.each([0, -1, 1.5, '12'])('refuses an invalid size (%j)', async (file_size) => {
    const { svc, attempts, storage } = harness(AssessmentType.PROJECT, {});
    const err = await svc.startAttempt(learner, 'as1', { file_size } as never).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Invalid file size.');
    expect(attempts.manager.transaction).not.toHaveBeenCalled();
    expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses a size above the cap before taking the lock', async () => {
    const { svc, attempts, storage } = harness(AssessmentType.PROJECT, {});
    const err = await svc.startAttempt(learner, 'as1', { file_size: cap + 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Project files can be up to 50 MB.');
    expect(attempts.manager.transaction).not.toHaveBeenCalled();
    expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('signs exactly the cap', async () => {
    const { svc, storage } = harness(AssessmentType.PROJECT, {});
    await svc.startAttempt(learner, 'as1', { file_size: cap });
    expect(storage.getSignedUploadUrl).toHaveBeenCalledWith(expect.any(String), 'application/octet-stream', 900, cap);
  });

  it('a reused attempt gets its stored key signed for the new size', async () => {
    const { svc, storage } = harness(AssessmentType.PROJECT, {}, [{ id: 'open-1', detail: { file_key: 'projects/l1/k' } }]);
    await svc.startAttempt(learner, 'as1', { file_size: 111 });
    await svc.startAttempt(learner, 'as1', { file_size: 222 });
    expect(storage.getSignedUploadUrl).toHaveBeenNthCalledWith(1, 'projects/l1/k', 'application/octet-stream', 900, 111);
    expect(storage.getSignedUploadUrl).toHaveBeenNthCalledWith(2, 'projects/l1/k', 'application/octet-stream', 900, 222);
  });

  it.each([AssessmentType.QUIZ, AssessmentType.AI_VIVA])('%s ignores a body', async (type) => {
    const { svc } = harness(type, { questions: bankOf(3) });
    await expect(svc.startAttempt(learner, 'as1', { file_size: 999_999_999_999 })).resolves.toMatchObject({ type });
  });
});

describe('startAttempt(): limits for every type', () => {
  const cases = [
    [AssessmentType.QUIZ, 'quiz', { questions: bankOf(3) }],
    [AssessmentType.AI_VIVA, 'assessment', {}],
    [AssessmentType.PROJECT, 'assessment', {}],
  ] as const;

  it.each(cases)('%s: three finished attempts use up the default limit', async (type, noun, config) => {
    const { svc, attempts } = harness(type, config, [finished(300), finished(200), finished(100)]);
    const err = await svc.startAttempt(learner, 'as1', { file_size: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe(`You have used all 3 attempts for this ${noun}`);
    expect(attempts.inserted).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/as1.*l1.*attempts used/));
  });

  it.each(cases)('%s: a pass refuses further starts', async (type, noun, config) => {
    const { svc, attempts } = harness(type, { ...config, max_attempts: 10 }, [finished(100, true)]);
    const err = await svc.startAttempt(learner, 'as1', { file_size: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(`You have already passed this ${noun}`);
    expect(attempts.inserted).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/as1.*l1.*already passed/));
  });

  it.each(cases)('%s: a configured cooldown counts from the newest submission', async (type, _noun, config) => {
    // The later-created row was submitted first (two open rows from before the lock).
    const { svc, attempts } = harness(type, { ...config, cooldown_minutes: 60 }, [
      { ...finished(10), created_at: ago(500) },
      { ...finished(100), created_at: ago(400) },
    ]);
    const err = await svc.startAttempt(learner, 'as1', { file_size: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe('Please wait 50 more minute(s) before trying again');
    expect(attempts.inserted).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/as1.*l1.*cooldown/));

    attempts.rows[0].submitted_at = ago(61);
    await expect(svc.startAttempt(learner, 'as1', { file_size: 100 })).resolves.toMatchObject({ attempt_id: 'att-3' });
    expect(attempts.inserted).toHaveLength(1);
  });

  it('a new quiz attempt is inserted with its paper, in one write', async () => {
    const { svc, attempts } = harness(AssessmentType.QUIZ, { questions: bankOf(4), pool_size: 2 });
    const paper: any = await svc.startAttempt(learner, 'as1', { file_size: 100 });
    expect(attempts.save).toHaveBeenCalledTimes(1);
    expect(attempts.inserted[0].detail.order).toHaveLength(2);
    expect(attempts.inserted[0].detail.option_orders).toHaveLength(2);
    expect(paper.questions).toHaveLength(2);
  });
});

describe('startAttempt(): an expired open quiz', () => {
  const quiz = { questions: bankOf(3), time_limit_minutes: 30 };

  it('is closed as late and a new attempt is created', async () => {
    const { svc, attempts } = harness(AssessmentType.QUIZ, quiz, [
      { id: 'expired', created_at: ago(40), detail: { order: [0, 1, 2], option_orders: [null, null, null] } },
    ]);
    const paper: any = await svc.startAttempt(learner, 'as1', { file_size: 100 });
    expect(attempts.inserted).toHaveLength(1);
    expect(paper.attempt_id).toBe(attempts.inserted[0].id);
    expect(attempts.rows[0]).toMatchObject({
      id: 'expired',
      terminated: true,
      passed: false,
      score: 0,
      detail: { order: [0, 1, 2], termination_reason: 'Time limit expired before submission' },
    });
    expect(attempts.rows[0].submitted_at).toBeInstanceOf(Date);
  });

  it('stays closed when the new start is then refused, so the cooldown does not restart', async () => {
    const { svc, attempts } = harness(AssessmentType.QUIZ, { ...quiz, cooldown_minutes: 60 }, [{ id: 'expired', created_at: ago(40) }]);
    const err = await svc.startAttempt(learner, 'as1', { file_size: 100 }).catch((e) => e);
    expect(err.message).toBe('Please wait 60 more minute(s) before trying again');
    const closedAt = attempts.rows[0].submitted_at;
    expect(closedAt).toBeInstanceOf(Date);
    const again = await svc.startAttempt(learner, 'as1', { file_size: 100 }).catch((e) => e);
    expect(again).toBeInstanceOf(ForbiddenException);
    expect(attempts.rows[0].submitted_at).toEqual(closedAt);
    expect(attempts.inserted).toHaveLength(0);
  });

  it('older open rows are neither reused nor counted as finished attempts', async () => {
    const { svc, attempts } = harness(AssessmentType.QUIZ, quiz, [
      finished(300),
      { id: 'dup-older', created_at: ago(150) },
      { id: 'dup-newest', created_at: ago(120) },
    ]);
    // Only the newest open row is closed: 2 finished of 3 allowed, so a new attempt starts.
    const paper: any = await svc.startAttempt(learner, 'as1', { file_size: 100 });
    expect(attempts.inserted).toHaveLength(1);
    expect(paper.attempt_id).toBe(attempts.inserted[0].id);
    expect(attempts.rows.find((r: Row) => r.id === 'dup-newest').submitted_at).toBeInstanceOf(Date);
    expect(attempts.rows.find((r: Row) => r.id === 'dup-older').submitted_at).toBeNull();
  });
});

describe('startAttempt(): an open row older than a finished attempt is stale', () => {
  // Open rows left from before the lock (duplicates of a start the learner then finished).
  const cases = [
    [AssessmentType.QUIZ, { questions: bankOf(3) }],
    [AssessmentType.AI_VIVA, {}],
    [AssessmentType.PROJECT, {}],
  ] as const;
  const stale = { id: 'stale', created_at: ago(200), detail: { question: 'Old?', file_key: 'projects/l1/stale' } };

  it('viva: a stale open row older than a passed attempt is not reused; the pass refuses the start', async () => {
    const { svc, attempts, ai } = harness(AssessmentType.AI_VIVA, {}, [stale, { ...finished(50, true), created_at: ago(100) }]);
    const err = await svc.startAttempt(learner, 'as1', { file_size: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('You have already passed this assessment');
    expect(ai.generateVivaQuestion).not.toHaveBeenCalled();
    expect(attempts.inserted).toHaveLength(0);
    expect(attempts.rows[0]).toMatchObject({ id: 'stale', submitted_at: null });
  });

  it.each(cases)('%s: a stale open row is ignored and a fresh attempt is inserted when limits allow', async (type, config) => {
    const { svc, attempts } = harness(type, config, [stale, { ...finished(50), created_at: ago(100) }]);
    const res: any = await svc.startAttempt(learner, 'as1', { file_size: 100 });
    expect(attempts.inserted).toHaveLength(1);
    expect(res.attempt_id).toBe(attempts.inserted[0].id);
    expect(attempts.rows[0]).toMatchObject({ id: 'stale', submitted_at: null });
  });

  it('timed quiz: an expired stale open row is neither closed nor counted', async () => {
    const { svc, attempts } = harness(AssessmentType.QUIZ, { questions: bankOf(3), time_limit_minutes: 30, max_attempts: 2 }, [
      stale,
      { ...finished(90), created_at: ago(100) },
    ]);
    // 1 finished of 2: closing and counting the stale row would refuse this start.
    const paper: any = await svc.startAttempt(learner, 'as1', { file_size: 100 });
    expect(attempts.inserted).toHaveLength(1);
    expect(paper.attempt_id).toBe(attempts.inserted[0].id);
    expect(attempts.rows[0]).toMatchObject({ id: 'stale', submitted_at: null, terminated: false, passed: null });
  });

  it.each(cases)('%s: an open row newer than every finished attempt is still reused', async (type, config) => {
    const { svc, attempts, ai } = harness(type, config, [
      { ...finished(250), created_at: ago(300) },
      { id: 'current', created_at: ago(5), detail: { question: 'Current?', file_key: 'projects/l1/current' } },
    ]);
    const res: any = await svc.startAttempt(learner, 'as1', { file_size: 100 });
    expect(res.attempt_id).toBe('current');
    expect(attempts.inserted).toHaveLength(0);
    expect(ai.generateVivaQuestion).not.toHaveBeenCalled();
  });
});

describe('create(): attempt limits for every type', () => {
  it.each([AssessmentType.AI_VIVA, AssessmentType.PROJECT])('%s gets the defaults, and configured values are clamped', async (type) => {
    const { svc } = harness(type);
    const make = async (config?: Row) => ((await svc.create(educator, { course_id: 'c1', type, config })) as unknown as Row).config;
    expect(await make({ topic_context: 'liming', instructions: 'Map a plot' })).toEqual({
      topic_context: 'liming',
      instructions: 'Map a plot',
      max_attempts: 3,
      cooldown_minutes: 0,
    });
    expect(await make()).toEqual({ max_attempts: 3, cooldown_minutes: 0 });
    expect(await make({ max_attempts: 99, cooldown_minutes: 99_999 })).toEqual({ max_attempts: 20, cooldown_minutes: 10_080 });
    expect(await make({ max_attempts: 0, cooldown_minutes: -5 })).toEqual({ max_attempts: 3, cooldown_minutes: 0 });
    expect(await make({ max_attempts: 5.4, cooldown_minutes: 30 })).toEqual({ max_attempts: 5, cooldown_minutes: 30 });
  });
});
