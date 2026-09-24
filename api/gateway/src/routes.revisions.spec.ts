import { classifyRequest, DEFAULT_LIMITS_PER_MIN } from './rate-policy';
import { resolveRoute } from './routes';

/** [target host, auth mode] for a request, with each service on a distinguishable host. */
function route(method: string, path: string): [string | undefined, string | undefined] {
  const rule = resolveRoute(path);
  if (!rule) return [undefined, undefined];
  const mode = typeof rule.auth === 'function' ? rule.auth(method, path) : rule.auth;
  return [rule.target(), mode];
}

const HOSTS = {
  COURSE_SERVICE_URL: 'course:1',
  OUTCOMES_SERVICE_URL: 'outcomes:1',
  QUALITY_SERVICE_URL: 'quality:1',
  ENROLLMENT_SERVICE_URL: 'enroll:1',
};
const COURSE = 'http://course:1';
const OUTCOMES = 'http://outcomes:1';
const QUALITY = 'http://quality:1';
const ENROLLMENT = 'http://enroll:1';

beforeAll(() => Object.assign(process.env, HOSTS));
afterAll(() => Object.keys(HOSTS).forEach((k) => delete process.env[k]));

describe('routes: staged revisions of live courses', () => {
  it('sends the working copy and the revision lifecycle to the course service behind a JWT', () => {
    expect(route('GET', '/api/v1/courses/c1/working')).toEqual([COURSE, 'jwt']);
    expect(route('GET', '/api/v1/courses/c1/revisions/current/diff')).toEqual([COURSE, 'jwt']);
    for (const action of ['submit', 'withdraw', 'discard']) {
      expect(route('POST', `/api/v1/courses/c1/revisions/${action}`)).toEqual([COURSE, 'jwt']);
    }
  });

  it('does not mistake /revisions for the public course reviews route', () => {
    expect(route('GET', '/api/v1/courses/c1/reviews')).toEqual([QUALITY, 'public']);
    expect(route('GET', '/api/v1/courses/c1/revisions/current/diff')).toEqual([COURSE, 'jwt']);
  });

  it('keeps the learner course page public (it serves the live version only)', () => {
    expect(route('GET', '/api/v1/courses/c1')).toEqual([COURSE, 'public']);
  });

  it('routes stream URLs, including the ?version=pending preview, to the course service behind a JWT', () => {
    // The gateway strips the query string before resolving, so the preview needs no rule of its own.
    expect(route('GET', '/api/v1/lessons/l1/stream-url')).toEqual([COURSE, 'jwt']);
  });

  it('routes institution review of revisions to the course service behind a JWT', () => {
    expect(route('GET', '/api/v1/institution/review-queue')).toEqual([COURSE, 'jwt']);
    expect(route('POST', '/api/v1/institution/courses/c1/decision')).toEqual([COURSE, 'jwt']);
  });
});

describe('routes: QA review items', () => {
  it('sends item reads, claims and decisions to the quality service behind a JWT', () => {
    expect(route('GET', '/api/v1/qa/items/i1')).toEqual([QUALITY, 'jwt']);
    expect(route('POST', '/api/v1/qa/items/i1/claim')).toEqual([QUALITY, 'jwt']);
    expect(route('POST', '/api/v1/qa/items/i1/decision')).toEqual([QUALITY, 'jwt']);
    // Back-compat course-keyed decision.
    expect(route('POST', '/api/v1/qa/courses/c1/decision')).toEqual([QUALITY, 'jwt']);
  });
});

describe('routes: resumable uploads', () => {
  it('sends every upload control-plane call to the course service behind a JWT', () => {
    expect(route('POST', '/api/v1/uploads')).toEqual([COURSE, 'jwt']);
    expect(route('POST', '/api/v1/uploads/multipart')).toEqual([COURSE, 'jwt']);
    expect(route('GET', '/api/v1/uploads/multipart')).toEqual([COURSE, 'jwt']);
    expect(route('GET', '/api/v1/uploads/multipart/s1')).toEqual([COURSE, 'jwt']);
    expect(route('DELETE', '/api/v1/uploads/multipart/s1')).toEqual([COURSE, 'jwt']);
    expect(route('POST', '/api/v1/uploads/multipart/s1/parts')).toEqual([COURSE, 'jwt']);
    expect(route('POST', '/api/v1/uploads/multipart/s1/complete')).toEqual([COURSE, 'jwt']);
  });
});

