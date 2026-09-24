import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { randomUUID } from 'crypto';
import { Between, MoreThan, Repository } from 'typeorm';
import { envInt, UserContext } from '@ethiopialearn/common';
import { isNoSuchUpload, S3StorageProvider, UploadedPart } from '@ethiopialearn/storage';
import { CourseService } from './course.service';
import { UploadSession } from './upload-session.entity';
import {
  CompleteMultipartUploadDto,
  CreateMultipartUploadDto,
  CreateUploadDto,
  IMAGE_CONTENT_TYPES,
  MiB,
  SignPartsDto,
  SMALL_UPLOAD_MAX_BYTES,
  VIDEO_CONTENT_TYPES,
} from './upload.dto';

/** R2/S3 reject non-trailing parts under 5 MiB; 8 MiB keeps a 2 GiB file at 256 parts. */
export const MIN_PART_SIZE = 8 * MiB;
/** Hard S3/R2 limit on parts per upload. */
export const MAX_PARTS = 10_000;
/** The bucket's lifecycle rule aborts unfinished multipart uploads after 7 days. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Unfinished uploads per owner. Sessions the browser has no resume record for
 * (another device, cleared site data, a create retried after a lost response)
 * still count, and the UI cannot discard them, so the cap is generous and old
 * sessions are reclaimed when it is reached (see IDLE_SESSION_MS).
 */
export const MAX_OPEN_SESSIONS = 10;
/** At the cap, sessions started longer ago than this are cancelled (oldest first) to make room. */
export const IDLE_SESSION_MS = 24 * 60 * 60 * 1000;
/** Part URLs outlive a slow part on a bad connection; the client refreshes near expiry. */
export const PART_URL_TTL_SECONDS = 2 * 60 * 60;
const SMALL_URL_TTL_SECONDS = 15 * 60;

/**
 * Every non-trailing part must be the same size (R2 rejects the upload with
 * InvalidPart otherwise), so the size is fixed per session: at least 8 MiB,
 * and large enough to stay within 10,000 parts, rounded up to whole MiB.
 */
export function partPlan(size: number): { part_size: number; part_count: number } {
  const part_size = Math.max(MIN_PART_SIZE, Math.ceil(Math.ceil(size / MAX_PARTS) / MiB) * MiB);
  return { part_size, part_count: Math.ceil(size / part_size) };
}

export function expectedPartSize(plan: { size: number; part_size: number; part_count: number }, partNumber: number): number {
  return partNumber < plan.part_count ? plan.part_size : plan.size - (plan.part_count - 1) * plan.part_size;
}

/** Part numbers (1-based) that are absent or whose stored size differs from the plan. */
export function missingParts(
  plan: { size: number; part_size: number; part_count: number },
  parts: Array<{ part_number: number; size: number }>,
): number[] {
  const sizes = new Map(parts.map((p) => [p.part_number, p.size]));
  const missing: number[] = [];
  for (let n = 1; n <= plan.part_count; n++) {
    if (sizes.get(n) !== expectedPartSize(plan, n)) missing.push(n);
  }
  return missing;
}

/** Object-key-safe file name; long names keep their extension. */
export function safeFileName(filename: string): string {
  const cleaned = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 120 - ext.length) + ext;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * MiB ? `${+(bytes / (1024 * MiB)).toFixed(1)} GB` : `${Math.round(bytes / MiB)} MB`;
}

/**
 * Presigned uploads. The API never touches file bytes (the gateway proxy
 * times out at 30 s): it hands out URLs with the exact size signed in, and
 * for multipart uploads lists what storage received and completes the upload
 * itself, so the browser never needs part ETags.
 */
