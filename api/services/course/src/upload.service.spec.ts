import { BadRequestException, ConflictException, GoneException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { FindOperator } from 'typeorm';
import { UserContext } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { UploadSession } from './upload-session.entity';
import {
  expectedPartSize,
  IDLE_SESSION_MS,
  MAX_OPEN_SESSIONS,
  MAX_PARTS,
  MIN_PART_SIZE,
  missingParts,
  partPlan,
  safeFileName,
  UploadService,
} from './upload.service';
import { MiB } from './upload.dto';
import { VideoKeyService } from './video-key.service';

const GiB = 1024 * MiB;
const educator: UserContext = { id: '11111111-1111-4111-8111-111111111111', role: Role.EDUCATOR, email: 'e@x.et' };
const intruder: UserContext = { id: '22222222-2222-4222-8222-222222222222', role: Role.EDUCATOR, email: 'i@x.et' };
const admin: UserContext = { id: '33333333-3333-4333-8333-333333333333', role: Role.PLATFORM_ADMIN, email: 'a@x.et' };
const LESSON = '44444444-4444-4444-8444-444444444444';
const HOUR = 3600 * 1000;

function noSuchUpload() {
  return Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } });
}

/** Minimal in-memory stand-in for the TypeORM repository calls UploadService makes. */
function fakeRepo() {
  const rows: UploadSession[] = [];
  const matches = (row: any, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v instanceof FindOperator) {
        if (v.type === 'moreThan') return row[k] > v.value;
        if (v.type === 'between') {
          const [low, high] = v.value as unknown as [Date, Date];
          return row[k] >= low && row[k] <= high;
        }
        throw new Error(`fake repo: unsupported operator ${v.type}`);
      }
      return row[k] === v;
    });
  return {
    rows,
    create: (data: Partial<UploadSession>) => ({ ...data }) as UploadSession,
    save: jest.fn(async (entity: UploadSession) => {
      const saved = { ...entity, id: entity.id ?? randomUUID(), created_at: entity.created_at ?? new Date() };
      rows.push(saved);
      return { ...saved };
    }),
    findOne: jest.fn(async ({ where }: any) => {
      const row = rows.find((r) => matches(r, where));
      return row ? { ...row } : null;
    }),
    find: jest.fn(async ({ where, order, take }: any) => {
      const found = rows.filter((r) => matches(r, where));
      const direction = order?.created_at === 'ASC' ? 1 : order?.created_at === 'DESC' ? -1 : 0;
      if (direction) found.sort((a, b) => direction * (a.created_at.getTime() - b.created_at.getTime()));
      return found.slice(0, take ?? found.length).map((r) => ({ ...r }));
    }),
    count: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where)).length),
    update: jest.fn(async (where: any, patch: Partial<UploadSession>) => {
      rows.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, patch));
    }),
  };
}

function seed(repo: ReturnType<typeof fakeRepo>, overrides: Partial<UploadSession> = {}): UploadSession {
  const size = overrides.size ?? 20 * MiB;
  const row = {
    id: randomUUID(),
    owner_id: educator.id,
    kind: 'video',
    lesson_id: null,
    key: `videos/${educator.id}/${randomUUID()}-lecture.mp4`,
    upload_id: 'UPLOAD-ID',
    filename: 'lecture.mp4',
    content_type: 'video/mp4',
    size,
    ...partPlan(size),
    status: 'uploading',
    created_at: new Date(),
    completed_at: null,
    ...overrides,
  } as UploadSession;
  repo.rows.push(row);
  return row;
}

/** Parts exactly as planned for a session (as storage would list them). */
function plannedParts(session: UploadSession) {
  return Array.from({ length: session.part_count }, (_, i) => ({
    part_number: i + 1,
    size: expectedPartSize(session, i + 1),
    etag: `"etag-${i + 1}"`,
  }));
}

