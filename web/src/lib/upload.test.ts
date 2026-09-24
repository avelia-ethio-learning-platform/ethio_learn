import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: vi.fn() };
});

import { api, ApiError } from './api';
import {
  backoffDelay,
  discardResumableUpload,
  fingerprintKey,
  formatBytes,
  formatEta,
  isRecordFresh,
  listResumableUploads,
  missingParts,
  partMath,
  partUrlExpiry,
  putFile,
  RESUME_TTL_MS,
  ResumableUpload,
  sampleHash,
  SpeedMeter,
  UploadCancelledError,
  uploadSmallFile,
  type UploadState,
} from './upload';
import { UploadProgress } from '@/components/UploadProgress';

const MIB = 1024 * 1024;
const PART = 8 * MIB;
const DAY = 24 * 60 * 60 * 1000;

// ---- fake R2 (XMLHttpRequest) ----

type Reply = number | 'hang';

class FakeXhr {
  static reply: (url: string) => Reply = () => 200;
  static log: Array<{ url: string; bytes: number; contentType?: string }> = [];
  static live = new Set<FakeXhr>();

  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  aborted = false;
  private url = '';
  private headers: Record<string, string> = {};
  private size = 0;

  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: Blob) {
    FakeXhr.log.push({ url: this.url, bytes: body.size, contentType: this.headers['Content-Type'] });
    this.size = body.size;
    const reply = FakeXhr.reply(this.url);
    FakeXhr.live.add(this);
    if (reply === 'hang') return;
    setTimeout(() => this.respond(reply), 0);
  }
  /** Finish the request (tests call this directly for one that was left hanging). */
  respond(status: number) {
    if (this.aborted) return;
    FakeXhr.live.delete(this);
    this.upload.onprogress?.({ loaded: this.size });
    this.status = status;
    if (status === 0) this.onerror?.();
    else this.onload?.();
  }
  abort() {
    this.aborted = true;
    FakeXhr.live.delete(this);
    this.onabort?.();
  }
}

// ---- fake API ----

interface Call {
  method: string;
  path: string;
  body?: any;
}

const apiMock = vi.mocked(api);
let calls: Call[] = [];
let routes: Record<string, (call: Call) => unknown> = {};
let sessionSeq = 0;

function routeFor(call: Call): (call: Call) => unknown {
  const generic = `${call.method} ${call.path.replace(/\/multipart\/[^/]+/, '/multipart/:id')}`;
  const exact = `${call.method} ${call.path}`;
  const handler = routes[exact] ?? routes[generic];
  if (!handler) throw new Error(`unexpected API call ${exact}`);
  return handler;
}

function defaultRoutes(): Record<string, (call: Call) => unknown> {
  return {
    'POST /uploads/multipart': (c) => ({
      session_id: `s${++sessionSeq}`,
      key: `videos/u1/0000-${c.body.filename}`,
      part_size: PART,
      part_count: partMath(c.body.size, PART).partCount,
      size: c.body.size,
    }),
    'POST /uploads/multipart/:id/parts': (c) => {
      const id = c.path.split('/')[3];
      return {
        urls: c.body.part_numbers.map((n: number) => ({ part_number: n, url: `https://r2.test/${id}/part-${n}` })),
        expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      };
    },
    'GET /uploads/multipart/:id': () => ({ status: 'uploading', parts: [] }),
    'POST /uploads/multipart/:id/complete': (c) => ({ key: `videos/u1/${c.path.split('/')[3]}`, size: 17 * MIB, lesson_updated: true }),
    'DELETE /uploads/multipart/:id': () => ({ aborted: true }),
    'POST /uploads': (c) => ({ upload_url: 'https://r2.test/single', key: `${c.body.kind}s/u1/0000-${c.body.filename}` }),
  };
}

function callsTo(method: string, pathPattern: RegExp): Call[] {
  return calls.filter((c) => c.method === method && pathPattern.test(c.path));
}

function videoFile(size = 17 * MIB, name = 'lecture.mp4'): File {
  const bytes = new Uint8Array(size);
  bytes[0] = size % 251; // make different sizes hash differently
  return new File([bytes], name, { type: 'video/mp4', lastModified: 1_700_000_000_000 });
}

function collect() {
  const states: UploadState[] = [];
  return { states, onState: (s: UploadState) => states.push(s), last: () => states[states.length - 1] };
}

let online = true;

beforeEach(() => {
  calls = [];
  sessionSeq = 0;
  routes = defaultRoutes();
  online = true;
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const call = { method: options.method ?? 'GET', path, body: options.body };
    calls.push(call);
    return routeFor(call)(call) as any;
  });
  FakeXhr.reply = () => 200;
  FakeXhr.log = [];
  FakeXhr.live = new Set();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------

