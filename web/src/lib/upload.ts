'use client';

/**
 * Browser upload engine. Bytes go straight to R2 through presigned URLs; every
 * control-plane call (create, sign, status, complete, abort) goes through api()
 * so a long upload survives the 15-minute access-token expiry.
 *
 * - Thumbnails, photos and videos under 16 MiB: POST /uploads, then one XHR PUT.
 * - Larger videos: presigned multipart upload. The server fixes the part size,
 *   signs each part's exact length and completes the upload itself from
 *   ListParts, so the browser never needs ETags. A resume record in
 *   localStorage lets a reload (or a later visit) pick up the missing parts.
 */

import { api, ApiError } from './api';

export type UploadKind = 'video' | 'thumbnail' | 'photo';
export type UploadPhase = 'preparing' | 'uploading' | 'paused' | 'reconnecting' | 'finalizing' | 'done' | 'failed';

export interface UploadState {
  phase: UploadPhase;
  loaded: number;
  total: number;
  percent: number;
  speedBps: number | null;
  etaSeconds: number | null;
  error?: string;
  retryInSeconds?: number;
  /**
   * The server has been asked to finish the upload and may already be attaching
   * the video, so cancelling can no longer undo it: the UI stops offering Cancel.
   */
  committed?: boolean;
}

export interface UploadResult {
  key: string;
  size: number;
  lesson_updated: boolean;
}

const MIB = 1024 * 1024;
/** Videos this size or larger go multipart; POST /uploads caps single-PUT videos just below it. */
export const MULTIPART_THRESHOLD = 16 * MIB;
const IMAGE_MAX_BYTES = 5 * MIB;
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** `accept` attribute for video pickers — there is no transcoding, so only directly playable containers. */
export const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime,.m4v';
// Some OSes report an empty MIME type (notably for .m4v/.mov); fall back to the extension.
const VIDEO_EXTENSIONS: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v' };
const IMAGE_EXTENSIONS: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const RECORD_PREFIX = 'el_upload:v1:';
/** R2's lifecycle rule aborts unfinished multipart uploads after 7 days; stop offering resume half a day before. */
export const RESUME_TTL_MS = 6.5 * 24 * 60 * 60 * 1000;
const SAMPLE_BYTES = MIB;
export const MAX_ATTEMPTS = 6;
const URL_BATCH = 100;
const URL_REFILL_BELOW = 10;
const URL_EXPIRY_MARGIN_MS = 10 * 60 * 1000;
/** Lifetime of signed part URLs (PART_URL_TTL_SECONDS in the API's upload.service). */
const PART_URL_LIFETIME_MS = 2 * 60 * 60 * 1000;
/** A PUT with no progress for this long is treated as a dropped connection (mobile networks can hang silently). */
const STALL_MS = 60_000;
const MAX_RESTARTS = 2;
const MAX_COMPLETE_ROUNDS = 3;
const EMIT_THROTTLE_MS = 200;

const OFFLINE_MESSAGE = "You're offline — the upload continues automatically when you reconnect.";
const RETRY_MESSAGE = 'Connection problem — press Resume to try again.';
const SINGLE_RETRY_MESSAGE = `Upload failed after ${MAX_ATTEMPTS} attempts — check your connection, then choose the file again.`;
const CANCELLED_MESSAGE = 'Upload cancelled';
const DISCARDED_MESSAGE = 'This upload was discarded in another tab or window — choose the file again to upload it.';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Part layout of a multipart upload. R2 requires every part except the last to be exactly partSize. */
export function partMath(size: number, partSize: number) {
  const partCount = Math.max(1, Math.ceil(size / partSize));
  const lastPartSize = size - (partCount - 1) * partSize;
  return {
    partCount,
    lastPartSize,
    /** Byte length of part n (1-based). */
    partLength: (n: number) => (n < partCount ? partSize : lastPartSize),
    /** [start, end) byte range of part n within the file. */
    partRange: (n: number): [number, number] => [(n - 1) * partSize, Math.min(size, n * partSize)],
  };
}

/**
 * Parts still to upload, given the server's ListParts view (the server is the
 * truth, never a local cache). A part counts as done only at its exact size.
 */
export function missingParts(
  session: { size: number; part_size: number },
  listed: ReadonlyArray<{ part_number: number; size: number }>,
): number[] {
  const { partCount, partLength } = partMath(session.size, session.part_size);
  const done = new Set(
    listed.filter((p) => p.part_number >= 1 && p.part_number <= partCount && p.size === partLength(p.part_number)).map((p) => p.part_number),
  );
  const missing: number[] = [];
  for (let n = 1; n <= partCount; n++) if (!done.has(n)) missing.push(n);
  return missing;
}

/** Delay before retry `attempt` (0-based): min(30 s, 1 s·2^n) ±30% jitter so parallel workers don't retry in lockstep. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** attempt);
  return Math.round(base * (1 + (random() * 2 - 1) * 0.3));
}

/** Status codes worth retrying. 0 is ambiguous: a network drop, or an R2 403 (those carry no CORS headers). */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/** localStorage key of a resume record: same user, kind, lesson and file (name, size, mtime). */
export function fingerprintKey(
  userId: string,
  kind: UploadKind,
  lessonId: string | null | undefined,
  file: { name: string; size: number; lastModified: number },
): string {
  return `${RECORD_PREFIX}${userId}:${kind}|${lessonId ?? 'new'}|${file.name}|${file.size}|${file.lastModified}`;
}

export function isRecordFresh(record: { created_at: number }, now = Date.now()): boolean {
  return now - record.created_at < RESUME_TTL_MS;
}