describe('multipart part math', () => {
  it('uses 8 MiB parts for ordinary files, with a short last part', () => {
    expect(partPlan(1)).toEqual({ part_size: MIN_PART_SIZE, part_count: 1 });
    expect(partPlan(8 * MiB)).toEqual({ part_size: MIN_PART_SIZE, part_count: 1 });
    expect(partPlan(8 * MiB + 1)).toEqual({ part_size: MIN_PART_SIZE, part_count: 2 });
    expect(partPlan(2 * GiB)).toEqual({ part_size: MIN_PART_SIZE, part_count: 256 });
    const plan = { size: 8 * MiB + 1, ...partPlan(8 * MiB + 1) };
    expect(expectedPartSize(plan, 1)).toBe(8 * MiB);
    expect(expectedPartSize(plan, 2)).toBe(1);
  });

  it('grows the part size (whole MiB) so files that would need >10,000 parts still fit', () => {
    const size = 100 * GiB; // 12,800 parts at 8 MiB
    const plan = partPlan(size);
    expect(plan.part_size).toBe(11 * MiB);
    expect(plan.part_count).toBe(9310);
    expect(plan.part_count).toBeLessThanOrEqual(MAX_PARTS);
  });

  it.each([1, 5 * MiB, 16 * MiB, 80 * GiB + 1, 78.125 * GiB, 200 * GiB - 7])('keeps the invariants for %d bytes', (size) => {
    const plan = { size, ...partPlan(size) };
    expect(plan.part_size % MiB).toBe(0);
    expect(plan.part_size).toBeGreaterThanOrEqual(MIN_PART_SIZE);
    expect(plan.part_count).toBeLessThanOrEqual(MAX_PARTS);
    const last = expectedPartSize(plan, plan.part_count);
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThanOrEqual(plan.part_size);
    expect((plan.part_count - 1) * plan.part_size + last).toBe(size);
  });

  it('reports absent and wrong-sized parts as missing', () => {
    const plan = { size: 20 * MiB, ...partPlan(20 * MiB) }; // 8 + 8 + 4
    expect(missingParts(plan, [{ part_number: 1, size: 8 * MiB }, { part_number: 3, size: 4 * MiB }])).toEqual([2]);
    expect(missingParts(plan, [{ part_number: 1, size: 8 * MiB }, { part_number: 2, size: MiB }, { part_number: 3, size: 4 * MiB }])).toEqual([2]);
    expect(missingParts(plan, [])).toEqual([1, 2, 3]);
    expect(missingParts(plan, [{ part_number: 1, size: 8 * MiB }, { part_number: 2, size: 8 * MiB }, { part_number: 3, size: 4 * MiB }])).toEqual([]);
  });

  it('makes file names key-safe and bounded, keeping the extension', () => {
    expect(safeFileName('My lecture (1).mp4')).toBe('My_lecture__1_.mp4');
    const long = safeFileName(`${'ሀ'.repeat(300)}.mp4`);
    expect(long).toHaveLength(120);
    expect(long.endsWith('.mp4')).toBe(true);
  });
});