describe('partMath', () => {
  it('splits into fixed parts with a shorter last part', () => {
    const m = partMath(17 * MIB, PART);
    expect(m.partCount).toBe(3);
    expect(m.lastPartSize).toBe(MIB);
    expect([1, 2, 3].map(m.partLength)).toEqual([PART, PART, MIB]);
    expect(m.partRange(3)).toEqual([16 * MIB, 17 * MIB]);
  });

  it('handles an exact multiple and a file smaller than one part', () => {
    expect(partMath(16 * MIB, PART)).toMatchObject({ partCount: 2, lastPartSize: PART });
    expect(partMath(3 * MIB, PART)).toMatchObject({ partCount: 1, lastPartSize: 3 * MIB });
    expect(partMath(3 * MIB, PART).partRange(1)).toEqual([0, 3 * MIB]);
  });
});

describe('missingParts', () => {
  const session = { size: 25 * MIB, part_size: PART }; // 4 parts: 8, 8, 8, 1

  it('treats a part as done only at its exact expected size', () => {
    const listed = [
      { part_number: 1, size: PART },
      { part_number: 2, size: PART - 1 }, // truncated → re-upload
      { part_number: 4, size: MIB },
      { part_number: 9, size: PART }, // out of range → ignored
    ];
    expect(missingParts(session, listed)).toEqual([2, 3]);
  });

  it('returns every part for an empty listing and none when complete', () => {
    expect(missingParts(session, [])).toEqual([1, 2, 3, 4]);
    expect(
      missingParts(session, [
        { part_number: 1, size: PART },
        { part_number: 2, size: PART },
        { part_number: 3, size: PART },
        { part_number: 4, size: MIB },
      ]),
    ).toEqual([]);
  });
});

describe('backoffDelay', () => {
  it('doubles from 1 s and caps at 30 s', () => {
    const noJitter = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 10].map((n) => backoffDelay(n, noJitter))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('keeps jitter within ±30%', () => {
    expect(backoffDelay(0, () => 0)).toBe(700);
    expect(backoffDelay(0, () => 1)).toBe(1300);
    expect(backoffDelay(9, () => 0)).toBe(21000);
    for (let i = 0; i < 200; i++) {
      const attempt = i % 8;
      const base = Math.min(30000, 1000 * 2 ** attempt);
      const d = backoffDelay(attempt);
      expect(d).toBeGreaterThanOrEqual(base * 0.7);
      expect(d).toBeLessThanOrEqual(base * 1.3);
    }
  });
});

describe('fingerprintKey', () => {
  const file = { name: 'lecture 3.mp4', size: 123, lastModified: 42 };
  it('keys by user, kind, lesson and file identity', () => {
    expect(fingerprintKey('u1', 'video', 'l1', file)).toBe('el_upload:v1:u1:video|l1|lecture 3.mp4|123|42');
    expect(fingerprintKey('u1', 'video', undefined, file)).toBe('el_upload:v1:u1:video|new|lecture 3.mp4|123|42');
  });
});

describe('resume records', () => {
  function seed(key: string, overrides: Record<string, unknown> = {}) {
    localStorage.setItem(
      key,
      JSON.stringify({
        session_id: 'old',
        key: 'videos/u1/x',
        part_size: PART,
        part_count: 3,
        size: 17 * MIB,
        lesson_id: 'l1',
        course_id: 'c1',
        file_name: 'lecture.mp4',
        created_at: Date.now(),
        sample_hash: '',
        percent: 62,
        ...overrides,
      }),
    );
  }

  it('expires records after 6.5 days', () => {
    const now = Date.now();
    expect(RESUME_TTL_MS).toBe(6.5 * DAY);
    expect(isRecordFresh({ created_at: now - 6.4 * DAY }, now)).toBe(true);
    expect(isRecordFresh({ created_at: now - 6.6 * DAY }, now)).toBe(false);
  });

  it('lists fresh records for the user, filtered by course/lesson, and prunes expired ones', () => {
    seed('el_upload:v1:u1:video|l1|lecture.mp4|1|1');
    seed('el_upload:v1:u1:video|l2|other.mp4|1|1', { lesson_id: 'l2', course_id: 'c2', file_name: 'other.mp4' });
    seed('el_upload:v1:u1:video|l3|old.mp4|1|1', { lesson_id: 'l3', created_at: Date.now() - 6.6 * DAY });
    seed('el_upload:v1:u2:video|l1|theirs.mp4|1|1');
    localStorage.setItem('el_upload:v1:u1:video|l4|junk|1|1', '{not json');

    const mine = listResumableUploads('u1', { courseId: 'c1' });
    expect(mine).toEqual([
      expect.objectContaining({ fileName: 'lecture.mp4', lessonId: 'l1', courseId: 'c1', percent: 62, size: 17 * MIB }),
    ]);
    expect(listResumableUploads('u1', { lessonId: 'l2' }).map((r) => r.fileName)).toEqual(['other.mp4']);
    expect(localStorage.getItem('el_upload:v1:u1:video|l3|old.mp4|1|1')).toBeNull();
    expect(localStorage.getItem('el_upload:v1:u1:video|l4|junk|1|1')).toBeNull();
    expect(localStorage.getItem('el_upload:v1:u2:video|l1|theirs.mp4|1|1')).not.toBeNull();
  });

  it('discard removes the record and aborts the session, even when the DELETE fails', async () => {
    seed('k1');
    routes['DELETE /uploads/multipart/:id'] = () => {
      throw new ApiError(503, 'down');
    };
    await discardResumableUpload('k1');
    expect(localStorage.getItem('k1')).toBeNull();
    expect(callsTo('DELETE', /^\/uploads\/multipart\/old$/)).toHaveLength(1);
  });
});

describe('formatting and speed', () => {
  it('formats bytes and ETA', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(62.5 * MIB)).toBe('62.5 MB');
    expect(formatBytes(1.5 * 1024 * MIB)).toBe('1.50 GB');
    expect(formatEta(null)).toBe('—');
    expect(formatEta(42)).toBe('42 s left');
    expect(formatEta(300)).toBe('5 min left');
    expect(formatEta(3900)).toBe('1 h 5 min left');
  });

  it('reports no ETA until three samples, then an EMA-based one', () => {
    const m = new SpeedMeter();
    m.sample(0, 0);
    m.sample(MIB, 1000);
    m.sample(2 * MIB, 2000);
    expect(m.speedBps).toBe(MIB);
    expect(m.etaSeconds(10 * MIB)).toBeNull();
    m.sample(3 * MIB, 3000);
    expect(m.etaSeconds(10 * MIB)).toBe(10);
  });
});