/** Content type to declare for the file, or null when the kind does not allow it. */
export function resolveContentType(file: { name: string; type: string }, kind: UploadKind): string | null {
  const allowed = kind === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
  if (allowed.includes(file.type)) return file.type;
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  return (kind === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS)[ext] ?? null;
}

export function usesMultipart(file: { size: number }, kind: UploadKind): boolean {
  return kind === 'video' && file.size >= MULTIPART_THRESHOLD;
}

/**
 * SHA-256 of the first and last 1 MiB. Checked on resume so a different file
 * with the same name, size and mtime never continues someone else's parts.
 */
export async function sampleHash(file: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  // crypto.subtle only exists in secure contexts; without it the fingerprint key alone decides.
  if (!subtle) return '';
  const headEnd = Math.min(file.size, SAMPLE_BYTES);
  const [head, tail] = await Promise.all([
    file.slice(0, headEnd).arrayBuffer(),
    file.slice(Math.max(headEnd, file.size - SAMPLE_BYTES)).arrayBuffer(),
  ]);
  const bytes = new Uint8Array(head.byteLength + tail.byteLength);
  bytes.set(new Uint8Array(head), 0);
  bytes.set(new Uint8Array(tail), head.byteLength);
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n || 0))} B`;
  if (n < MIB) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * MIB) return `${(n / MIB).toFixed(1)} MB`;
  return `${(n / (1024 * MIB)).toFixed(2)} GB`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s left`;
  const minutes = Math.max(1, Math.round(s / 60));
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min left` : `${hours} h left`;
}

/** Upload speed as an exponential moving average (α 0.2) of ~1 s samples. */
export class SpeedMeter {
  private prev: { at: number; loaded: number } | null = null;
  private ema: number | null = null;
  private samples = 0;

  reset(): void {
    this.prev = null;
    this.ema = null;
    this.samples = 0;
  }

  sample(loaded: number, at: number): void {
    if (this.prev && at > this.prev.at) {
      // A failed part drops its partial bytes; count that second as no progress, not negative speed.
      const rate = Math.max(0, loaded - this.prev.loaded) / ((at - this.prev.at) / 1000);
      this.ema = this.ema === null ? rate : 0.2 * rate + 0.8 * this.ema;
      this.samples++;
    }
    this.prev = { at, loaded };
  }

  get speedBps(): number | null {
    return this.ema;
  }

  /** Null until three samples exist — earlier estimates swing wildly. */
  etaSeconds(remaining: number): number | null {
    if (this.samples < 3 || !this.ema) return null;
    return Math.ceil(remaining / this.ema);
  }
}

// ---------------------------------------------------------------------------
// Resume records (localStorage; every access may throw in private mode or when full)
// ---------------------------------------------------------------------------

interface ResumeRecord {
  session_id: string;
  key: string;
  part_size: number;
  part_count: number;
  size: number;
  lesson_id: string | null;
  course_id: string | null;
  file_name: string;
  created_at: number;
  sample_hash: string;
  percent: number;
}

function readRecord(storageKey: string): ResumeRecord | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const r = JSON.parse(raw);
    if (typeof r?.session_id !== 'string' || typeof r.size !== 'number' || typeof r.part_size !== 'number' || typeof r.created_at !== 'number') {
      return null;
    }
    return r as ResumeRecord;
  } catch {
    return null;
  }
}

/** False when storage is full or blocked: the upload still works, it just cannot resume after a reload. */
function writeRecord(storageKey: string, record: ResumeRecord): boolean {
  try {
    localStorage.setItem(storageKey, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function removeRecord(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* nothing to clean up if storage is unavailable */
  }
}

function deleteSession(sessionId: string): Promise<void> {
  // Best effort: R2 aborts unfinished uploads after 7 days and the API expires the row lazily.
  return api(`/uploads/multipart/${sessionId}`, { method: 'DELETE' }).then(
    () => undefined,
    () => undefined,
  );
}

export interface ResumableUploadInfo {
  storageKey: string;
  fileName: string;
  size: number;
  lessonId?: string;
  courseId?: string;
  percent?: number;
  createdAt: number;
}

/**
 * Multipart uploads still running in this tab, by resume-record key. An engine
 * outlives the page that started it (in-app navigation does not stop it), so its
 * record must not be offered as "unfinished": resuming it would start a second
 * engine on the same session, and discarding it only made the running engine
 * start over under a new session.
 */
const liveUploads = new Map<string, ResumableUpload>();

/**
 * Unfinished multipart uploads this browser can resume, newest first. Expired
 * records are pruned. Uploads still running in this tab are left out; their
 * owner shows them as live progress instead.
 */
export function listResumableUploads(userId: string, filter: { lessonId?: string; courseId?: string } = {}): ResumableUploadInfo[] {
  const prefix = `${RECORD_PREFIX}${userId}:`;
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix) && !liveUploads.has(k)) keys.push(k);
    }
  } catch {
    return [];
  }
  const now = Date.now();
  const out: ResumableUploadInfo[] = [];
  for (const storageKey of keys) {
    const r = readRecord(storageKey);
    if (!r || !isRecordFresh(r, now)) {
      removeRecord(storageKey);
      continue;
    }
    if (filter.lessonId && r.lesson_id !== filter.lessonId) continue;
    if (filter.courseId && r.course_id !== filter.courseId) continue;
    out.push({
      storageKey,
      fileName: r.file_name,
      size: r.size,
      lessonId: r.lesson_id ?? undefined,
      courseId: r.course_id ?? undefined,
      percent: r.percent,
      createdAt: r.created_at,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Forget an unfinished upload: drop the record and abort its server session.
 * If this tab is still running it, that upload is cancelled (which does both);
 * otherwise it would notice the session is gone and start over from zero.
 */
export async function discardResumableUpload(storageKey: string): Promise<void> {
  const live = liveUploads.get(storageKey);
  if (live) return live.cancel();
  await forgetRecord(storageKey);
}

async function forgetRecord(storageKey: string): Promise<void> {
  const record = readRecord(storageKey);
  // Remove first so a new upload of the same file can write its record while the DELETE is in flight.
  removeRecord(storageKey);
  if (record) await deleteSession(record.session_id);
}

// ---------------------------------------------------------------------------
// XHR (fetch() has no upload progress events)
// ---------------------------------------------------------------------------

interface PutHandle {
  done: Promise<{ status: number; aborted: boolean }>;
  abort: () => void;
}

function sendPut(url: string, body: Blob, opts: { contentType?: string; onProgress?: (loaded: number) => void }): PutHandle {
  const xhr = new XMLHttpRequest();
  let aborted = false;
  let lastActivity = Date.now();
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const done = new Promise<{ status: number; aborted: boolean }>((resolve) => {
    let settled = false;
    const settle = (status: number) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      resolve({ status, aborted });
    };
    xhr.open('PUT', url);
    if (opts.contentType) xhr.setRequestHeader('Content-Type', opts.contentType);
    xhr.upload.onprogress = (e) => {
      if (settled) return;
      lastActivity = Date.now();
      opts.onProgress?.(e.loaded);
    };
    xhr.onload = () => settle(xhr.status);
    xhr.onerror = () => settle(0);
    xhr.ontimeout = () => settle(0);
    xhr.onabort = () => settle(0);
    // A stall is aborted without setting `aborted`, so callers see status 0 and retry.
    watchdog = setInterval(() => {
      if (Date.now() - lastActivity > STALL_MS) xhr.abort();
    }, 5_000);
    xhr.send(body);
  });
  return {
    done,
    abort: () => {
      aborted = true;
      xhr.abort();
    },
  };
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Upload a file to an already-signed URL (e.g. the project-submission link the
 * outcomes service hands out) with progress. Resolves only on a 2xx.
 */
export async function putFile(
  url: string,
  file: Blob,
  opts: { contentType?: string; onState?: (s: UploadState) => void } = {},
): Promise<void> {
  const total = file.size;
  const meter = new SpeedMeter();
  let loaded = 0;
  let lastReport = 0;
  const report = (phase: UploadPhase, error?: string) => {
    lastReport = Date.now();
    opts.onState?.({
      phase,
      loaded,
      total,
      percent: total ? Math.floor((loaded / total) * 100) : 0,
      speedBps: phase === 'uploading' ? meter.speedBps : null,
      etaSeconds: phase === 'uploading' ? meter.etaSeconds(total - loaded) : null,
      ...(error ? { error } : {}),
    });
  };
  meter.sample(0, Date.now());
  report('uploading');
  const tick = setInterval(() => {
    meter.sample(loaded, Date.now());
    report('uploading');
  }, 1000);
  try {
    const { status } = await sendPut(url, file, {
      contentType: opts.contentType,
      onProgress: (n) => {
        loaded = n;
        if (Date.now() - lastReport >= EMIT_THROTTLE_MS) report('uploading');
      },
    }).done;
    if (status >= 200 && status < 300) {
      loaded = total;
      report('done');
      return;
    }
    const message =
      status === 0
        ? isOnline()
          ? 'Upload failed. Check your connection and try again — if it keeps failing, press Start again to get a fresh upload link.'
          : "You're offline — reconnect and choose the file again."
        : `The storage server rejected the upload (HTTP ${status}). Press Start again to get a fresh upload link, then retry.`;
    report('failed', message);
    throw new Error(message);
  } finally {
    clearInterval(tick);
  }
}

// ---------------------------------------------------------------------------
// ResumableUpload
// ---------------------------------------------------------------------------

/** start() rejects with this after cancel(). */
export class UploadCancelledError extends Error {
  constructor() {
    super(CANCELLED_MESSAGE);
    this.name = 'UploadCancelledError';
  }
}

/** Thrown inside a run that pause/cancel (or a failed sibling worker) has stopped. */
class Superseded extends Error {
  constructor() {
    super('Upload interrupted — try again.');
  }
}
class OfflineError extends Error {}
class RetriesExhaustedError extends Error {}
class SessionGoneError extends Error {
  constructor() {
    super('The upload expired on the server — choose the file again to start over.');
  }
}

/** Cancellation flag for one run of the pipeline; a child dies with its parent. */
class RunToken {
  private stopped = false;
  constructor(private readonly parent?: RunToken) {}
  stop(): void {
    this.stopped = true;
  }
  get dead(): boolean {
    return this.stopped || (this.parent?.dead ?? false);
  }
}

function ensureAlive(token: RunToken): void {
  if (token.dead) throw new Superseded();
}

interface Session {
  session_id: string;
  key: string;
  part_size: number;
  part_count: number;
  size: number;
}

interface ServerStatus {
  status: 'uploading' | 'completed' | 'aborted' | 'expired';
  parts?: Array<{ part_number: number; size: number }>;
}

function parseExpiry(value: unknown, now: number): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value; // epoch seconds or ms
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  // Unknown format: assume a short life so the URL is refreshed rather than used after expiry.
  return now + 30 * 60 * 1000;
}

/**
 * When (on this device's clock) a batch of signed part URLs stops working.
 *
 * The API's `expires_at` is an absolute time on the server's clock. Comparing it
 * with a device clock that is hours off either re-signs before every part (clock
 * fast) or keeps using URLs R2 already rejects (clock slow), so only a lifetime is
 * taken from the response and it is counted from `sentAt`, which is never later
 * than the server's own stamp.
 *
 * - `expires_in` (seconds), when the API sends it, is exact.
 * - Otherwise the lifetime `expires_at` implies on this clock is used, capped at
 *   the API's 2 h. A value too short to ever count as fresh (under two refresh
 *   margins) only happens with a clock that is well ahead, so the 2 h default
 *   applies then.
 */
export function partUrlExpiry(res: { expires_at?: unknown; expires_in?: unknown }, sentAt: number, receivedAt: number): number {
  if (typeof res.expires_in === 'number' && res.expires_in > 0) return sentAt + res.expires_in * 1000;
  const claimed = parseExpiry(res.expires_at, receivedAt) - receivedAt;
  const lifetime = claimed > 2 * URL_EXPIRY_MARGIN_MS ? Math.min(claimed, PART_URL_LIFETIME_MS) : PART_URL_LIFETIME_MS;
  return sentAt + lifetime;
}

/** Keep the name within the API's 200-character limit without losing the extension. */
function serverFileName(name: string): string {
  if (name.length <= 200) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  return name.slice(0, 200 - ext.length) + ext;
}

function validationError(file: File, kind: UploadKind, contentType: string | null): string | null {
  if (file.size === 0) return 'This file is empty — choose another file.';
  if (!contentType) {
    return kind === 'video'
      ? "This video format isn't supported. Upload an MP4 (H.264), WebM or MOV file — convert other formats to MP4 first."
      : 'Use a JPEG, PNG or WebP image.';
  }
  if (kind !== 'video' && file.size > IMAGE_MAX_BYTES) {
    return `Images must be ${formatBytes(IMAGE_MAX_BYTES)} or smaller — resize or compress it and try again.`;
  }
  return null;
}

export class ResumableUpload {
  private readonly file: File;
  private readonly kind: UploadKind;
  private readonly lessonId?: string;
  private readonly courseId?: string;
  private readonly onState: (s: UploadState) => void;
  private readonly storageKey: string;
  private readonly multipart: boolean;
  private readonly contentType: string | null;

  private phase: UploadPhase = 'preparing';
  private error?: string;
  private settle: { resolve: (r: UploadResult) => void; reject: (e: Error) => void } | null = null;
  private promise: Promise<UploadResult> | null = null;
  private token: RunToken | null = null;
  private cancelled = false;
  /** Paused because the browser went offline — resume on the 'online' event. */
  private autoResume = false;

  private session: Session | null = null;
  /** The resume record in storage is ours (written or adopted), so its disappearance means someone discarded it. */
  private ownsRecord = false;
  /** A complete request may have reached the server; from then on cancel() cannot stop the attach. */
  private completeSent = false;
  private completesInFlight = 0;
  private sampleHashValue: string | null = null;
  private doneBytes = 0;
  private readonly inflight = new Map<number, number>();
  private readonly puts = new Set<PutHandle>();
  private queue: number[] = [];
  private readonly urls = new Map<number, { url: string; expiresAt: number }>();
  private refilling: { promise: Promise<void>; token: RunToken } | null = null;
  private creating: Promise<Session> | null = null;
  private readonly waits = new Set<{ until: number }>();
  private readonly sleepers = new Set<{ timer: ReturnType<typeof setTimeout>; wake: () => void }>();
  private readonly meter = new SpeedMeter();
  private ticker?: ReturnType<typeof setInterval>;
  private lastEmit = 0;

  constructor(opts: {
    file: File;
    kind: UploadKind;
    userId: string;
    lessonId?: string;
    courseId?: string;
    onState: (s: UploadState) => void;
  }) {
    this.file = opts.file;
    this.kind = opts.kind;
    this.lessonId = opts.lessonId;
    this.courseId = opts.courseId;
    this.onState = opts.onState;
    this.storageKey = fingerprintKey(opts.userId, opts.kind, opts.lessonId, opts.file);
    this.multipart = usesMultipart(opts.file, opts.kind);
    this.contentType = resolveContentType(opts.file, opts.kind);
  }

  /**
   * Resolves once stored; rejects on failure or cancel (UploadCancelledError).
   * Multipart uploads with a lessonId are attached server-side on complete
   * (lesson_updated: true). The single-PUT path (videos under 16 MiB) never
   * attaches: lesson_updated is false and the caller saves the key on the lesson.
   */
  start(): Promise<UploadResult> {
    if (!this.promise) {
      this.promise = new Promise<UploadResult>((resolve, reject) => {
        this.settle = { resolve, reject };
      });
      // Only multipart uploads have resume records that other code could list or discard.
      if (this.multipart) liveUploads.set(this.storageKey, this);
      this.attachListeners();
      void this.drive();
    }
    return this.promise;
  }

  /** Stops in-flight PUTs; a partly sent part is re-sent on resume. Not offered while finalizing. */
  pause(): void {
    if (this.phase !== 'preparing' && this.phase !== 'uploading') return;
    this.enterPaused(undefined, false);
  }

  resume(): void {
    if (this.phase !== 'paused' || !this.settle) return;
    void this.drive();
  }

  /**
   * Stops the upload, aborts the server session and forgets the resume record.
   * Does nothing once complete has been sent: the server may already have
   * attached the video, and a DELETE then cannot undo that, so claiming
   * "cancelled" would be wrong. The UI hides Cancel in that state (`committed`).
   */
  async cancel(): Promise<void> {
    if (this.phase === 'done' || this.cancelled || this.completeSent) return;
    this.cancelled = true;
    this.token?.stop();
    this.abortTransfers();
    this.stopTicker();
    this.detachListeners();
    this.unregister();
    removeRecord(this.storageKey);
    const session = this.session;
    this.session = null;
    this.setPhase('failed', CANCELLED_MESSAGE);
    const settle = this.settle;
    this.settle = null;
    settle?.reject(new UploadCancelledError());
    if (session) await deleteSession(session.session_id);
  }

  // ---- run loop ----

  private async drive(): Promise<void> {
    const token = new RunToken();
    this.token = token;
    this.autoResume = false;
    this.startTicker();
    try {
      const invalid = validationError(this.file, this.kind, this.contentType);
      if (invalid) throw new Error(invalid);
      if (!isOnline()) throw new OfflineError();
      const result = this.multipart ? await this.runMultipart(token) : await this.runSingle(token);
      // Paused after the last await: resume re-checks the server, and complete is idempotent.
      if (token.dead) return;
      this.finish(result);
    } catch (err) {
      if (token.dead) return;
      if (err instanceof OfflineError) this.enterPaused(OFFLINE_MESSAGE, true);
      else if (err instanceof RetriesExhaustedError) {
        // Multipart keeps its stored parts, so pausing loses nothing and Resume continues.
        // A single PUT has nothing to continue: fail with the next step so the file picker
        // is usable again instead of waiting on a Resume the thumbnail card never shows.
        if (this.multipart) this.enterPaused(RETRY_MESSAGE, false);
        else this.fail(new Error(SINGLE_RETRY_MESSAGE));
      } else this.fail(err);
    }
  }

  private async runSingle(token: RunToken): Promise<UploadResult> {
    this.setPhase('preparing');
    this.doneBytes = 0;
    let grant: { url: string; key: string } | null = null;
    const getUrl = async (fresh: boolean) => {
      // A fresh grant means a new key too — the old one simply never gets written.
      if (!grant || fresh) {
        const res = await this.withRetry(token, () =>
          api<{ url?: string; upload_url?: string; key: string }>('/uploads', {
            method: 'POST',
            body: {
              kind: this.kind,
              filename: serverFileName(this.file.name),
              content_type: this.contentType,
              size: this.file.size,
              // Keys a lesson video under the course's author, so an admin uploading for an educator passes the key check.
              ...(this.kind === 'video' && this.lessonId ? { lesson_id: this.lessonId } : {}),
            },
          }),
        );
        ensureAlive(token);
        const url = res.url ?? res.upload_url;
        if (!url) throw new Error('The server did not return an upload link — try again.');
        grant = { url, key: res.key };
        this.setPhase('uploading');
      }
      return grant.url;
    };
    try {
      await this.transfer(0, this.file, this.contentType ?? undefined, getUrl, token);
    } catch (err) {
      if (err instanceof SessionGoneError) throw new Error('The storage server could not find the upload location (HTTP 404) — try again.');
      throw err;
    }
    return { key: grant!.key, size: this.file.size, lesson_updated: false };
  }

  private async runMultipart(token: RunToken): Promise<UploadResult> {
    this.setPhase('preparing');
    if (this.sampleHashValue === null) {
      this.sampleHashValue = await sampleHash(this.file);
      ensureAlive(token);
    }
    if (!this.session) this.session = this.sessionFromRecord();

    let restarts = 0;
    let completeRounds = 0;
    let known: ServerStatus | null = null;
    for (;;) {
      let missing: number[];
      if (this.session) {
        const status = known ?? (await this.fetchStatus(this.session, token));
        known = null;
        if (!status) {
          this.restartAfterSessionLoss(this.session);
          continue;
        }
        if (status.status === 'completed') return await this.complete(token);
        missing = missingParts(this.session, status.parts ?? []);
        // The server still wants parts, so no earlier complete went through: cancelling is safe again.
        if (missing.length && this.completesInFlight === 0) this.completeSent = false;
      } else {
        const session = await this.createSession(token);
        missing = Array.from({ length: partMath(session.size, session.part_size).partCount }, (_, i) => i + 1);
      }

      const { partLength } = partMath(this.session!.size, this.session!.part_size);
      this.doneBytes = this.file.size - missing.reduce((sum, n) => sum + partLength(n), 0);
      this.saveProgress();
      this.setPhase('uploading');

      try {
        await this.uploadParts(missing, token);
      } catch (err) {
        // A readable 404 from R2 means the session is gone: re-check status, then restart.
        if (err instanceof SessionGoneError && restarts++ < MAX_RESTARTS) continue;
        throw err;
      }

      try {
        return await this.complete(token);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.status === 409 && completeRounds++ < MAX_COMPLETE_ROUNDS) {
          // 409 is either "parts missing" (upload them and retry) or a lesson-side conflict (surface it).
          known = await this.fetchStatus(this.session!, token);
          if (!known || (known.status === 'uploading' && missingParts(this.session!, known.parts ?? []).length > 0)) continue;
          throw err;
        }
        if (err.status === 410 && restarts++ < MAX_RESTARTS) {
          this.restartAfterSessionLoss(this.session!);
          continue;
        }
        throw err;
      }
    }
  }

  private sessionFromRecord(): Session | null {
    const record = readRecord(this.storageKey);
    if (!record) return null;
    if (!isRecordFresh(record) || record.size !== this.file.size) {
      removeRecord(this.storageKey);
      return null;
    }
    if (record.sample_hash !== this.sampleHashValue) {
      // Same name, size and mtime but different bytes: those parts belong to another file.
      // (Not discardResumableUpload: this upload is registered under the same key and would cancel itself.)
      void forgetRecord(this.storageKey);
      return null;
    }
    this.ownsRecord = true;
    return { session_id: record.session_id, key: record.key, part_size: record.part_size, part_count: record.part_count, size: record.size };
  }

  /**
   * The server no longer has the session (expired, aborted, 404). Normally the
   * upload starts over under a new one. But if our resume record went away too,
   * someone discarded this upload (another tab lists the same records): stop,
   * rather than re-upload everything and attach a video they threw away.
   */
  private restartAfterSessionLoss(session: Session): void {
    if (this.ownsRecord && readRecord(this.storageKey)?.session_id !== session.session_id) {
      this.session = null;
      this.ownsRecord = false;
      throw new Error(DISCARDED_MESSAGE);
    }
    this.dropSession();
  }

  /**
   * Create the server session, sharing one in-flight request across runs: a pause
   * and resume while the create is pending must not open a second session.
   */
  private async createSession(token: RunToken): Promise<Session> {
    for (;;) {
      if (!this.creating) {
        const pending = this.requestSession(token);
        this.creating = pending;
        pending
          .finally(() => {
            if (this.creating === pending) this.creating = null;
          })
          .catch(() => undefined);
      }
      try {
        const session = await this.creating;
        ensureAlive(token);
        return session;
      } catch (err) {
        // The run that started the request was paused; this run is live, so ask again.
        if (err instanceof Superseded && !token.dead) continue;
        throw err;
      }
    }
  }

  private async requestSession(token: RunToken): Promise<Session> {
    const created = await this.withRetry(token, () =>
      api<Session>('/uploads/multipart', {
        method: 'POST',
        body: {
          kind: 'video',
          filename: serverFileName(this.file.name),
          size: this.file.size,
          content_type: this.contentType,
          ...(this.lessonId ? { lesson_id: this.lessonId } : {}),
        },
      }),
    );
    const session: Session = {
      session_id: created.session_id,
      key: created.key,
      part_size: created.part_size,
      part_count: created.part_count,
      size: created.size ?? this.file.size,
    };
    if (this.cancelled) {
      // Cancelled while the create was in flight: an orphan would count against the open-upload cap.
      void deleteSession(session.session_id);
      throw new Superseded();
    }
    this.session = session;
    this.urls.clear();
    this.ownsRecord = writeRecord(this.storageKey, {
      ...session,
      lesson_id: this.lessonId ?? null,
      course_id: this.courseId ?? null,
      file_name: this.file.name,
      created_at: Date.now(),
      sample_hash: this.sampleHashValue ?? '',
      percent: 0,
    });
    // No liveness check here: the session is adopted even if its run was paused, so resume reuses it.
    return session;
  }

  /** Server view of the session, or null when it no longer exists (expired, aborted, 404). */
  private async fetchStatus(session: Session, token: RunToken): Promise<ServerStatus | null> {
    try {
      const status = await this.withRetry(token, () => api<ServerStatus>(`/uploads/multipart/${session.session_id}`));
      ensureAlive(token);
      return status.status === 'uploading' || status.status === 'completed' ? status : null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  private async complete(token: RunToken): Promise<UploadResult> {
    this.completeSent = true;
    this.setPhase('finalizing');
    const session = this.session!;
    const res = await this.withRetry(token, async () => {
      this.completesInFlight++;
      try {
        return await api<Partial<UploadResult>>(`/uploads/multipart/${session.session_id}/complete`, {
          method: 'POST',
          body: this.lessonId ? { lesson_id: this.lessonId } : {},
        });
      } finally {
        this.completesInFlight--;
      }
    });
    ensureAlive(token);
    return { key: res.key ?? session.key, size: res.size ?? session.size, lesson_updated: !!res.lesson_updated };
  }

  private dropSession(): void {
    this.session = null;
    this.ownsRecord = false;
    // A session the server has dropped can no longer be completed.
    if (this.completesInFlight === 0) this.completeSent = false;
    this.urls.clear();
    removeRecord(this.storageKey);
  }

  private async uploadParts(parts: number[], run: RunToken): Promise<void> {
    if (!parts.length) return;
    const group = new RunToken(run);
    this.queue = [...parts];
    let firstError: unknown = null;
    const worker = async () => {
      while (!firstError) {
        const n = this.queue.shift();
        if (n === undefined) return;
        try {
          await this.uploadPart(n, group);
        } catch (err) {
          if (!firstError) {
            firstError = err;
            group.stop();
            // Stop this run's other PUTs and backoff waits. A run that pause/cancel already stopped
            // had its transfers aborted then; a worker of it that wakes up later (e.g. from a sign
            // request that outlived the pause) would otherwise abort the resumed run's PUTs.
            if (!run.dead) this.abortTransfers();
          }
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency(), parts.length) }, worker));
    if (firstError) throw firstError;
  }

  private async uploadPart(n: number, token: RunToken): Promise<void> {
    const session = this.session!;
    const { partRange, partLength } = partMath(session.size, session.part_size);
    const [start, end] = partRange(n);
    await this.transfer(n, this.file.slice(start, end), undefined, (fresh) => this.partUrl(n, fresh, token), token);
    this.doneBytes += partLength(n);
    this.saveProgress();
    this.emit(true);
  }

  /** PUT one body to R2, retrying transient failures, until it is stored. */
  private async transfer(
    slot: number,
    body: Blob,
    contentType: string | undefined,
    getUrl: (fresh: boolean) => Promise<string>,
    token: RunToken,
  ): Promise<void> {
    let zeroStreak = 0;
    let fresh = false;
    for (let attempt = 1; ; attempt++) {
      const url = await getUrl(fresh);
      fresh = false;
      ensureAlive(token);
      const { status, aborted } = await this.put(url, body, slot, contentType);
      if (aborted) throw new Superseded();
      if (status >= 200 && status < 300) return;
      if (status === 404) throw new SessionGoneError();
      if (status === 0 && !isOnline()) throw new OfflineError();
      zeroStreak = status === 0 ? zeroStreak + 1 : 0;
      // An expired or rejected signature shows up as status 0 (R2 sends 403s without CORS headers),
      // so after two blind failures while online, sign this part again.
      if (zeroStreak >= 2 || status === 403) fresh = true;
      else if (!isRetryableStatus(status)) {
        throw new Error(`The storage server rejected the upload (HTTP ${status}) — try again, and contact support if it keeps happening.`);
      }
      if (attempt >= MAX_ATTEMPTS) throw new RetriesExhaustedError();
      await this.backoff(attempt - 1, token);
    }
  }

  private async put(url: string, body: Blob, slot: number, contentType: string | undefined) {
    const handle = sendPut(url, body, {
      contentType,
      onProgress: (loaded) => {
        this.inflight.set(slot, loaded);
        this.emit();
      },
    });
    this.puts.add(handle);
    this.inflight.set(slot, 0);
    try {
      return await handle.done;
    } finally {
      this.puts.delete(handle);
      this.inflight.delete(slot);
    }
  }

  // ---- presigned part URLs (batched: the gateway write limiter is 60/min) ----

  private hasFreshUrl(n: number): boolean {
    const entry = this.urls.get(n);
    return !!entry && entry.expiresAt - Date.now() > URL_EXPIRY_MARGIN_MS;
  }

  private async partUrl(n: number, fresh: boolean, token: RunToken): Promise<string> {
    if (fresh) this.urls.delete(n);
    if (!this.hasFreshUrl(n)) {
      await this.refillUrls(n, token);
    } else if (this.queue.filter((p) => this.hasFreshUrl(p)).length < URL_REFILL_BELOW && this.queue.some((p) => !this.hasFreshUrl(p))) {
      // Prefetch the next batch; a failure resurfaces when a part actually needs a URL.
      this.refillUrls(undefined, token).catch(() => undefined);
    }
    const entry = this.urls.get(n);
    if (!entry) throw new Error(`The server did not sign part ${n} — try again.`);
    return entry.url;
  }

  private async refillUrls(first: number | undefined, token: RunToken): Promise<void> {
    // One signing request at a time; later callers share it, then re-check their own part.
    if (this.refilling && !this.refilling.token.dead) {
      await this.refilling.promise;
      if (first === undefined || this.hasFreshUrl(first)) return;
      return this.refillUrls(first, token);
    }
    const wanted = [first, ...this.queue.filter((p) => p !== first && !this.hasFreshUrl(p))].filter((p): p is number => p !== undefined);
    const batch = wanted.slice(0, URL_BATCH);
    if (!batch.length) return;
    const entry = { token, promise: this.signParts(this.session!, batch, token) };
    this.refilling = entry;
    try {
      await entry.promise;
    } finally {
      // A newer refill may have replaced this one after a restart; leave that one in place.
      if (this.refilling === entry) this.refilling = null;
    }
  }

  private async signParts(session: Session, partNumbers: number[], token: RunToken): Promise<void> {
    try {
      let sentAt = 0;
      const res = await this.withRetry(token, () => {
        sentAt = Date.now();
        return api<{ urls: Array<{ part_number: number; url: string }>; expires_at?: unknown; expires_in?: unknown }>(
          `/uploads/multipart/${session.session_id}/parts`,
          { method: 'POST', body: { part_numbers: partNumbers } },
        );
      });
      if (this.session !== session) return;
      const expiresAt = partUrlExpiry(res, sentAt, Date.now());
      res.urls.forEach(({ part_number, url }) => this.urls.set(part_number, { url, expiresAt }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw new SessionGoneError();
      throw err;
    }
  }

  // ---- retries ----

  /** Call the API, retrying network errors, 5xx, 408 and 429 with backoff. */
  private async withRetry<T>(token: RunToken, call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      ensureAlive(token);
      try {
        return await call();
      } catch (err) {
        ensureAlive(token);
        if (err instanceof ApiError && !isRetryableStatus(err.status)) throw err;
        if (!(err instanceof ApiError) && !isOnline()) throw new OfflineError();
        if (attempt >= MAX_ATTEMPTS) throw new RetriesExhaustedError();
        await this.backoff(attempt - 1, token);
      }
    }
  }

  private async backoff(attempt: number, token: RunToken): Promise<void> {
    const delay = backoffDelay(attempt);
    const wait = { until: Date.now() + delay };
    this.waits.add(wait);
    this.emit(true);
    try {
      await new Promise<void>((resolve) => {
        const sleeper = {
          timer: setTimeout(() => {
            this.sleepers.delete(sleeper);
            resolve();
          }, delay),
          wake: resolve,
        };
        this.sleepers.add(sleeper);
      });
    } finally {
      this.waits.delete(wait);
    }
    ensureAlive(token);
    this.emit(true);
  }

  private abortTransfers(): void {
    this.puts.forEach((put) => put.abort());
    this.puts.clear();
    this.inflight.clear();
    this.sleepers.forEach((sleeper) => {
      clearTimeout(sleeper.timer);
      sleeper.wake();
    });
    this.sleepers.clear();
  }

  // ---- state ----

  private enterPaused(reason: string | undefined, autoResume: boolean): void {
    this.token?.stop();
    this.abortTransfers();
    this.stopTicker();
    this.autoResume = autoResume;
    this.setPhase('paused', reason);
  }

  private unregister(): void {
    if (liveUploads.get(this.storageKey) === this) liveUploads.delete(this.storageKey);
  }

  private finish(result: UploadResult): void {
    this.unregister();
    removeRecord(this.storageKey);
    this.stopTicker();
    this.detachListeners();
    this.doneBytes = this.file.size;
    this.setPhase('done');
    const settle = this.settle;
    this.settle = null;
    settle?.resolve(result);
  }

  private fail(err: unknown): void {
    this.unregister();
    this.stopTicker();
    this.detachListeners();
    this.inflight.clear();
    let message = err instanceof Error && err.message ? err.message : 'Upload failed — try again.';
    if (err instanceof ApiError && err.status === 401) {
      message = this.multipart
        ? 'Your session expired — sign in again, then choose the same file to continue where it stopped.'
        : 'Your session expired — sign in again and retry the upload.';
    }
    // The resume record stays: fixing the cause (e.g. withdrawing a course from review) and
    // choosing the same file again continues from the parts already stored.
    this.setPhase('failed', message);
    const settle = this.settle;
    this.settle = null;
    settle?.reject(new Error(message));
  }

  private saveProgress(): void {
    const session = this.session;
    if (!session) return;
    const record = readRecord(this.storageKey);
    if (!record || record.session_id !== session.session_id) return;
    writeRecord(this.storageKey, { ...record, percent: Math.floor((this.doneBytes / this.file.size) * 100) });
  }

  private loadedBytes(): number {
    let inflight = 0;
    this.inflight.forEach((n) => (inflight += n));
    return Math.min(this.file.size, this.doneBytes + inflight);
  }

  private setPhase(phase: UploadPhase, error?: string): void {
    this.phase = phase;
    this.error = error;
    this.emit(true);
  }

  private snapshot(): UploadState {
    const total = this.file.size;
    const loaded = this.phase === 'done' ? total : this.loadedBytes();
    let phase = this.phase;
    let retryInSeconds: number | undefined;
    if (this.waits.size && (phase === 'uploading' || phase === 'finalizing')) {
      const until = Math.min(...Array.from(this.waits, (w) => w.until));
      retryInSeconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      // Only "reconnecting" when nothing is moving; one retrying part among busy workers is still uploading.
      // Finalizing keeps its phase (with the countdown): Pause and Cancel mean nothing there.
      if (phase === 'uploading' && this.puts.size === 0) phase = 'reconnecting';
    }
    const moving = phase === 'uploading' || phase === 'reconnecting';
    return {
      phase,
      loaded,
      total,
      percent: phase === 'done' ? 100 : total ? Math.floor((loaded / total) * 100) : 0,
      speedBps: moving ? this.meter.speedBps : null,
      etaSeconds: moving ? this.meter.etaSeconds(total - loaded) : null,
      ...(this.error ? { error: this.error } : {}),
      ...(retryInSeconds !== undefined ? { retryInSeconds } : {}),
      ...(this.completeSent && phase !== 'done' && phase !== 'failed' ? { committed: true } : {}),
    };
  }

  private emit(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < EMIT_THROTTLE_MS) return;
    this.lastEmit = now;
    this.onState(this.snapshot());
  }

  private startTicker(): void {
    this.stopTicker();
    this.meter.reset();
    this.ticker = setInterval(() => {
      // Sample only while bytes should be moving, so a cold-start wait doesn't drag the average down.
      if (this.phase === 'uploading') this.meter.sample(this.loadedBytes(), Date.now());
      else this.meter.reset();
      this.emit(true);
    }, 1000);
  }

  private stopTicker(): void {
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  // ---- browser events ----

  private readonly onOnline = () => {
    if (this.phase === 'paused' && this.autoResume) this.resume();
  };

  private readonly onOffline = () => {
    if (this.phase === 'preparing' || this.phase === 'uploading' || this.phase === 'finalizing') this.enterPaused(OFFLINE_MESSAGE, true);
  };

  private readonly onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (this.phase !== 'preparing' && this.phase !== 'uploading' && this.phase !== 'finalizing') return;
    e.preventDefault();
    e.returnValue = '';
  };

  private attachListeners(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('beforeunload', this.onBeforeUnload);
  }

  private detachListeners(): void {
    if (typeof window === 'undefined') return;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
  }
}

function concurrency(): number {
  const type = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType;
  return type === 'slow-2g' || type === '2g' || type === '3g' ? 2 : 3;
}

/** Single-PUT upload through POST /uploads (thumbnails, photos, short videos) with retries and progress. */
export function uploadSmallFile(file: File, kind: UploadKind, onProgress: (s: UploadState) => void): Promise<UploadResult> {
  if (usesMultipart(file, kind)) {
    return Promise.reject(new Error(`Videos of ${formatBytes(MULTIPART_THRESHOLD)} or more need ResumableUpload.`));
  }
  // The user id only keys multipart resume records, which the single-PUT path never writes.
  return new ResumableUpload({ file, kind, userId: '', onState: onProgress }).start();
}