describe('UploadService', () => {
  let repo: ReturnType<typeof fakeRepo>;
  let storage: Record<string, jest.Mock>;
  let courses: { assertLessonEditable: jest.Mock; updateLesson: jest.Mock; lessonWithCourse: jest.Mock };
  let service: UploadService;

  beforeEach(() => {
    delete process.env.MAX_VIDEO_UPLOAD_BYTES;
    repo = fakeRepo();
    storage = {
      getSignedUploadUrl: jest.fn(async (key: string) => ({ url: `https://r2.test/${key}?signed`, key })),
      createMultipartUpload: jest.fn().mockResolvedValue('UPLOAD-ID'),
      presignUploadPart: jest.fn(async (_k: string, _u: string, n: number, len: number) => `https://r2.test/part/${n}?len=${len}`),
      listAllParts: jest.fn(),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn(),
    };
    courses = {
      assertLessonEditable: jest.fn().mockResolvedValue({ course: { id: 'c1', created_by: educator.id, owner_id: educator.id } }),
      updateLesson: jest.fn().mockResolvedValue({}),
      lessonWithCourse: jest.fn().mockResolvedValue({ lesson: { video_s3_key: null, pending: null } }),
    };
    service = new UploadService(repo as any, storage as any, courses as any);
  });

  describe('POST /uploads (single PUT)', () => {
    it('signs the exact size into the URL and keys the object under the caller', async () => {
      const res = await service.createSmall(educator, { kind: 'thumbnail', filename: 'cover art.png', content_type: 'image/png', size: 1000 });
      expect(res.key).toMatch(new RegExp(`^thumbnails/${educator.id}/[0-9a-f-]{36}-cover_art\\.png$`));
      expect(storage.getSignedUploadUrl).toHaveBeenCalledWith(res.key, 'image/png', 900, 1000);
    });

    it('enforces the per-kind content type allowlist', async () => {
      await expect(
        service.createSmall(educator, { kind: 'thumbnail', filename: 'x.html', content_type: 'text/html', size: 10 }),
      ).rejects.toThrow('Images must be JPEG, PNG or WebP.');
      await expect(
        service.createSmall(educator, { kind: 'video', filename: 'x.png', content_type: 'image/png', size: 10 }),
      ).rejects.toThrow(/Videos must be MP4/);
    });

    it('enforces the per-kind size limit', async () => {
      await expect(
        service.createSmall(educator, { kind: 'photo', filename: 'p.jpg', content_type: 'image/jpeg', size: 5 * MiB + 1 }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createSmall(educator, { kind: 'video', filename: 'v.mp4', content_type: 'video/mp4', size: 16 * MiB + 1 }),
      ).rejects.toThrow(/resumable uploader/);
      await expect(
        service.createSmall(educator, { kind: 'video', filename: 'v.mp4', content_type: 'video/mp4', size: 16 * MiB }),
      ).resolves.toBeDefined();
    });

    it("keys a short lesson video under the course author's prefix, so an admin's upload can be attached", async () => {
      const res = await service.createSmall(admin, {
        kind: 'video',
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size: 10 * MiB,
        lesson_id: LESSON,
      });
      expect(courses.assertLessonEditable).toHaveBeenCalledWith(admin, LESSON);
      expect(res.key).toMatch(new RegExp(`^videos/${educator.id}/[0-9a-f-]{36}-clip\\.mp4$`));
      // The attach step (PUT /lessons/:id) runs this check; before the fix the key sat under the admin's id and failed it.
      const videoKeys = new VideoKeyService({ headObject: jest.fn().mockResolvedValue({ size: 10 * MiB, content_type: 'video/mp4' }) } as any);
      await expect(videoKeys.assertOwnVideoKey({ created_by: educator.id, owner_id: educator.id }, res.key, [])).resolves.toBeUndefined();
    });

    it('keys a short video with no lesson under the caller, without a course lookup', async () => {
      const res = await service.createSmall(educator, { kind: 'video', filename: 'v.mp4', content_type: 'video/mp4', size: MiB });
      expect(res.key.startsWith(`videos/${educator.id}/`)).toBe(true);
      expect(courses.assertLessonEditable).not.toHaveBeenCalled();
    });

    it('refuses a lesson the caller cannot edit before signing anything', async () => {
      courses.assertLessonEditable.mockRejectedValueOnce(new ConflictException('This course is in review.'));
      await expect(
        service.createSmall(intruder, { kind: 'video', filename: 'v.mp4', content_type: 'video/mp4', size: MiB, lesson_id: LESSON }),
      ).rejects.toThrow('This course is in review.');
      expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
    });

    it('rejects lesson_id on image uploads', async () => {
      await expect(
        service.createSmall(educator, { kind: 'thumbnail', filename: 'c.png', content_type: 'image/png', size: 10, lesson_id: LESSON }),
      ).rejects.toThrow(/lesson_id applies to video uploads only/);
      expect(courses.assertLessonEditable).not.toHaveBeenCalled();
      expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    const dto = { kind: 'video' as const, filename: 'Week 1.mp4', size: 100 * MiB, content_type: 'video/mp4' };

    it('creates a session with a server-generated key and fixed part plan', async () => {
      const res = await service.createMultipart(educator, dto);
      expect(res).toEqual({ session_id: expect.any(String), key: expect.any(String), part_size: 8 * MiB, part_count: 13, size: 100 * MiB });
      expect(res.key).toMatch(new RegExp(`^videos/${educator.id}/[0-9a-f-]{36}-Week_1\\.mp4$`));
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(res.key, 'video/mp4');
      expect(repo.rows[0]).toMatchObject({ owner_id: educator.id, upload_id: 'UPLOAD-ID', status: 'uploading', lesson_id: null });
    });

    it('rejects files over MAX_VIDEO_UPLOAD_BYTES (default 2 GiB) with the limit in the message', async () => {
      await expect(service.createMultipart(educator, { ...dto, size: 2 * GiB + 1 })).rejects.toThrow(/the limit is 2 GB/);
      process.env.MAX_VIDEO_UPLOAD_BYTES = String(50 * MiB);
      await expect(service.createMultipart(educator, dto)).rejects.toThrow(/the limit is 50 MB/);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('checks the lesson is editable before any bytes move', async () => {
      courses.assertLessonEditable.mockRejectedValueOnce(new ConflictException('This course is in review.'));
      await expect(service.createMultipart(educator, { ...dto, lesson_id: LESSON })).rejects.toThrow('This course is in review.');
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it("keys a lesson upload under the course author's prefix (admin uploading for an educator)", async () => {
      const res = await service.createMultipart(admin, { ...dto, lesson_id: LESSON });
      expect(courses.assertLessonEditable).toHaveBeenCalledWith(admin, LESSON);
      expect(res.key.startsWith(`videos/${educator.id}/`)).toBe(true);
      expect(repo.rows[0]).toMatchObject({ owner_id: admin.id, lesson_id: LESSON });
    });

    it(`caps open sessions at ${MAX_OPEN_SESSIONS} per owner, ignoring stale and finished ones`, async () => {
      for (let i = 0; i < MAX_OPEN_SESSIONS - 1; i++) seed(repo);
      seed(repo, { status: 'completed' });
      seed(repo, { status: 'aborted' });
      seed(repo, { created_at: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
      seed(repo, { owner_id: intruder.id });
      await expect(service.createMultipart(educator, dto)).resolves.toBeDefined();
      await expect(service.createMultipart(educator, dto)).rejects.toThrow(/Finish or cancel an unfinished upload first/);
      expect(storage.createMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('allows 10 unfinished uploads and says how to free a slot when all are recent', async () => {
      expect(MAX_OPEN_SESSIONS).toBe(10);
      for (let i = 0; i < MAX_OPEN_SESSIONS; i++) seed(repo, { created_at: new Date(Date.now() - 23 * HOUR) });
      const err = await service.createMultipart(educator, dto).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toMatch(/you have 10 video uploads from the last 24 hours/);
      expect(err.message).toMatch(/"Unfinished upload" note to resume it .* or discard it/);
      expect(err.message).toMatch(/cancelled automatically/);
      // Recent sessions are never reclaimed, even at the cap.
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(repo.rows.every((r) => r.status === 'uploading')).toBe(true);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('at the cap, cancels only as many sessions older than 24 h as needed, oldest first', async () => {
      // Orphans: e.g. started on another device, or created by a retried POST whose response was lost.
      const oldest = seed(repo, { created_at: new Date(Date.now() - 6 * 24 * HOUR), upload_id: 'OLDEST' });
      const older = seed(repo, { created_at: new Date(Date.now() - 30 * HOUR), upload_id: 'OLDER' });
      const idleButKept = seed(repo, { created_at: new Date(Date.now() - IDLE_SESSION_MS - HOUR), upload_id: 'KEPT' });
      for (let i = 0; i < MAX_OPEN_SESSIONS - 2; i++) seed(repo, { created_at: new Date(Date.now() - HOUR) });
      // Past storage's 7-day lifecycle: already out of the count, so reclaiming it would free nothing.
      const expired = seed(repo, { created_at: new Date(Date.now() - 8 * 24 * HOUR), upload_id: 'EXPIRED' });
      seed(repo, { owner_id: intruder.id, created_at: new Date(Date.now() - 6 * 24 * HOUR), upload_id: 'NOT-MINE' });

      await expect(service.createMultipart(educator, dto)).resolves.toMatchObject({ session_id: expect.any(String) });

      expect(storage.abortMultipartUpload.mock.calls).toEqual([
        [oldest.key, 'OLDEST'],
        [older.key, 'OLDER'],
      ]);
      const statusOf = (id: string) => repo.rows.find((r) => r.id === id)!.status;
      expect(statusOf(oldest.id)).toBe('aborted');
      expect(statusOf(older.id)).toBe('aborted');
      expect(statusOf(idleButKept.id)).toBe('uploading');
      expect(statusOf(expired.id)).toBe('uploading');
      expect(repo.rows.filter((r) => r.owner_id === intruder.id).every((r) => r.status === 'uploading')).toBe(true);
    });

    it('below the cap, leaves day-old sessions alone so they can still be resumed', async () => {
      const dayOld = seed(repo, { created_at: new Date(Date.now() - 3 * 24 * HOUR) });
      await expect(service.createMultipart(educator, dto)).resolves.toBeDefined();
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(repo.rows.find((r) => r.id === dayOld.id)!.status).toBe('uploading');
    });

    it('reports a storage outage while making room as retryable and keeps the old session', async () => {
      const idle = seed(repo, { created_at: new Date(Date.now() - 2 * 24 * HOUR) });
      for (let i = 0; i < MAX_OPEN_SESSIONS - 1; i++) seed(repo);
      storage.abortMultipartUpload.mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(service.createMultipart(educator, dto)).rejects.toThrow(ServiceUnavailableException);
      expect(repo.rows.find((r) => r.id === idle.id)!.status).toBe('uploading');
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('aborts the storage upload if the session cannot be saved', async () => {
      repo.save.mockRejectedValueOnce(new Error('db down'));
      await expect(service.createMultipart(educator, dto)).rejects.toThrow('db down');
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(expect.stringMatching(/^videos\//), 'UPLOAD-ID');
    });
  });

  describe('sign parts', () => {
    it('signs each part with its exact expected length (short last part)', async () => {
      const s = seed(repo); // 20 MiB → 8 + 8 + 4
      const before = Date.now();
      const res = await service.signParts(educator, s.id, { part_numbers: [3, 1] });
      expect(res.urls).toEqual([
        { part_number: 3, url: `https://r2.test/part/3?len=${4 * MiB}` },
        { part_number: 1, url: `https://r2.test/part/1?len=${8 * MiB}` },
      ]);
      expect(storage.presignUploadPart).toHaveBeenCalledWith(s.key, 'UPLOAD-ID', 3, 4 * MiB, 7200);
      const expires = new Date(res.expires_at).getTime();
      expect(expires).toBeGreaterThanOrEqual(before + 7200 * 1000);
      expect(expires).toBeLessThanOrEqual(Date.now() + 7200 * 1000);
    });

    it('rejects part numbers beyond the plan', async () => {
      const s = seed(repo);
      await expect(service.signParts(educator, s.id, { part_numbers: [1, 4] })).rejects.toThrow(/has 3 parts; part 4 does not exist/);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });

    it('404s for finished, cancelled and stale sessions', async () => {
      const done = seed(repo, { status: 'completed' });
      const aborted = seed(repo, { status: 'aborted' });
      const stale = seed(repo, { created_at: new Date(Date.now() - 8 * 24 * 3600 * 1000) });
      for (const s of [done, aborted, stale]) {
        await expect(service.signParts(educator, s.id, { part_numbers: [1] })).rejects.toThrow(NotFoundException);
      }
      expect(repo.rows.find((r) => r.id === stale.id)!.status).toBe('aborted');
    });
  });

  describe('owner scoping', () => {
    it("never exposes another user's session (404, no storage calls)", async () => {
      const s = seed(repo);
      await expect(service.status(intruder, s.id)).rejects.toThrow(NotFoundException);
      await expect(service.signParts(intruder, s.id, { part_numbers: [1] })).rejects.toThrow(NotFoundException);
      await expect(service.complete(intruder, s.id, {})).rejects.toThrow(NotFoundException);
      await expect(service.abort(intruder, s.id)).rejects.toThrow(NotFoundException);
      expect(Object.values(storage).every((fn) => fn.mock.calls.length === 0)).toBe(true);
      expect(repo.rows[0].status).toBe('uploading');
    });

    it('404s on a malformed id without querying the database', async () => {
      await expect(service.status(educator, 'not-a-uuid')).rejects.toThrow(NotFoundException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('lists only the caller\'s live sessions, optionally for one lesson', async () => {
      const mine = seed(repo, { lesson_id: LESSON });
      seed(repo);
      seed(repo, { owner_id: intruder.id, lesson_id: LESSON });
      seed(repo, { status: 'completed', lesson_id: LESSON });
      const all = await service.listOpen(educator);
      expect(all).toHaveLength(2);
      const forLesson = await service.listOpen(educator, LESSON);
      expect(forLesson.map((s) => s.session_id)).toEqual([mine.id]);
      expect(forLesson[0]).not.toHaveProperty('upload_id');
      await expect(service.listOpen(educator, 'nope')).rejects.toThrow(BadRequestException);
    });
  });

  describe('status', () => {
    it('reports uploaded parts; only planned-size parts count as uploaded bytes', async () => {
      const s = seed(repo);
      storage.listAllParts.mockResolvedValueOnce([
        { part_number: 1, size: 8 * MiB, etag: '"a"' },
        { part_number: 2, size: MiB, etag: '"b"' }, // interrupted/short: will be re-sent
      ]);
      await expect(service.status(educator, s.id)).resolves.toEqual({
        status: 'uploading',
        size: 20 * MiB,
        part_size: 8 * MiB,
        part_count: 3,
        parts: [
          { part_number: 1, size: 8 * MiB },
          { part_number: 2, size: MiB },
        ],
        uploaded_bytes: 8 * MiB,
      });
    });

    it('marks the session aborted and reports expired when storage no longer has the upload', async () => {
      const s = seed(repo);
      storage.listAllParts.mockRejectedValueOnce(noSuchUpload());
      await expect(service.status(educator, s.id)).resolves.toMatchObject({ status: 'expired', parts: [] });
      expect(repo.rows[0].status).toBe('aborted');
    });

    it('treats sessions older than 7 days as expired without asking storage', async () => {
      const s = seed(repo, { created_at: new Date(Date.now() - 7 * 24 * 3600 * 1000 - 1000) });
      await expect(service.status(educator, s.id)).resolves.toMatchObject({ status: 'expired' });
      expect(storage.listAllParts).not.toHaveBeenCalled();
    });

    it('reports a storage outage as retryable, not as expired', async () => {
      const s = seed(repo);
      storage.listAllParts.mockRejectedValueOnce(new Error('ETIMEDOUT'));
      await expect(service.status(educator, s.id)).rejects.toThrow(ServiceUnavailableException);
      expect(repo.rows[0].status).toBe('uploading');
    });
  });

  describe('complete', () => {
    it('completes with the listed ETags, confirms the size and attaches the lesson', async () => {
      const s = seed(repo, { lesson_id: LESSON });
      storage.listAllParts.mockResolvedValueOnce(plannedParts(s));
      storage.headObject.mockResolvedValueOnce({ size: s.size, content_type: 'video/mp4' });

      await expect(service.complete(educator, s.id, {})).resolves.toEqual({ key: s.key, size: s.size, lesson_updated: true });

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(s.key, 'UPLOAD-ID', [
        { part_number: 1, etag: '"etag-1"' },
        { part_number: 2, etag: '"etag-2"' },
        { part_number: 3, etag: '"etag-3"' },
      ]);
      expect(courses.updateLesson).toHaveBeenCalledWith(educator, LESSON, { video_s3_key: s.key });
      expect(repo.rows[0]).toMatchObject({ status: 'completed', completed_at: expect.any(Date) });
    });

    it('lets the body name the lesson and does not touch any lesson without one', async () => {
      const s = seed(repo);
      storage.listAllParts.mockResolvedValue(plannedParts(s));
      storage.headObject.mockResolvedValue({ size: s.size, content_type: 'video/mp4' });
      await expect(service.complete(educator, s.id, {})).resolves.toMatchObject({ lesson_updated: false });
      expect(courses.updateLesson).not.toHaveBeenCalled();

      const t = seed(repo);
      storage.listAllParts.mockResolvedValue(plannedParts(t));
      await service.complete(educator, t.id, { lesson_id: LESSON });
      expect(courses.updateLesson).toHaveBeenCalledWith(educator, LESSON, { video_s3_key: t.key });
    });

    it('409s with the missing part numbers and leaves the upload open', async () => {
      const s = seed(repo);
      storage.listAllParts.mockResolvedValueOnce([
        { part_number: 1, size: 8 * MiB, etag: '"a"' },
        { part_number: 3, size: 3 * MiB, etag: '"c"' }, // wrong size
      ]);
      const err = await service.complete(educator, s.id, {}).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ missing: [2, 3], message: expect.stringMatching(/2 part\(s\)/) });
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(repo.rows[0].status).toBe('uploading');
    });

    it('leaves stray parts beyond the plan out of the completion', async () => {
      const s = seed(repo);
      storage.listAllParts.mockResolvedValueOnce([...plannedParts(s), { part_number: 4, size: 5, etag: '"x"' }]);
      storage.headObject.mockResolvedValueOnce({ size: s.size, content_type: 'video/mp4' });
      await service.complete(educator, s.id, {});
      expect(storage.completeMultipartUpload.mock.calls[0][2]).toHaveLength(3);
    });

    it('is idempotent: a completed session returns the stored result without storage calls', async () => {
      const s = seed(repo, { status: 'completed', lesson_id: LESSON, completed_at: new Date() });
      courses.lessonWithCourse.mockResolvedValueOnce({ lesson: { video_s3_key: null, pending: { video_s3_key: s.key } } });
      await expect(service.complete(educator, s.id, {})).resolves.toEqual({ key: s.key, size: s.size, lesson_updated: true });
      expect(storage.listAllParts).not.toHaveBeenCalled();
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      // The lesson already holds the key (staged), so no second write that could fail on a locked course.
      expect(courses.updateLesson).not.toHaveBeenCalled();
    });

    it('retries the lesson attach on a completed session when the first attach did not stick', async () => {
      const s = seed(repo, { status: 'completed', lesson_id: LESSON, completed_at: new Date() });
      await service.complete(educator, s.id, {});
      expect(courses.updateLesson).toHaveBeenCalledWith(educator, LESSON, { video_s3_key: s.key });
    });

    it('treats NoSuchUpload on listing as "already completed" when the object has the full size', async () => {
      const s = seed(repo, { lesson_id: LESSON });
      storage.listAllParts.mockRejectedValueOnce(noSuchUpload());
      storage.headObject.mockResolvedValueOnce({ size: s.size, content_type: 'video/mp4' });
      await expect(service.complete(educator, s.id, {})).resolves.toMatchObject({ key: s.key, lesson_updated: true });
      expect(repo.rows[0].status).toBe('completed');
    });

    it('treats NoSuchUpload on completion (lost response) the same way', async () => {
      const s = seed(repo);
      storage.listAllParts.mockResolvedValueOnce(plannedParts(s));
      storage.completeMultipartUpload.mockRejectedValueOnce(noSuchUpload());
      storage.headObject.mockResolvedValueOnce({ size: s.size, content_type: 'video/mp4' });
      await expect(service.complete(educator, s.id, {})).resolves.toMatchObject({ key: s.key });
    });

    it('410s and marks the session aborted when the upload is gone and no full object exists', async () => {
      const s = seed(repo, { lesson_id: LESSON });
      storage.listAllParts.mockRejectedValueOnce(noSuchUpload());
      storage.headObject.mockResolvedValueOnce(null);
      await expect(service.complete(educator, s.id, {})).rejects.toThrow(GoneException);
      expect(repo.rows[0].status).toBe('aborted');
      expect(courses.updateLesson).not.toHaveBeenCalled();
      await expect(service.complete(educator, s.id, {})).rejects.toThrow(GoneException);
    });

    it('refuses to attach when the stored object size differs from the declared size', async () => {
      const s = seed(repo, { lesson_id: LESSON });
      storage.listAllParts.mockResolvedValueOnce(plannedParts(s));
      storage.headObject.mockResolvedValueOnce({ size: s.size - 1, content_type: 'video/mp4' });
      await expect(service.complete(educator, s.id, {})).rejects.toThrow(GoneException);
      expect(courses.updateLesson).not.toHaveBeenCalled();
    });
  });

  describe('abort', () => {
    it('aborts in storage and marks the session', async () => {
      const s = seed(repo);
      await expect(service.abort(educator, s.id)).resolves.toEqual({ aborted: true });
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(s.key, 'UPLOAD-ID');
      expect(repo.rows[0].status).toBe('aborted');
      await expect(service.abort(educator, s.id)).resolves.toEqual({ aborted: true });
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });

    it('will not cancel a finished upload', async () => {
      const s = seed(repo, { status: 'completed' });
      await expect(service.abort(educator, s.id)).rejects.toThrow(ConflictException);
      expect(repo.rows[0].status).toBe('completed');
    });
    it('reports a finished upload when another tab completed it just before the cancel', async () => {
      const s = seed(repo);
      storage.headObject.mockResolvedValueOnce({ size: s.size, content_type: 'video/mp4' });
      await expect(service.abort(educator, s.id)).rejects.toThrow(ConflictException);
      expect(repo.rows[0].status).toBe('uploading');
    });
  });
});