// ---------------------------------------------------------------------------

describe('ResumableUpload — multipart', () => {
  it('uploads every part through batched signed URLs and completes with the lesson id', async () => {
    const file = videoFile();
    const { states, onState, last } = collect();
    const result = await new ResumableUpload({ file, kind: 'video', userId: 'u1', lessonId: 'l1', courseId: 'c1', onState }).start();

    expect(result).toEqual({ key: 'videos/u1/s1', size: 17 * MIB, lesson_updated: true });
    expect(callsTo('POST', /^\/uploads\/multipart$/)[0].body).toEqual({
      kind: 'video',
      filename: 'lecture.mp4',
      size: 17 * MIB,
      content_type: 'video/mp4',
      lesson_id: 'l1',
    });
    expect(callsTo('POST', /\/parts$/).map((c) => c.body.part_numbers)).toEqual([[1, 2, 3]]);
    expect(FakeXhr.log.map((x) => x.bytes).sort((a, b) => a - b)).toEqual([MIB, PART, PART]);
    // Parts carry no Content-Type: it was fixed server-side at CreateMultipartUpload.
    expect(FakeXhr.log.every((x) => x.contentType === undefined)).toBe(true);
    expect(callsTo('POST', /\/complete$/)[0].body).toEqual({ lesson_id: 'l1' });
    expect(states[0].phase).toBe('preparing');
    expect(last()).toMatchObject({ phase: 'done', percent: 100, loaded: 17 * MIB });
    expect(listResumableUploads('u1')).toEqual([]);
  });

  it('resumes from a saved record, uploading only the parts the server lacks', async () => {
    const file = videoFile();
    localStorage.setItem(
      fingerprintKey('u1', 'video', 'l1', file),
      JSON.stringify({
        session_id: 'old',
        key: 'videos/u1/old-lecture.mp4',
        part_size: PART,
        part_count: 3,
        size: file.size,
        lesson_id: 'l1',
        course_id: 'c1',
        file_name: file.name,
        created_at: Date.now() - DAY,
        sample_hash: await sampleHash(file),
        percent: 33,
      }),
    );
    routes['GET /uploads/multipart/old'] = () => ({ status: 'uploading', parts: [{ part_number: 1, size: PART }] });

    const { onState } = collect();
    const result = await new ResumableUpload({ file, kind: 'video', userId: 'u1', lessonId: 'l1', courseId: 'c1', onState }).start();

    expect(result.lesson_updated).toBe(true);
    expect(callsTo('POST', /^\/uploads\/multipart$/)).toHaveLength(0);
    expect(callsTo('POST', /\/old\/parts$/).map((c) => c.body.part_numbers)).toEqual([[2, 3]]);
    expect(FakeXhr.log.map((x) => x.url).sort()).toEqual(['https://r2.test/old/part-2', 'https://r2.test/old/part-3']);
    expect(callsTo('POST', /\/old\/complete$/)).toHaveLength(1);
  });

  it('ignores a record whose sampled bytes differ and starts a new session', async () => {
    const file = videoFile();
    const key = fingerprintKey('u1', 'video', 'l1', file);
    localStorage.setItem(
      key,
      JSON.stringify({ session_id: 'other', key: 'k', part_size: PART, part_count: 3, size: file.size, lesson_id: 'l1', course_id: 'c1', file_name: file.name, created_at: Date.now(), sample_hash: 'not-this-file', percent: 50 }),
    );
    const { onState } = collect();
    await new ResumableUpload({ file, kind: 'video', userId: 'u1', lessonId: 'l1', courseId: 'c1', onState }).start();
    expect(callsTo('DELETE', /\/other$/)).toHaveLength(1);
    expect(callsTo('POST', /^\/uploads\/multipart$/)).toHaveLength(1);
    expect(FakeXhr.log).toHaveLength(3);
  });

  it('uploads parts the server reports missing when complete returns 409, then completes', async () => {
    let completes = 0;
    routes['POST /uploads/multipart/:id/complete'] = () => {
      if (++completes === 1) throw new ApiError(409, 'Some parts are missing');
      return { key: 'videos/u1/s1', size: 17 * MIB, lesson_updated: false };
    };
    routes['GET /uploads/multipart/:id'] = () => ({ status: 'uploading', parts: [{ part_number: 1, size: PART }, { part_number: 2, size: PART }] });

    const { states, onState } = collect();
    const result = await new ResumableUpload({ file: videoFile(), kind: 'video', userId: 'u1', onState }).start();
    expect(result.key).toBe('videos/u1/s1');
    expect(FakeXhr.log.filter((x) => x.url.endsWith('part-3'))).toHaveLength(2);
    expect(completes).toBe(2);
    // The 409 proved the server had not finished, so Cancel is allowed again while part 3 is re-sent.
    expect(states.some((s) => s.phase === 'finalizing' && s.committed)).toBe(true);
    expect(states.filter((s) => s.phase === 'uploading' && s.committed)).toEqual([]);
  });

  it('surfaces a 409 that is not about missing parts and keeps the record for a later resume', async () => {
    routes['POST /uploads/multipart/:id/complete'] = () => {
      throw new ApiError(409, 'This course is in review. Withdraw it to make changes.');
    };
    routes['GET /uploads/multipart/:id'] = () => ({
      status: 'uploading',
      parts: [{ part_number: 1, size: PART }, { part_number: 2, size: PART }, { part_number: 3, size: MIB }],
    });
    const { onState, last } = collect();
    const upload = new ResumableUpload({ file: videoFile(), kind: 'video', userId: 'u1', lessonId: 'l1', courseId: 'c1', onState });
    await expect(upload.start()).rejects.toThrow('This course is in review. Withdraw it to make changes.');
    expect(last()).toMatchObject({ phase: 'failed', error: 'This course is in review. Withdraw it to make changes.' });
    expect(listResumableUploads('u1', { courseId: 'c1' })).toEqual([expect.objectContaining({ fileName: 'lecture.mp4', percent: 100 })]);
  });

  it('restarts with a new session when R2 answers 404 (session gone)', async () => {
    FakeXhr.reply = (url) => (url === 'https://r2.test/s1/part-2' ? 404 : 200);
    routes['GET /uploads/multipart/s1'] = () => {
      throw new ApiError(404, 'Upload not found');
    };
    const { onState } = collect();
    const result = await new ResumableUpload({ file: videoFile(), kind: 'video', userId: 'u1', onState }).start();
    expect(result.key).toBe('videos/u1/s2');
    expect(callsTo('POST', /^\/uploads\/multipart$/)).toHaveLength(2);
    expect(FakeXhr.log.filter((x) => x.url.includes('/s2/'))).toHaveLength(3);
  });

  it('pause aborts in-flight PUTs; resume re-checks the server and finishes', async () => {
    FakeXhr.reply = () => 'hang';
    const { onState, last } = collect();
    const upload = new ResumableUpload({ file: videoFile(), kind: 'video', userId: 'u1', onState });
    const done = upload.start();
    await vi.waitFor(() => expect(FakeXhr.live.size).toBe(3));

    upload.pause();
    expect(last()).toMatchObject({ phase: 'paused', loaded: 0 });
    expect(FakeXhr.live.size).toBe(0);
    const statusChecks = callsTo('GET', /\/s1$/).length;

    FakeXhr.reply = () => 200;
    upload.resume();
    await expect(done).resolves.toMatchObject({ key: 'videos/u1/s1' });
    expect(callsTo('GET', /\/s1$/).length).toBe(statusChecks + 1);
    expect(callsTo('POST', /^\/uploads\/multipart$/)).toHaveLength(1);
    expect(last().phase).toBe('done');
  });

  it('pausing and resuming while the session is being created opens only one session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const create = routes['POST /uploads/multipart'];
    routes['POST /uploads/multipart'] = async (c) => {
      await gate;
      return create(c);
    };
    const { onState, last } = collect();
    const upload = new ResumableUpload({ file: videoFile(), kind: 'video', userId: 'u1', onState });
    const done = upload.start();
    await vi.waitFor(() => expect(callsTo('POST', /^\/uploads\/multipart$/)).toHaveLength(1));

    upload.pause();
    expect(last().phase).toBe('paused');
    upload.resume();
    release();
    await expect(done).resolves.toMatchObject({ key: 'videos/u1/s1' });
    expect(callsTo('POST', /^\/uploads\/multipart$/)).toHaveLength(1);
    expect(FakeXhr.log).toHaveLength(3);
  });

  it('cancel aborts the session, clears the record and rejects start()', async () => {
    FakeXhr.reply = () => 'hang';
    const { onState, last } = collect();
    const upload = new ResumableUpload({ file: videoFile(), kind: 'video', userId: 'u1', lessonId: 'l1', onState });
    const outcome = expect(upload.start()).rejects.toBeInstanceOf(UploadCancelledError);
    await vi.waitFor(() => expect(FakeXhr.live.size).toBe(3));
    const key = fingerprintKey('u1', 'video', 'l1', videoFile());
    expect(localStorage.getItem(key)).not.toBeNull();

    await upload.cancel();
    await outcome;
    expect(callsTo('DELETE', /\/s1$/)).toHaveLength(1);
    expect(localStorage.getItem(key)).toBeNull();
    expect(listResumableUploads('u1')).toEqual([]);
    expect(FakeXhr.live.size).toBe(0);
    expect(last()).toMatchObject({ phase: 'failed', error: 'Upload cancelled' });
  });
});