@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    @InjectRepository(UploadSession) private readonly sessions: Repository<UploadSession>,
    private readonly storage: S3StorageProvider,
    private readonly courses: CourseService,
  ) {}

  maxVideoBytes(): number {
    return envInt('MAX_VIDEO_UPLOAD_BYTES', 2 * 1024 * MiB);
  }

  /** Single presigned PUT for thumbnails, photos and short videos. */
  async createSmall(ctx: UserContext, dto: CreateUploadDto) {
    const images = IMAGE_CONTENT_TYPES as readonly string[];
    const videos = VIDEO_CONTENT_TYPES as readonly string[];
    if (dto.kind === 'video' ? !videos.includes(dto.content_type) : !images.includes(dto.content_type)) {
      throw new BadRequestException(
        dto.kind === 'video'
          ? 'Videos must be MP4, WebM, MOV or M4V. Convert other formats to MP4 (H.264) first.'
          : 'Images must be JPEG, PNG or WebP.',
      );
    }
    const max = SMALL_UPLOAD_MAX_BYTES[dto.kind];
    if (dto.size > max) {
      throw new BadRequestException(
        dto.kind === 'video'
          ? `Videos over ${formatBytes(max)} use the resumable uploader (POST /uploads/multipart).`
          : `Images can be at most ${formatBytes(max)} — resize or compress it and try again.`,
      );
    }
    if (dto.lesson_id && dto.kind !== 'video') {
      throw new BadRequestException('lesson_id applies to video uploads only — leave it out for thumbnails and photos.');
    }
    // Without the lesson, a platform admin's short video would upload under
    // the admin's own prefix and then fail to attach (VideoKeyService).
    const keyOwner = await this.keyOwnerFor(ctx, dto.lesson_id);
    const key = `${dto.kind}s/${keyOwner}/${randomUUID()}-${safeFileName(dto.filename)}`;
    const upload = await this.storageCall(
      () => this.storage.getSignedUploadUrl(key, dto.content_type, SMALL_URL_TTL_SECONDS, dto.size),
      'prepare the upload',
    );
    return { upload_url: upload.url, key };
  }

  async createMultipart(ctx: UserContext, dto: CreateMultipartUploadDto) {
    const max = this.maxVideoBytes();
    if (dto.size > max) {
      throw new BadRequestException(
        `This video is ${formatBytes(dto.size)}; the limit is ${formatBytes(max)}. Compress it (MP4, H.264) or split it into shorter lessons.`,
      );
    }

    const keyOwner = await this.keyOwnerFor(ctx, dto.lesson_id);

    let open = await this.countOpen(ctx);
    if (open >= MAX_OPEN_SESSIONS) {
      // Only reclaim at the cap, and only as many as needed: a day-old session
      // may still be one the user means to resume, but one they cannot see or
      // discard must not block new uploads for a week.
      await this.reapIdleSessions(ctx, open - MAX_OPEN_SESSIONS + 1);
      open = await this.countOpen(ctx);
    }
    if (open >= MAX_OPEN_SESSIONS) {
      throw new ConflictException(
        `Finish or cancel an unfinished upload first — you have ${open} video uploads from the last 24 hours still in progress ` +
          `(at most ${MAX_OPEN_SESSIONS} at a time). On the device you started one from, open its lesson and use the ` +
          '"Unfinished upload" note to resume it (choose the same file) or discard it. Otherwise try again tomorrow: ' +
          'uploads left unfinished for 24 hours are cancelled automatically to make room.',
      );
    }

    const { part_size, part_count } = partPlan(dto.size);
    const key = `videos/${keyOwner}/${randomUUID()}-${safeFileName(dto.filename)}`;
    // The object's Content-Type is fixed here, server-side; part PUTs cannot change it.
    const uploadId = await this.storageCall(() => this.storage.createMultipartUpload(key, dto.content_type), 'start the upload');
    try {
      const session = await this.sessions.save(
        this.sessions.create({
          owner_id: ctx.id,
          kind: 'video',
          lesson_id: dto.lesson_id ?? null,
          key,
          upload_id: uploadId,
          filename: dto.filename,
          content_type: dto.content_type,
          size: dto.size,
          part_size,
          part_count,
          status: 'uploading',
          completed_at: null,
        }),
      );
      return { session_id: session.id, key, part_size, part_count, size: dto.size };
    } catch (err) {
      await this.storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
      throw err;
    }
  }

  async signParts(ctx: UserContext, sessionId: string, dto: SignPartsDto) {
    const session = await this.ownedSession(ctx, sessionId);
    if (session.status !== 'uploading' || (await this.expireIfStale(session))) {
      throw new NotFoundException('This upload is no longer active. Start the upload again.');
    }
    const outOfRange = dto.part_numbers.filter((n) => n > session.part_count);
    if (outOfRange.length) {
      throw new BadRequestException(`This upload has ${session.part_count} parts; part ${outOfRange[0]} does not exist.`);
    }
    // Stamped before signing so the reported expiry is never later than the real one.
    const expiresAt = new Date(Date.now() + PART_URL_TTL_SECONDS * 1000);
    const urls = await this.storageCall(
      () =>
        Promise.all(
          dto.part_numbers.map(async (n) => ({
            part_number: n,
            url: await this.storage.presignUploadPart(session.key, session.upload_id, n, expectedPartSize(session, n), PART_URL_TTL_SECONDS),
          })),
        ),
      'sign the upload',
    );
    // expires_in lets the client judge freshness without trusting its own clock against expires_at.
    return { urls, expires_at: expiresAt.toISOString(), expires_in: PART_URL_TTL_SECONDS };
  }

  /**
   * Resume point. `status` is 'uploading' | 'completed' | 'expired'; expired
   * covers cancelled uploads and ones storage has already discarded — the
   * client starts a new upload for both.
   */
  async status(ctx: UserContext, sessionId: string) {
    const session = await this.ownedSession(ctx, sessionId);
    const base = { size: session.size, part_size: session.part_size, part_count: session.part_count };
    if (session.status === 'completed') {
      return { status: 'completed' as const, ...base, parts: [], uploaded_bytes: session.size };
    }
    const expired = { status: 'expired' as const, ...base, parts: [], uploaded_bytes: 0 };
    if (session.status === 'aborted' || (await this.expireIfStale(session))) return expired;

    let parts: UploadedPart[];
    try {
      parts = await this.storage.listAllParts(session.key, session.upload_id);
    } catch (err) {
      if (!isNoSuchUpload(err)) throw this.storageDown(err, 'check the upload');
      await this.markAborted(session);
      return expired;
    }
    const inPlan = parts.filter((p) => p.part_number >= 1 && p.part_number <= session.part_count);
    // Only parts at their planned size count as done: the client re-sends the rest.
    const uploadedBytes = inPlan
      .filter((p) => p.size === expectedPartSize(session, p.part_number))
      .reduce((sum, p) => sum + p.size, 0);
    return {
      status: 'uploading' as const,
      ...base,
      parts: inPlan.map((p) => ({ part_number: p.part_number, size: p.size })),
      uploaded_bytes: uploadedBytes,
    };
  }

  async complete(ctx: UserContext, sessionId: string, dto: CompleteMultipartUploadDto) {
    const session = await this.ownedSession(ctx, sessionId);
    const lessonId = dto.lesson_id ?? session.lesson_id;
    if (session.status === 'completed') return this.completedResult(ctx, session, lessonId);
    if (session.status === 'aborted') throw this.gone();

    let parts: UploadedPart[];
    try {
      parts = await this.storage.listAllParts(session.key, session.upload_id);
    } catch (err) {
      if (!isNoSuchUpload(err)) throw this.storageDown(err, 'finish the upload');
      return this.finishFromStoredObject(ctx, session, lessonId);
    }

    const missing = missingParts(session, parts);
    if (missing.length) {
      throw new ConflictException({
        statusCode: 409,
        message: `${missing.length} part(s) of this video have not finished uploading. Upload them and finish again.`,
        missing,
      });
    }
    // Every planned part now has its planned size, and those sizes sum to the
    // declared (capped) size by construction. Parts outside the plan are left
    // out of the completion, so storage discards them.
    const planned = parts.filter((p) => p.part_number <= session.part_count);
    try {
      await this.storage.completeMultipartUpload(
        session.key,
        session.upload_id,
        planned.map((p) => ({ part_number: p.part_number, etag: p.etag })),
      );
    } catch (err) {
      if (!isNoSuchUpload(err)) throw this.storageDown(err, 'finish the upload');
      // A previous complete may have succeeded with its response lost.
    }
    return this.finishFromStoredObject(ctx, session, lessonId);
  }

  async abort(ctx: UserContext, sessionId: string) {
    const session = await this.ownedSession(ctx, sessionId);
    if (session.status === 'completed') {
      throw new ConflictException('This upload already finished. Remove the video from the lesson if you do not want it.');
    }
    if (session.status === 'uploading') {
      await this.storageCall(() => this.storage.abortMultipartUpload(session.key, session.upload_id), 'cancel the upload');
      // A complete from another tab may have assembled the object a moment before this
      // cancel: the upload is finished (and possibly attached), so say so instead of "aborted".
      const stored = await this.storageCall(() => this.storage.headObject(session.key), 'check the upload');
      if (stored && stored.size === session.size) {
        throw new ConflictException('This upload already finished. Remove the video from the lesson if you do not want it.');
      }
      await this.markAborted(session);
    }
    return { aborted: true };
  }

  /** The caller's unfinished uploads (optionally for one lesson), for the "resume upload" hint. */
  async listOpen(ctx: UserContext, lessonId?: string) {
    if (lessonId !== undefined && !isUUID(lessonId)) throw new BadRequestException('lesson_id must be a lesson id.');
    const rows = await this.sessions.find({
      where: {
        owner_id: ctx.id,
        status: 'uploading',
        created_at: MoreThan(new Date(Date.now() - SESSION_TTL_MS)),
        ...(lessonId ? { lesson_id: lessonId } : {}),
      },
      order: { created_at: 'DESC' },
    });
    return rows.map((s) => ({
      session_id: s.id,
      key: s.key,
      lesson_id: s.lesson_id,
      filename: s.filename,
      content_type: s.content_type,
      size: s.size,
      part_size: s.part_size,
      part_count: s.part_count,
      created_at: s.created_at,
    }));
  }

  // ---- internals ----

  /**
   * Uploads for a lesson are keyed under the course author's prefix, not the
   * caller's: attaching runs VideoKeyService, which only accepts the author's
   * (or owning account's) prefix, and a platform admin may upload on an
   * educator's behalf. The editability check also fails the request before
   * any bytes move.
   */
  private async keyOwnerFor(ctx: UserContext, lessonId: string | undefined): Promise<string> {
    if (!lessonId) return ctx.id;
    const { course } = await this.courses.assertLessonEditable(ctx, lessonId);
    return course.created_by;
  }

  /** Sessions that still hold a slot: 'uploading' and young enough that storage has not discarded them. */
  private countOpen(ctx: UserContext): Promise<number> {
    return this.sessions.count({
      where: { owner_id: ctx.id, status: 'uploading', created_at: MoreThan(new Date(Date.now() - SESSION_TTL_MS)) },
    });
  }

  /**
   * Cancels up to `limit` of the owner's counted sessions started more than
   * IDLE_SESSION_MS ago, oldest first: storage first (idempotent), then the
   * row, so a storage outage leaves the session intact and surfaces as a 503.
   */
  private async reapIdleSessions(ctx: UserContext, limit: number): Promise<void> {
    const now = Date.now();
    const idle = await this.sessions.find({
      where: {
        owner_id: ctx.id,
        status: 'uploading',
        created_at: Between(new Date(now - SESSION_TTL_MS), new Date(now - IDLE_SESSION_MS)),
      },
      order: { created_at: 'ASC' },
      take: limit,
    });
    for (const session of idle) {
      await this.storageCall(() => this.storage.abortMultipartUpload(session.key, session.upload_id), 'make room for a new upload');
      await this.markAborted(session);
      this.logger.log(`Cancelled idle upload ${session.id} (owner ${ctx.id}) to make room under the open-upload cap`);
    }
  }

  /** Sessions are only ever visible to their owner; anything else is a 404 so ids reveal nothing. */
  private async ownedSession(ctx: UserContext, sessionId: string): Promise<UploadSession> {
    const session = isUUID(sessionId) ? await this.sessions.findOne({ where: { id: sessionId, owner_id: ctx.id } }) : null;
    if (!session) throw new NotFoundException('Upload not found. Start the upload again.');
    return session;
  }

  /** Storage has discarded the parts of uploads this old, whatever the row says. */
  private async expireIfStale(session: UploadSession): Promise<boolean> {
    if (session.status !== 'uploading' || Date.now() - new Date(session.created_at).getTime() < SESSION_TTL_MS) return false;
    await this.markAborted(session);
    return true;
  }

  /** Final check once storage says the upload is done (or gone): the object must exist at the declared size. */
  private async finishFromStoredObject(ctx: UserContext, session: UploadSession, lessonId: string | null) {
    const stored = await this.storageCall(() => this.storage.headObject(session.key), 'confirm the upload');
    if (!stored || stored.size !== session.size) {
      await this.markAborted(session);
      throw this.gone();
    }
    session.status = 'completed';
    session.completed_at = new Date();
    await this.sessions.update({ id: session.id }, { status: 'completed', completed_at: session.completed_at });
    return this.completedResult(ctx, session, lessonId);
  }

  /**
   * Attaches through CourseService.updateLesson so ownership, staging on live
   * courses and key validation all apply. Re-running complete on a finished
   * upload (lost response) skips the write when the lesson already holds the
   * key, so the retry cannot fail on a course that moved into review since.
   */
  private async completedResult(ctx: UserContext, session: UploadSession, lessonId: string | null) {
    let lessonUpdated = false;
    if (lessonId) {
      const current = await this.courses.lessonWithCourse(lessonId).catch(() => null);
      const held = current && (current.lesson.video_s3_key === session.key || current.lesson.pending?.video_s3_key === session.key);
      if (!held) await this.courses.updateLesson(ctx, lessonId, { video_s3_key: session.key });
      lessonUpdated = true;
    }
    return { key: session.key, size: session.size, lesson_updated: lessonUpdated };
  }

  private async markAborted(session: UploadSession): Promise<void> {
    session.status = 'aborted';
    await this.sessions.update({ id: session.id, status: 'uploading' }, { status: 'aborted' });
  }

  private gone() {
    return new GoneException('This upload expired or was cancelled before it finished. Start the upload again.');
  }

  private async storageCall<T>(fn: () => Promise<T>, action: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw this.storageDown(err, action);
    }
  }

  private storageDown(err: unknown, action: string) {
    this.logger.error(`Storage failed to ${action}: ${(err as Error)?.message ?? err}`);
    return new ServiceUnavailableException(`Could not ${action} — video storage is not responding. Try again in a minute.`);
  }
}