describe('routes: internal pending assessments', () => {
  it('sends the pending-assessments read to outcomes, not the generic internal course rule', () => {
    expect(route('GET', '/api/v1/internal/courses/c1/pending-assessments')).toEqual([OUTCOMES, 'internal']);
  });

  it('leaves the other internal course reads where they were', () => {
    expect(route('GET', '/api/v1/internal/courses/c1')).toEqual([COURSE, 'internal']);
    expect(route('GET', '/api/v1/internal/courses/c1/lesson-ids')).toEqual([COURSE, 'internal']);
    expect(route('GET', '/api/v1/internal/lessons/l1')).toEqual([COURSE, 'internal']);
    expect(route('GET', '/api/v1/internal/courses/c1/learners')).toEqual([ENROLLMENT, 'internal']);
  });

  it('matches the pending-assessments path exactly', () => {
    expect(route('GET', '/api/v1/internal/courses/c1/pending-assessments/x')).toEqual([COURSE, 'internal']);
  });
});

describe('rate policy: revisions, QA items and uploads', () => {
  it('reads land in the general bucket', () => {
    expect(classifyRequest('GET', '/api/v1/courses/c1/working')).toBe('general');
    expect(classifyRequest('GET', '/api/v1/courses/c1/revisions/current/diff')).toBe('general');
    expect(classifyRequest('GET', '/api/v1/qa/items/i1')).toBe('general');
    expect(classifyRequest('GET', '/api/v1/uploads/multipart')).toBe('general');
    expect(classifyRequest('GET', '/api/v1/uploads/multipart/s1')).toBe('general');
    expect(classifyRequest('GET', '/api/v1/internal/courses/c1/pending-assessments')).toBe('general');
  });

  it('submissions are ordinary writes, not the 5/min AI cap an educator also spends on outlines and quizzes', () => {
    // Resubmitting after coaching must never be blocked by earlier outline generation.
    expect(classifyRequest('POST', '/api/v1/courses/c1/revisions/submit')).toBe('write');
    expect(classifyRequest('POST', '/api/v1/courses/c1/submit')).toBe('write');
  });

  it('the rest of the revision lifecycle and QA decisions are ordinary writes', () => {
    expect(classifyRequest('POST', '/api/v1/courses/c1/revisions/withdraw')).toBe('write');
    expect(classifyRequest('POST', '/api/v1/courses/c1/revisions/discard')).toBe('write');
    expect(classifyRequest('POST', '/api/v1/courses/c1/withdraw')).toBe('write');
    expect(classifyRequest('POST', '/api/v1/qa/items/i1/claim')).toBe('write');
    expect(classifyRequest('POST', '/api/v1/qa/items/i1/decision')).toBe('write');
  });

  it('upload control-plane mutations are ordinary writes', () => {
    expect(classifyRequest('POST', '/api/v1/uploads')).toBe('write');
    expect(classifyRequest('POST', '/api/v1/uploads/multipart')).toBe('write');
    expect(classifyRequest('POST', '/api/v1/uploads/multipart/s1/parts')).toBe('write');
    expect(classifyRequest('POST', '/api/v1/uploads/multipart/s1/complete')).toBe('write');
    expect(classifyRequest('DELETE', '/api/v1/uploads/multipart/s1')).toBe('write');
  });

  // The largest allowed video must upload, and resume, without touching the
  // per-user write cap. Mirrors the course service's partPlan() (8 MiB minimum
  // part, at most 10,000 parts) and the web engine's limits: URL batches of
  // 100, 3 workers, 6 attempts per part and 3 extra complete rounds after a 409.
  describe('write budget of the largest multipart upload', () => {
    const MiB = 1024 * 1024;
    const MAX_VIDEO_BYTES = 2 * 1024 * MiB; // MAX_VIDEO_UPLOAD_BYTES default
    const partSize = Math.max(8 * MiB, Math.ceil(Math.ceil(MAX_VIDEO_BYTES / 10_000) / MiB) * MiB);
    const partCount = Math.ceil(MAX_VIDEO_BYTES / partSize);
    const signingCalls = Math.ceil(partCount / 100);

    it('signs a 2 GiB video in about 3 part-URL requests', () => {
      expect(partSize).toBe(8 * MiB);
      expect(partCount).toBe(256);
      expect(signingCalls).toBe(3);
    });

    it('fits the whole happy path in a small slice of the write cap', () => {
      const create = 1;
      const complete = 1;
      expect(create + signingCalls + complete).toBeLessThanOrEqual(DEFAULT_LIMITS_PER_MIN.write / 10);
    });

    it('stays under the write cap even if every worker re-signs on every attempt in one minute', () => {
      // A resume signs only parts that are missing or whose URL is near expiry,
      // so a full re-sign of every batch is the upper bound. Each worker re-signs
      // its part on each failed attempt, and 409s on complete add more rounds.
      const workers = 3;
      const attemptsPerPart = 6;
      const completeRounds = 1 + 3;
      const worstMinute = 1 + signingCalls + workers * attemptsPerPart + completeRounds;
      expect(worstMinute).toBeLessThan(DEFAULT_LIMITS_PER_MIN.write);
    });
  });
});