describe('ResumableUpload — multipart edge cases', () => {
  it('pauses (never silently fails) after 6 attempts and continues from the server state on Resume', async () => {
    // No crypto.subtle: the sample hash would resolve outside the fake clock.
    vi.stubGlobal('crypto', {});
    vi.useFakeTimers();
    FakeXhr.reply = () => 0;
    const { onState, last } = collect();
    const upload = new ResumableUpload({ file: videoFile(), kind: 'video', userId: 'u1', onState });
    let settled = false;
    const done = upload.start().finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(last()).toMatchObject({ phase: 'paused', error: 'Connection problem — press Resume to try again.' });
    expect(settled).toBe(false);

    FakeXhr.reply = () => 200;
    upload.resume();
    await vi.advanceTimersByTimeAsync(100);
    await expect(done).resolves.toMatchObject({ key: 'videos/u1/s1' });
  });

  it('cannot be cancelled or paused once complete is sent, and still finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const complete = routes['POST /uploads/multipart/:id/complete'];
    routes['POST /uploads/multipart/:id/complete'] = async (c) => {
      await gate;
      return complete(c);
    };
    const { onState, last } = collect();
    const upload = new ResumableUpload({ file: videoFile(), kind: 'video', userId: 'u1', lessonId: 'l1', courseId: 'c1', onState });
    const done = upload.start();
    await vi.waitFor(() => expect(last().phase).toBe('finalizing'));
    expect(last().committed).toBe(true);

    // The server may already be attaching the video: a DELETE now could not undo that.
    await upload.cancel();
    upload.pause();
    expect(last().phase).toBe('finalizing');
    expect(callsTo('DELETE', /./)).toEqual([]);

    release();
    await expect(done).resolves.toMatchObject({ key: 'videos/u1/s1', lesson_updated: true });
    expect(last().phase).toBe('done');
  });

  it('keeps "finalizing" with a countdown while complete is retried, so no Pause is offered', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // 700 ms first backoff
    let completes = 0;
    const complete = routes['POST /uploads/multipart/:id/complete'];
    routes['POST /uploads/multipart/:id/complete'] = (c) => {
      if (++completes === 1) throw new ApiError(503, 'Service Unavailable');
      return complete(c);
    };
    const { states, onState } = collect();
    await new ResumableUpload({ file: videoFile(), kind: 'video', userId: 'u1', onState }).start();
    const retrying = states.filter((s) => s.retryInSeconds !== undefined);
    expect(retrying.length).toBeGreaterThan(0);
    expect(retrying.every((s) => s.phase === 'finalizing' && s.committed)).toBe(true);
    expect(states.some((s) => s.phase === 'reconnecting')).toBe(false);
    expect(completes).toBe(2);
  });

  it('a sign request that outlives a pause cannot abort the resumed run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sign = routes['POST /uploads/multipart/:id/parts'];
    let signs = 0;
    routes['POST /uploads/multipart/:id/parts'] = async (c) => {
      if (++signs === 1) await gate; // the first batch sign hangs (slow network)
      return sign(c);
    };
    FakeXhr.reply = () => 'hang';
    const { onState, last } = collect();
    const upload = new ResumableUpload({ file: videoFile(), kind: 'video', userId: 'u1', onState });
    const done = upload.start();
    // Every worker of the first run is now waiting on that sign request.
    await vi.waitFor(() => expect(signs).toBe(1));

    upload.pause();
    upload.resume();
    await vi.waitFor(() => expect(FakeXhr.live.size).toBe(3));
    const resumed = Array.from(FakeXhr.live);

    release(); // the stale request returns; its workers find their run stopped
    await new Promise((r) => setTimeout(r, 20));
    expect(resumed.map((x) => x.aborted)).toEqual([false, false, false]);
    expect(last().phase).not.toBe('failed');

    resumed.forEach((x) => x.respond(200));
    await expect(done).resolves.toMatchObject({ key: 'videos/u1/s1' });
    expect(callsTo('POST', /^\/uploads\/multipart$/)).toHaveLength(1);
  });

  it('signs a batch once even when the device clock is hours ahead of the server', async () => {
    const realNow = Date.now.bind(Date);
    const H = 60 * 60 * 1000;
    routes['POST /uploads/multipart'] = (c) => ({ session_id: 's1', key: 'videos/u1/k', part_size: MIB, part_count: 17, size: c.body.size });
    // The server stamps expiry on its own (correct) clock.
    routes['POST /uploads/multipart/:id/parts'] = (c) => ({
      urls: c.body.part_numbers.map((n: number) => ({ part_number: n, url: `https://r2.test/s1/part-${n}` })),
      expires_at: new Date(realNow() + 2 * H).toISOString(),
    });
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 3 * H);
    const { onState } = collect();
    await new ResumableUpload({ file: videoFile(), kind: 'video', userId: 'u1', onState }).start();
    expect(FakeXhr.log).toHaveLength(17);
    // Before: every part looked expired, so each one cost its own sign request.
    expect(callsTo('POST', /\/parts$/)).toHaveLength(1);
  });
});

describe('partUrlExpiry', () => {
  const H = 60 * 60 * 1000;
  const sent = 1_800_000_000_000;
  const received = sent + 500;
  const at = (t: number) => new Date(t).toISOString();

  it('uses the lifetime the server stamp implies when the clocks agree', () => {
    expect(partUrlExpiry({ expires_at: at(sent + 2 * H) }, sent, received)).toBe(sent + 2 * H - 500);
    // A device an hour ahead just refreshes early.
    expect(partUrlExpiry({ expires_at: at(sent - H + 2 * H) }, sent, received)).toBe(sent + H - 500);
  });

  it('falls back to the 2 h lifetime from the request time when the device clock is far off', () => {
    // Device 3 h ahead: the stamp looks an hour old.
    expect(partUrlExpiry({ expires_at: at(sent - 3 * H + 2 * H) }, sent, received)).toBe(sent + 2 * H);
    // Device 3 h behind: the stamp looks 5 h away; R2 still rejects the URL after 2 h.
    expect(partUrlExpiry({ expires_at: at(sent + 3 * H + 2 * H) }, sent, received)).toBe(sent + 2 * H);
  });

  it('prefers an explicit expires_in and stays short for an unreadable stamp', () => {
    expect(partUrlExpiry({ expires_in: 3600, expires_at: at(sent + 9 * H) }, sent, received)).toBe(sent + H);
    expect(partUrlExpiry({ expires_at: 'soon' }, sent, received)).toBe(sent + 30 * 60 * 1000);
  });
});

describe('uploads running in this tab', () => {
  it('are not listed as unfinished, and discarding one cancels it instead of restarting it', async () => {
    FakeXhr.reply = () => 'hang';
    const file = videoFile();
    const key = fingerprintKey('u1', 'video', 'l1', file);
    const { onState, last } = collect();
    const upload = new ResumableUpload({ file, kind: 'video', userId: 'u1', lessonId: 'l1', courseId: 'c1', onState });
    const outcome = expect(upload.start()).rejects.toBeInstanceOf(UploadCancelledError);
    await vi.waitFor(() => expect(FakeXhr.live.size).toBe(3));

    expect(localStorage.getItem(key)).not.toBeNull();
    expect(listResumableUploads('u1', { courseId: 'c1' })).toEqual([]);

    await discardResumableUpload(key);
    await outcome;
    expect(callsTo('DELETE', /\/s1$/)).toHaveLength(1);
    expect(localStorage.getItem(key)).toBeNull();
    expect(FakeXhr.live.size).toBe(0);
    expect(callsTo('POST', /^\/uploads\/multipart$/)).toHaveLength(1);
    expect(last()).toMatchObject({ phase: 'failed', error: 'Upload cancelled' });
  });

  it('stops instead of re-uploading from zero when another tab discarded it', async () => {
    const file = videoFile();
    const key = fingerprintKey('u1', 'video', 'l1', file);
    FakeXhr.reply = () => 'hang';
    routes['GET /uploads/multipart/:id'] = () => ({ status: 'expired', parts: [] });
    const { onState, last } = collect();
    const upload = new ResumableUpload({ file, kind: 'video', userId: 'u1', lessonId: 'l1', courseId: 'c1', onState });
    const done = upload.start();
    await vi.waitFor(() => expect(FakeXhr.live.size).toBe(3));

    // The other tab's Discard: the record is gone and the session aborted, so R2 answers 404.
    localStorage.removeItem(key);
    Array.from(FakeXhr.live)[0].respond(404);

    await expect(done).rejects.toThrow(/discarded in another tab/);
    expect(callsTo('POST', /^\/uploads\/multipart$/)).toHaveLength(1);
    expect(last().phase).toBe('failed');
  });
});

describe('ResumableUpload — single PUT', () => {
  it('sends thumbnails through POST /uploads with size and a Content-Type PUT', async () => {
    const file = new File([new Uint8Array(2048)], 'cover.png', { type: 'image/png' });
    const states: UploadState[] = [];
    const result = await uploadSmallFile(file, 'thumbnail', (s) => states.push(s));
    expect(result).toEqual({ key: 'thumbnails/u1/0000-cover.png', size: 2048, lesson_updated: false });
    expect(callsTo('POST', /^\/uploads$/)[0].body).toEqual({ kind: 'thumbnail', filename: 'cover.png', content_type: 'image/png', size: 2048 });
    expect(FakeXhr.log).toEqual([{ url: 'https://r2.test/single', bytes: 2048, contentType: 'image/png' }]);
    expect(states[states.length - 1]).toMatchObject({ phase: 'done', percent: 100 });
  });

  it('sends the lesson id with a small lesson video (so the key lands under the course author), never with a thumbnail', async () => {
    const small = videoFile(2 * MIB, 'intro.mp4');
    const { onState } = collect();
    await new ResumableUpload({ file: small, kind: 'video', userId: 'u1', lessonId: 'lesson-1', onState }).start();
    expect(callsTo('POST', /^\/uploads$/)[0].body).toMatchObject({ kind: 'video', lesson_id: 'lesson-1' });
    const cover = new File([new Uint8Array(1024)], 'cover.png', { type: 'image/png' });
    await new ResumableUpload({ file: cover, kind: 'thumbnail', userId: 'u1', lessonId: 'lesson-1', onState }).start();
    expect(callsTo('POST', /^\/uploads$/)[1].body).not.toHaveProperty('lesson_id');
  });

  it('shows "reconnecting" with a countdown while backing off, then succeeds', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // 700 ms first backoff
    let n = 0;
    FakeXhr.reply = () => (++n === 1 ? 503 : 200);
    const { states, onState } = collect();
    const file = new File([new Uint8Array(4096)], 'cover.jpg', { type: '' });
    await new ResumableUpload({ file, kind: 'thumbnail', userId: 'u1', onState }).start();
    expect(states.some((s) => s.phase === 'reconnecting' && s.retryInSeconds === 1)).toBe(true);
    expect(states[states.length - 1].phase).toBe('done');
    // Empty MIME type falls back to the extension.
    expect(FakeXhr.log[1].contentType).toBe('image/jpeg');
  });

  it('fails with a next step (never silently, never a Resume nobody shows) after 6 attempts, re-signing after two blind failures', async () => {
    vi.useFakeTimers();
    FakeXhr.reply = () => 0;
    const { onState, last } = collect();
    const upload = new ResumableUpload({ file: new File([new Uint8Array(100)], 'a.webp', { type: 'image/webp' }), kind: 'photo', userId: 'u1', onState });
    const outcome = expect(upload.start()).rejects.toThrow('Upload failed after 6 attempts — check your connection, then choose the file again.');
    await vi.advanceTimersByTimeAsync(120_000);
    await outcome;

    expect(FakeXhr.log).toHaveLength(6);
    // attempt 1 signs, attempt 2 reuses the URL, attempts 3–6 each get a fresh one
    expect(callsTo('POST', /^\/uploads$/)).toHaveLength(5);
    expect(last()).toMatchObject({ phase: 'failed', error: 'Upload failed after 6 attempts — check your connection, then choose the file again.' });
  });

  it('waits while offline and resumes automatically on the online event', async () => {
    online = false;
    const { onState, last } = collect();
    const done = new ResumableUpload({ file: new File([new Uint8Array(10)], 'c.png', { type: 'image/png' }), kind: 'thumbnail', userId: 'u1', onState }).start();
    await vi.waitFor(() => expect(last()?.phase).toBe('paused'));
    expect(last().error).toMatch(/offline/);
    expect(calls).toHaveLength(0);

    online = true;
    window.dispatchEvent(new Event('online'));
    await expect(done).resolves.toMatchObject({ size: 10 });
  });

  it('rejects unsupported formats and oversized images with actionable messages', async () => {
    const { onState, last } = collect();
    const mkv = new File([new Uint8Array(10)], 'talk.mkv', { type: 'video/x-matroska' });
    await expect(new ResumableUpload({ file: mkv, kind: 'video', userId: 'u1', onState }).start()).rejects.toThrow(/MP4 \(H\.264\)/);
    expect(last().phase).toBe('failed');
    const big = new File([new Uint8Array(6 * MIB)], 'big.png', { type: 'image/png' });
    await expect(uploadSmallFile(big, 'thumbnail', () => undefined)).rejects.toThrow(/5\.0 MB or smaller/);
    expect(calls).toHaveLength(0);
  });

  it('turns an expired login into a sign-in instruction', async () => {
    routes['POST /uploads'] = () => {
      throw new ApiError(401, 'Unauthorized');
    };
    await expect(uploadSmallFile(new File([new Uint8Array(10)], 'c.png', { type: 'image/png' }), 'thumbnail', () => undefined)).rejects.toThrow(
      /sign in again/,
    );
  });
});

describe('putFile', () => {
  it('resolves only on 2xx and reports done', async () => {
    const states: UploadState[] = [];
    await putFile('https://r2.test/project', new Blob([new Uint8Array(64)]), { contentType: 'application/octet-stream', onState: (s) => states.push(s) });
    expect(FakeXhr.log[0]).toEqual({ url: 'https://r2.test/project', bytes: 64, contentType: 'application/octet-stream' });
    expect(states[states.length - 1]).toMatchObject({ phase: 'done', percent: 100 });
  });

  it('rejects a readable error status and a network failure with a next step', async () => {
    const states: UploadState[] = [];
    FakeXhr.reply = () => 403;
    await expect(putFile('https://r2.test/p', new Blob([new Uint8Array(8)]), { onState: (s) => states.push(s) })).rejects.toThrow(/HTTP 403.*Start again/);
    expect(states[states.length - 1].phase).toBe('failed');
    FakeXhr.reply = () => 0;
    await expect(putFile('https://r2.test/p', new Blob([new Uint8Array(8)]))).rejects.toThrow(/fresh upload link/);
  });
});

describe('<UploadProgress />', () => {
  const base: UploadState = { phase: 'uploading', loaded: 62 * MIB, total: 100 * MIB, percent: 62, speedBps: 2 * MIB, etaSeconds: 19 };

  it('renders an accessible bar with bytes, speed and ETA, and wires Pause/Cancel', () => {
    const onPause = vi.fn();
    const onCancel = vi.fn();
    render(createElement(UploadProgress, { fileName: 'lecture3.mp4', state: base, onPause, onResume: vi.fn(), onCancel }));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('62');
    expect(screen.getByText(/62\.0 MB of 100\.0 MB/).textContent).toContain('2.0 MB/s · 19 s left');
    expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows phase texts and Resume when paused', () => {
    const { rerender } = render(createElement(UploadProgress, { fileName: 'a.mp4', state: { ...base, phase: 'preparing' } }));
    expect(screen.getByText('Preparing (server waking up…)')).toBeTruthy();
    rerender(createElement(UploadProgress, { fileName: 'a.mp4', state: { ...base, phase: 'reconnecting', retryInSeconds: 4 } }));
    expect(screen.getByText('Reconnecting in 4s')).toBeTruthy();
    rerender(createElement(UploadProgress, { fileName: 'a.mp4', state: { ...base, phase: 'failed', error: 'Upload cancelled' } }));
    expect(screen.getByText('Failed: Upload cancelled')).toBeTruthy();
    const onResume = vi.fn();
    rerender(createElement(UploadProgress, { fileName: 'a.mp4', state: { ...base, phase: 'paused' }, onResume }));
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Pause/ })).toBeNull();
  });

  it('offers neither Pause nor Cancel once the server has been asked to finish', () => {
    const handlers = { onPause: vi.fn(), onResume: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(createElement(UploadProgress, { fileName: 'a.mp4', state: { ...base, phase: 'finalizing', committed: true }, ...handlers }));
    expect(screen.getByText('Finalizing')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(createElement(UploadProgress, { fileName: 'a.mp4', state: { ...base, phase: 'finalizing', committed: true, retryInSeconds: 4 }, ...handlers }));
    expect(screen.getByText('Finalizing — retrying in 4s')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    // Paused (e.g. offline) after complete was sent: Resume finishes it, Cancel could not undo it.
    rerender(createElement(UploadProgress, { fileName: 'a.mp4', state: { ...base, phase: 'paused', committed: true }, ...handlers }));
    expect(screen.getByRole('button', { name: /Resume/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });
});
