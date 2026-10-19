import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, MoreThan, Repository } from 'typeorm';
import {
  courseLessonIds,
  mapLimited,
  envInt,
  EventBusService,
  InternalHttpClient,
  internalPath,
  isUniqueViolation,
  OutboxService,
  PeerNotFoundError,
  UserContext,
} from '@ethiopialearn/common';
import {
  CourseCompletedPayload,
  CourseProgressMilestonePayload,
  CoursePublishedPayload,
  CourseRevisionClosedPayload,
  EnrollmentCreatedPayload,
  EntitlementStatus,
  LearnerInactivePayload,
  PaymentConfirmedPayload,
  PricingType,
  RefundDecisionPayload,
  Role,
  SponsorshipGrantedPayload,
} from '@ethiopialearn/contracts';
import { CourseCache, Enrollment, LessonProgress, VideoProgress } from './entities';
import { TtlLru } from './ttl-lru';

interface CourseInfo {
  id: string;
  title: string;
  owner_id: string;
  owner_type: string;
  pricing_type: PricingType;
  status: string;
}

/** What progress needs from the course service's internal lesson. */
interface LiveLesson {
  course_id: string;
  has_video: boolean;
  /** Measured length of the video; null when unknown. */
  video_duration_seconds: number | null;
}

/**
 * The length a video must be watched against: the measured duration when the
 * lesson has one, else the longest client-reported duration. The editor's
 * "minutes" estimate is display only and never counts.
 */
function requiredSeconds(lesson: LiveLesson, row: VideoProgress | null): number {
  return lesson.video_duration_seconds ?? row?.duration_seconds ?? 0;
}

const MILESTONES = [25, 50, 75] as const;

/** Enrollments re-checked per query when a revision removes lessons. */
const RECHECK_BATCH = 200;

/** "My learning" shows a learner's newest enrollments, at most this many (Phase 9e). */
const LEARNER_LIST_CAP = 200;

/** A cached live lesson (`lesson:<id>`) or a course's live lesson ids (`course:<id>`). */
type HeartbeatCacheEntry = { kind: 'lesson'; lesson: LiveLesson } | { kind: 'course'; courseId: string; lessonIds: string[] };

@Injectable()
export class EnrollmentService implements OnModuleInit {
  private readonly logger = new Logger(EnrollmentService.name);
  /**
   * Heartbeats repeat every ~10 s, so lesson lookups and a course's lesson ids
   * are kept for 60 s (Phase 9e). An applied revision clears its course's
   * entries; the TTL bounds anything missed. A failed lookup is never cached.
   */
  private readonly heartbeatCache = new TtlLru<HeartbeatCacheEntry>(60_000, 1000);

  constructor(
    @InjectRepository(Enrollment) private readonly enrollments: Repository<Enrollment>,
    @InjectRepository(LessonProgress) private readonly progress: Repository<LessonProgress>,
    @InjectRepository(CourseCache) private readonly courseCache: Repository<CourseCache>,
    @InjectRepository(VideoProgress) private readonly videoProgress: Repository<VideoProgress>,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit() {
    // THE only paths to paid entitlement (spec §0 rule 3 / §12.2): a verified
    // payment by the learner, or a verified payment by a sponsor on their behalf.
    this.bus.subscribe<PaymentConfirmedPayload>('PaymentConfirmed', (p) => this.grantFromPayment(p));
    this.bus.subscribe<SponsorshipGrantedPayload>('SponsorshipGranted', (p) => this.grantFromSponsorship(p));
    this.bus.subscribe<RefundDecisionPayload>('RefundApproved', (p) => this.revokeFromRefund(p));
    this.bus.subscribe<CoursePublishedPayload>('CoursePublished', async (p) => {
      await this.courseCache.save(
        this.courseCache.create({
          course_id: p.course_id,
          title: p.title,
          pricing_type: p.pricing_type,
          owner_id: p.owner_id,
          owner_type: p.owner_type,
        }),
      );
    });
    this.bus.subscribe<CourseRevisionClosedPayload>('CourseRevisionClosed', (p) => this.onRevisionApplied(p));
  }

  /** Direct enrollment — FREE courses only. Paid/freemium go through the payment flow (spec §4.3). */
  async enrollFree(ctx: UserContext, courseId: string) {
    const course = await this.internal.get<CourseInfo>(internalPath`/api/v1/internal/courses/${courseId}`);
    if (course.status !== 'published') throw new NotFoundException('Course not available');
    if (course.pricing_type !== PricingType.FREE) {
      throw new BadRequestException('This course requires payment — use POST /payments/initiate');
    }
    let enrollment = await this.enrollments.findOne({ where: { learner_id: ctx.id, course_id: courseId } });
    if (enrollment?.entitlement_status === EntitlementStatus.ACTIVE) return enrollment;
    if (!enrollment) {
      enrollment = this.enrollments.create({ learner_id: ctx.id, course_id: courseId, source: 'free' });
    }
    enrollment.entitlement_status = EntitlementStatus.ACTIVE;
    return this.saveActivated(enrollment, course.title, ctx.email, course.pricing_type);
  }

  /**
   * "My learning": the newest 200 enrollments with titles and progress, in one
   * titles query, one lesson-ids batch call and one grouped count. Progress is
   * display only: when course can't answer, it is null ("—"), never 0.
   */
  async listForLearner(ctx: UserContext) {
    const rows = await this.enrollments.find({ where: { learner_id: ctx.id }, order: { enrolled_at: 'DESC' }, take: LEARNER_LIST_CAP });
    if (!rows.length) return [];
    const titles = new Map(
      (await this.courseCache.find({ where: { course_id: In([...new Set(rows.map((r) => r.course_id))]) } })).map((c) => [c.course_id, c.title]),
    );
    const percents = await this.percentsOrNull(rows, 'My learning');
    return rows.map((enrollment) => ({
      id: enrollment.id,
      course_id: enrollment.course_id,
      course_title: titles.get(enrollment.course_id) ?? null,
      entitlement_status: enrollment.entitlement_status,
      enrolled_at: enrollment.enrolled_at,
      completed_at: enrollment.completed_at,
      progress_percent: percents?.get(enrollment.id) ?? null,
      source: enrollment.source,
      last_activity_at: enrollment.last_activity_at,
    }));
  }

  /** Polled by the frontend after the Chapa redirect (spec §6 step 8). */
  async status(ctx: UserContext, courseId: string) {
    const enrollment = await this.enrollments.findOne({ where: { learner_id: ctx.id, course_id: courseId } });
    return { entitlement_status: enrollment?.entitlement_status ?? EntitlementStatus.NONE, enrollment_id: enrollment?.id ?? null };
  }

  async detail(ctx: UserContext, enrollmentId: string) {
    const enrollment = await this.owned(ctx, enrollmentId);
    return { ...enrollment, progress_percent: await this.progressPercent(enrollment) };
  }

  async progressDetail(ctx: UserContext, enrollmentId: string) {
    const enrollment = await this.owned(ctx, enrollmentId);
    const rows = await this.progress.find({ where: { enrollment_id: enrollmentId } });
    return {
      enrollment_id: enrollmentId,
      completed_lessons: rows.map((r) => ({ lesson_id: r.lesson_id, completed_at: r.completed_at })),
      progress_percent: await this.progressPercent(enrollment),
      completed_at: enrollment.completed_at,
      changelog_seen_at: enrollment.changelog_seen_at,
      last_activity_at: enrollment.last_activity_at,
    };
  }

  /**
   * A lesson without video completes on request. A video lesson completes only
   * under the watch rule (completeIfWatched), after applying `positionSeconds`,
   * when sent, as a final heartbeat; otherwise 409.
   */
  async completeLesson(ctx: UserContext, lessonId: string, positionSeconds?: number) {
    const lesson = await this.liveLesson(lessonId);
    const enrollment = await this.enrollments.findOne({ where: { learner_id: ctx.id, course_id: lesson.course_id } });
    if (!enrollment || enrollment.entitlement_status !== EntitlementStatus.ACTIVE) {
      throw new ForbiddenException('No active entitlement for this course');
    }
    if (lesson.has_video) {
      const touched = positionSeconds != null;
      const row = touched
        ? await this.applyHeartbeat(enrollment, lesson, lessonId, positionSeconds, 0)
        : await this.videoProgress.findOne({ where: { enrollment_id: enrollment.id, lesson_id: lessonId } });
      const watch = await this.completeIfWatched(ctx, enrollment, lesson, lessonId, row, '/complete', touched);
      if (!watch.completed) {
        throw new ConflictException({
          statusCode: 409,
          message: 'Finish watching this lesson to complete it.',
          ...(watch.retryAfterSeconds === null ? {} : { retry_after_seconds: watch.retryAfterSeconds }),
        });
      }
    } else {
      await this.recordCompletion(enrollment, lessonId, ctx.email, false);
    }
    return this.progressDetail(ctx, enrollment.id);
  }

  /**
   * Heartbeat from the video player (every ~10s / on pause / on leave).
   * position_seconds is the resume point; percent_watched is a high-water mark
   * (idempotent + commutative, so offline replays can never corrupt it).
   * Reaching 90% completes the lesson once the watch rule is met; an early
   * claim only records progress (`completed: false`).
   */
  async saveVideoProgress(ctx: UserContext, lessonId: string, positionSeconds: number, durationSeconds: number) {
    const lesson = await this.liveLesson(lessonId);
    const enrollment = await this.enrollments.findOne({ where: { learner_id: ctx.id, course_id: lesson.course_id } });
    if (!enrollment || enrollment.entitlement_status !== EntitlementStatus.ACTIVE) {
      throw new ForbiddenException('No active entitlement for this course');
    }
    const row = await this.applyHeartbeat(enrollment, lesson, lessonId, positionSeconds, durationSeconds);
    const watch = await this.completeIfWatched(ctx, enrollment, lesson, lessonId, row, 'heartbeat', true);
    return {
      lesson_id: lessonId,
      position_seconds: row.position_seconds,
      duration_seconds: row.duration_seconds,
      percent_watched: row.percent_watched,
      completed: watch.completed,
    };
  }

  /** Stores one player heartbeat (the endpoint's, or /complete's final position) and touches the enrollment. */
  private async applyHeartbeat(
    enrollment: Enrollment,
    lesson: LiveLesson,
    lessonId: string,
    positionSeconds: number,
    durationSeconds: number,
  ): Promise<VideoProgress> {
    const where = { enrollment_id: enrollment.id, lesson_id: lessonId };
    const apply = (row: VideoProgress) => {
      row.duration_seconds = Math.max(row.duration_seconds ?? 0, durationSeconds);
      const required = requiredSeconds(lesson, row);
      row.position_seconds = Math.min(Math.max(0, positionSeconds), required + 5);
      const percent = required > 0 ? Math.min(100, Math.round((row.position_seconds / required) * 100)) : 0;
      row.percent_watched = Math.max(row.percent_watched ?? 0, percent);
      // COALESCE(started_at, now): the first heartbeat of this video starts the clock; later ones never move it.
      row.started_at ??= new Date();
      return row;
    };
    const existing = await this.videoProgress.findOne({ where });
    let saved: VideoProgress;
    try {
      saved = await this.videoProgress.save(apply(existing ?? this.videoProgress.create(where)));
    } catch (err) {
      // First heartbeats sent together (pause, ended, /complete) all insert; the
      // unique constraint keeps one row, and the others are applied to it.
      if (existing || !isUniqueViolation(err)) throw err;
      const row = await this.videoProgress.findOne({ where });
      if (!row) throw err;
      saved = await this.videoProgress.save(apply(row));
    }
    await this.touch(enrollment);
    return saved;
  }

  /**
   * The video completion rule: the learner reached 90% of the required length,
   * and at least 45% of it has passed in real time since they started (2x
   * playback with a little slack). A null started_at (a replaced video not
   * watched since) or an unknown length never meets it. Completes the lesson
   * when met; `completed` also covers a lesson completed earlier.
   * `retryAfterSeconds` is set when only the elapsed time is missing.
   */
  private async completeIfWatched(
    ctx: UserContext,
    enrollment: Enrollment,
    lesson: LiveLesson,
    lessonId: string,
    row: VideoProgress | null,
    source: 'heartbeat' | '/complete',
    touched: boolean,
  ): Promise<{ completed: boolean; retryAfterSeconds: number | null }> {
    const required = requiredSeconds(lesson, row);
    const reached = required > 0 && (row?.percent_watched ?? 0) >= 90;
    const elapsed = row?.started_at ? (Date.now() - row.started_at.getTime()) / 1000 : null;
    const timeLeft = elapsed === null ? null : 0.45 * required - elapsed;
    if (reached && timeLeft !== null && timeLeft <= 0) {
      await this.recordCompletion(enrollment, lessonId, ctx.email, touched);
      return { completed: true, retryAfterSeconds: null };
    }
    if (await this.progress.findOne({ where: { enrollment_id: enrollment.id, lesson_id: lessonId } })) {
      return { completed: true, retryAfterSeconds: null };
    }
    // A heartbeat below 90% claims nothing; one at 90%+ and every /complete do.
    if (reached || source === '/complete') {
      this.logger.log(
        `video completion refused (${source}): enrollment ${enrollment.id} lesson ${lessonId}, ` +
          `required ${required}s, elapsed ${elapsed === null ? 'none' : `${Math.floor(elapsed)}s`}`,
      );
    }
    return { completed: false, retryAfterSeconds: reached && timeLeft !== null ? Math.ceil(timeLeft) : null };
  }

  /** Everything the player needs to restore state: per-lesson positions + where to resume. */
  async videoProgressDetail(ctx: UserContext, enrollmentId: string) {
    await this.owned(ctx, enrollmentId);
    const rows = await this.videoProgress.find({ where: { enrollment_id: enrollmentId }, order: { updated_at: 'DESC' } });
    return {
      enrollment_id: enrollmentId,
      last_lesson_id: rows[0]?.lesson_id ?? null,
      lessons: rows.map((r) => ({
        lesson_id: r.lesson_id,
        position_seconds: r.position_seconds,
        duration_seconds: r.duration_seconds,
        percent_watched: r.percent_watched,
        updated_at: r.updated_at,
      })),
    };
  }

  /** Learner opened the change log — clears the "Updated" badge. */
  async markChangelogSeen(ctx: UserContext, enrollmentId: string) {
    const enrollment = await this.owned(ctx, enrollmentId);
    enrollment.changelog_seen_at = new Date();
    await this.enrollments.save(enrollment);
    return { changelog_seen_at: enrollment.changelog_seen_at };
  }

  /**
   * A lesson added by a revision that is not approved yet is invisible to
   * learners, so progress on it is refused until the revision goes live.
   * A course service that predates `has_video` (mid-deploy) sends neither
   * video field: the lesson is then treated as one without video.
   */
  private async liveLesson(lessonId: string): Promise<LiveLesson> {
    const hit = this.heartbeatCache.get(`lesson:${lessonId}`);
    if (hit?.kind === 'lesson') return hit.lesson;
    const lesson = await this.internal.get<{
      course_id: string;
      live?: boolean;
      has_video?: boolean;
      video_duration_seconds?: number | null;
    }>(internalPath`/api/v1/internal/lessons/${lessonId}`);
    if (lesson.live === false) throw new NotFoundException('Lesson not available yet');
    const live: LiveLesson = {
      course_id: lesson.course_id,
      has_video: lesson.has_video === true,
      video_duration_seconds: lesson.video_duration_seconds ?? null,
    };
    this.heartbeatCache.set(`lesson:${lessonId}`, { kind: 'lesson', lesson: live });
    return live;
  }

  /** A course's live lesson ids, cached with the heartbeat's lessons. Strict: a failure propagates and isn't cached. */
  private async cachedLessonIds(courseId: string): Promise<string[]> {
    const hit = this.heartbeatCache.get(`course:${courseId}`);
    if (hit?.kind === 'course') return hit.lessonIds;
    const { lesson_ids } = await this.internal.get<{ lesson_ids: string[] }>(internalPath`/api/v1/internal/courses/${courseId}/lesson-ids`);
    this.heartbeatCache.set(`course:${courseId}`, { kind: 'course', courseId, lessonIds: lesson_ids });
    return lesson_ids;
  }

  /**
   * Records a completed lesson. `touched`: this request already touched the
   * enrollment (a heartbeat), so it isn't written again. Milestones run only
   * for a newly completed lesson; completion detection runs on every call
   * while the course isn't complete, so a check that failed (course asleep as
   * the last lesson completed) heals on the next beat. Both share one cached
   * lesson-ids read.
   */
  private async recordCompletion(enrollment: Enrollment, lessonId: string, learnerEmail: string, touched: boolean) {
    const existing = await this.progress.findOne({ where: { enrollment_id: enrollment.id, lesson_id: lessonId } });
    if (!existing) {
      await this.progress.save(this.progress.create({ enrollment_id: enrollment.id, lesson_id: lessonId, completed_at: new Date() }));
    }
    if (!touched) await this.touch(enrollment);
    if (enrollment.completed_at) return;
    const lessonIds = await this.cachedLessonIds(enrollment.course_id);
    if (!existing) await this.announceMilestone(enrollment, learnerEmail, lessonIds);
    await this.detectCompletion(enrollment, learnerEmail, lessonIds);
  }

  /** Any learning activity resets the inactivity escalation: one UPDATE of those two columns. */
  private async touch(enrollment: Enrollment) {
    await this.enrollments.update({ id: enrollment.id }, { last_activity_at: () => 'now()', nudge_level: 0 });
    enrollment.last_activity_at = new Date();
    enrollment.nudge_level = 0;
  }

  /** "You're 50% through" — each of 25/50/75 fires exactly once per enrollment. */
  private async announceMilestone(enrollment: Enrollment, learnerEmail: string, lessonIds: string[]) {
    if (enrollment.completed_at) return;
    const percent = await this.progressPercent(enrollment, lessonIds);
    if (percent == null) return; // unknown now; the next lesson completion announces it
    const sent = enrollment.milestones_sent ?? [];
    const due = MILESTONES.filter((m) => percent >= m && !sent.includes(m));
    if (!due.length) return;
    const highest = due[due.length - 1];
    enrollment.milestones_sent = [...sent, ...due];
    await this.enrollments.save(enrollment);
    const cached = await this.courseCache.findOne({ where: { course_id: enrollment.course_id } });
    // Notification-only, so it stays on publish() (Phase 9b non-goal). Not awaited: with the
    // broker down, publish() waits EVENT_PUBLISH_WAIT_MS and throws, which would hold the
    // lesson request and fail it before detectCompletion commits the course's completion.
    void this.bus
      .publish<CourseProgressMilestonePayload>('CourseProgressMilestone', {
        enrollment_id: enrollment.id,
        learner_id: enrollment.learner_id,
        learner_email: learnerEmail,
        course_id: enrollment.course_id,
        course_title: cached?.title ?? 'your course',
        percent: highest,
      })
      .catch((err: Error) => this.logger.warn(`CourseProgressMilestone not published: ${err.message}`));
  }

  /**
   * Inactivity nudges, daily at 06:00 UTC (09:00 Addis). An active, unfinished
   * enrollment with no activity for INACTIVITY_DAYS gets an in-app ping; if it
   * is still idle after INACTIVITY_EMAIL_DAYS it gets one email. Any activity
   * resets the ladder (see touch()). The `inactivity` job (jobs.ts).
   */
  async nudgeInactiveLearners(): Promise<{ sent: number }> {
    const inAppDays = envInt('INACTIVITY_DAYS', 7);
    const emailDays = envInt('INACTIVITY_EMAIL_DAYS', 14);
    const now = Date.now();
    const candidates = await this.enrollments.find({
      where: [
        { entitlement_status: EntitlementStatus.ACTIVE, completed_at: IsNull(), nudge_level: 0, last_activity_at: LessThan(new Date(now - inAppDays * 86_400_000)) },
        { entitlement_status: EntitlementStatus.ACTIVE, completed_at: IsNull(), nudge_level: 1, last_activity_at: LessThan(new Date(now - emailDays * 86_400_000)) },
        // Never-started enrollments: the clock runs from enrollment.
        { entitlement_status: EntitlementStatus.ACTIVE, completed_at: IsNull(), nudge_level: 0, last_activity_at: IsNull(), enrolled_at: LessThan(new Date(now - inAppDays * 86_400_000)) },
        { entitlement_status: EntitlementStatus.ACTIVE, completed_at: IsNull(), nudge_level: 1, last_activity_at: IsNull(), enrolled_at: LessThan(new Date(now - emailDays * 86_400_000)) },
      ],
      take: 500,
    });
    const titles = candidates.length
      ? new Map((await this.courseCache.find({ where: { course_id: In([...new Set(candidates.map((e) => e.course_id))]) } })).map((c) => [c.course_id, c.title]))
      : new Map<string, string>();
    const percents = await this.percentsOrNull(candidates, 'inactivity nudges');
    // Progress unknown (course asleep): send nothing and claim nothing, so the
    // next run nudges with the real percentage instead of "0%" (P1-18).
    if (!percents) return { sent: 0 };
    let sent = 0;
    for (const e of candidates) {
      const since = e.last_activity_at ?? e.enrolled_at;
      const days = Math.floor((now - since.getTime()) / 86_400_000);
      const channel: 'in_app' | 'email' = e.nudge_level === 0 ? 'in_app' : 'email';
      e.nudge_level = e.nudge_level === 0 ? 1 : 2;
      await this.enrollments.save(e);
      await this.bus.publish<LearnerInactivePayload>('LearnerInactive', {
        enrollment_id: e.id,
        learner_id: e.learner_id,
        course_id: e.course_id,
        course_title: titles.get(e.course_id) ?? 'your course',
        days_inactive: days,
        progress_percent: percents.get(e.id) ?? 0,
        channel,
      });
      sent += 1;
    }
    if (sent) this.logger.log(`inactivity nudges published: ${sent}`);
    return { sent };
  }

  // ---- Analytics ---------------------------------------------------------

  /**
   * Per-course learner funnel for educators / institutions / admins, in SQL
   * (Phase 9e): ownership from course (in parallel), one lesson-ids batch call,
   * one grouped funnel query and one grouped months query. Strict: a course
   * service that can't answer is a 503, never a funnel of zeros. A course
   * course doesn't know is skipped.
   */
  async analytics(ctx: UserContext, courseIds: string[]) {
    const ids = [...new Set(courseIds)].slice(0, 25);
    const ownerIds = await this.ownerIdsFor(ctx);
    const found = await mapLimited(ids, async (courseId) => {
      try {
        return await this.internal.get<CourseInfo>(internalPath`/api/v1/internal/courses/${courseId}`);
      } catch (err) {
        if (err instanceof PeerNotFoundError) return null;
        throw err;
      }
    });
    const courses = found.filter((c): c is CourseInfo => !!c && (ctx.role === Role.PLATFORM_ADMIN || ownerIds.includes(c.owner_id)));
    if (!courses.length) return [];
    const lessonIds = await courseLessonIds(this.internal, courses.map((c) => c.id));
    const counts = courses.map((c) => lessonIds.get(c.id)?.length ?? 0);
    const now = Date.now();
    const funnel: Array<Record<string, string> & { course_id: string }> = await this.enrollments.query(
      `WITH done AS (
         SELECT p.enrollment_id, COUNT(*)::int AS n
         FROM ${this.progress.metadata.tablePath} p
         JOIN ${this.enrollments.metadata.tablePath} e ON e.id = p.enrollment_id
         WHERE e.course_id = ANY($1::uuid[])
         GROUP BY p.enrollment_id
       ), lc AS (SELECT * FROM unnest($1::uuid[], $2::int[]) AS t(course_id, lessons))
       SELECT e.course_id,
         COUNT(*) FILTER (WHERE e.entitlement_status = 'active') AS enrolled,
         COUNT(*) FILTER (WHERE e.entitlement_status = 'refunded') AS refunded,
         COUNT(*) FILTER (WHERE e.entitlement_status = 'active' AND e.completed_at IS NOT NULL) AS completed,
         COUNT(*) FILTER (WHERE e.entitlement_status = 'active' AND e.last_activity_at > $3) AS active_last_7d,
         COUNT(*) FILTER (WHERE e.entitlement_status = 'active' AND e.last_activity_at > $4) AS active_last_30d,
         COUNT(*) FILTER (WHERE e.entitlement_status = 'active' AND e.last_activity_at IS NULL AND COALESCE(d.n, 0) = 0) AS never_started,
         COUNT(*) FILTER (WHERE e.entitlement_status = 'active' AND e.source = 'sponsorship') AS sponsored,
         COALESCE(SUM(LEAST(COALESCE(d.n, 0), lc.lessons)) FILTER (WHERE e.entitlement_status = 'active'), 0) AS capped_done
       FROM ${this.enrollments.metadata.tablePath} e
       JOIN lc ON lc.course_id = e.course_id
       LEFT JOIN done d ON d.enrollment_id = e.id
       GROUP BY e.course_id`,
      [courses.map((c) => c.id), counts, new Date(now - 7 * 86_400_000), new Date(now - 30 * 86_400_000)],
    );
    const months = await this.monthCounts(courses.map((c) => c.id));
    const byCourse = new Map(funnel.map((r) => [r.course_id, r]));
    return courses.map((course, i) => {
      const r = byCourse.get(course.id);
      const n = (key: string) => Number(r?.[key] ?? 0);
      const active = n('enrolled');
      const lessons = counts[i];
      return {
        course_id: course.id,
        course_title: course.title,
        enrolled: active,
        refunded: n('refunded'),
        completed: n('completed'),
        completion_rate: active ? Math.round((n('completed') / active) * 100) : 0,
        // The mean of each active learner's min(100, done / lessons): the capped counts summed in SQL.
        avg_progress_percent: active && lessons ? Math.round((n('capped_done') * 100) / (lessons * active)) : 0,
        active_last_7d: n('active_last_7d'),
        active_last_30d: n('active_last_30d'),
        never_started: n('never_started'),
        sponsored: n('sponsored'),
        enrollments_by_month: this.monthSeries(months, `${course.id}:enrolled`),
        completions_by_month: this.monthSeries(months, `${course.id}:completed`),
      };
    });
  }

  /** Platform-wide learner funnel for the admin console: two aggregate queries, no rows loaded. */
  async adminAnalytics() {
    const [r]: Array<Record<string, string>> = await this.enrollments.query(
      `SELECT COUNT(*) AS enrollments_total,
         COUNT(*) FILTER (WHERE entitlement_status = 'active') AS active,
         COUNT(*) FILTER (WHERE entitlement_status = 'active' AND completed_at IS NOT NULL) AS completed,
         COUNT(*) FILTER (WHERE entitlement_status = 'refunded') AS refunded,
         COUNT(*) FILTER (WHERE entitlement_status = 'active' AND source = 'sponsorship') AS sponsored,
         COUNT(*) FILTER (WHERE entitlement_status = 'active' AND last_activity_at > $1) AS active_last_7d,
         COUNT(DISTINCT learner_id) FILTER (WHERE entitlement_status = 'active') AS distinct_learners
       FROM ${this.enrollments.metadata.tablePath}`,
      [new Date(Date.now() - 7 * 86_400_000)],
    );
    const months = await this.monthCounts(null);
    return {
      enrollments_total: Number(r.enrollments_total),
      active: Number(r.active),
      completed: Number(r.completed),
      refunded: Number(r.refunded),
      sponsored: Number(r.sponsored),
      active_last_7d: Number(r.active_last_7d),
      distinct_learners: Number(r.distinct_learners),
      enrollments_by_month: this.monthSeries(months, 'all:enrolled'),
      completions_by_month: this.monthSeries(months, 'all:completed'),
    };
  }

  /** The last 12 UTC months, oldest first, as `YYYY-MM`. */
  private lastTwelveMonths(): string[] {
    const start = new Date();
    return Array.from({ length: 12 }, (_, i) =>
      new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 11 + i, 1)).toISOString().slice(0, 7),
    );
  }

  /**
   * Active enrollments and completions per UTC month over the last 12, keyed
   * `<course_id|all>:<enrolled|completed>:<YYYY-MM>`. `AT TIME ZONE 'UTC'`
   * keeps the buckets UTC whatever the connection's time zone.
   */
  private async monthCounts(courseIds: string[] | null): Promise<Map<string, number>> {
    const since = new Date(`${this.lastTwelveMonths()[0]}-01T00:00:00Z`);
    const group = courseIds ? 'course_id::text' : `'all'`;
    const scope = courseIds ? 'AND course_id = ANY($2::uuid[])' : '';
    const month = (col: string) => `to_char(date_trunc('month', ${col} AT TIME ZONE 'UTC'), 'YYYY-MM')`;
    const rows: { key: string; kind: string; month: string; count: string }[] = await this.enrollments.query(
      `SELECT ${group} AS key, 'enrolled' AS kind, ${month('enrolled_at')} AS month, COUNT(*) AS count
       FROM ${this.enrollments.metadata.tablePath}
       WHERE entitlement_status = 'active' AND enrolled_at >= $1 ${scope}
       GROUP BY 1, 3
       UNION ALL
       SELECT ${group}, 'completed', ${month('completed_at')}, COUNT(*)
       FROM ${this.enrollments.metadata.tablePath}
       WHERE entitlement_status = 'active' AND completed_at >= $1 ${scope}
       GROUP BY 1, 3`,
      courseIds ? [since, courseIds] : [since],
    );
    return new Map(rows.map((r) => [`${r.key}:${r.kind}:${r.month}`, Number(r.count)]));
  }

  private monthSeries(counts: Map<string, number>, prefix: string) {
    return this.lastTwelveMonths().map((month) => ({ month, count: counts.get(`${prefix}:${month}`) ?? 0 }));
  }

  // ---- internal (service-to-service reads) ----

  async entitlement(learnerId: string, courseId: string) {
    const enrollment = await this.enrollments.findOne({ where: { learner_id: learnerId, course_id: courseId } });
    return {
      entitlement_status: enrollment?.entitlement_status ?? EntitlementStatus.NONE,
      enrollment_id: enrollment?.id ?? null,
      enrolled_at: enrollment?.enrolled_at ?? null,
      progress_percent: enrollment ? await this.progressPercent(enrollment) : 0,
      lessons_complete: enrollment ? !!enrollment.completed_at : false,
    };
  }

  async internalById(enrollmentId: string) {
    const enrollment = await this.enrollments.findOne({ where: { id: enrollmentId } });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    return {
      id: enrollment.id,
      learner_id: enrollment.learner_id,
      course_id: enrollment.course_id,
      entitlement_status: enrollment.entitlement_status,
      lessons_complete: !!enrollment.completed_at,
      progress_percent: await this.progressPercent(enrollment),
      enrolled_at: enrollment.enrolled_at,
    };
  }

  /** Active learner ids on a course — the audience for "course updated" notifications. */
  async learnersForCourse(courseId: string) {
    const rows = await this.enrollments.find({ where: { course_id: courseId, entitlement_status: EntitlementStatus.ACTIVE }, select: ['learner_id'] });
    return { learner_ids: rows.map((r) => r.learner_id) };
  }

  // ---- event reactions ----

  private async grantFromPayment(p: PaymentConfirmedPayload) {
    const enrollment = await this.activate(p.learner_id, p.course_id, 'payment', null);
    if (!enrollment) return;
    await this.saveActivated(enrollment, p.course_title, p.learner_email, PricingType.PAID, p.learner_name);
    this.logger.log(`entitlement granted: learner ${p.learner_id} course ${p.course_id}`);
  }

  private async grantFromSponsorship(p: SponsorshipGrantedPayload) {
    const enrollment = await this.activate(p.recipient_user_id, p.course_id, 'sponsorship', p.sponsor_id);
    if (!enrollment) return;
    await this.saveActivated(enrollment, p.course_title, p.recipient_email, PricingType.PAID);
    this.logger.log(`sponsored entitlement (${p.source}): learner ${p.recipient_user_id} course ${p.course_id}`);
  }

  /** Idempotent activation shared by both grant paths: the enrollment marked active, not saved yet, or null when it already is. */
  private async activate(learnerId: string, courseId: string, source: string, sponsorId: string | null): Promise<Enrollment | null> {
    let enrollment = await this.enrollments.findOne({ where: { learner_id: learnerId, course_id: courseId } });
    if (!enrollment) enrollment = this.enrollments.create({ learner_id: learnerId, course_id: courseId });
    if (enrollment.entitlement_status === EntitlementStatus.ACTIVE) return null;
    enrollment.entitlement_status = EntitlementStatus.ACTIVE;
    enrollment.source = source;
    enrollment.sponsor_id = sponsorId;
    return enrollment;
  }

  /**
   * A refunded payment ends access unless financial says the learner still
   * holds the course another way (a second purchase or a granted
   * sponsorship). The revoke only flips an active row, and writes nothing
   * else, so it can't put back stale progress.
   */
  private async revokeFromRefund(p: RefundDecisionPayload) {
    const ids = `learner ${p.learner_id}, course ${p.course_id}, payment ${p.payment_id}`;
    if (p.access_kept) {
      this.logger.log(`refund keeps access (another purchase or sponsorship): ${ids}`);
      return;
    }
    const { affected } = await this.enrollments.update(
      { learner_id: p.learner_id, course_id: p.course_id, entitlement_status: EntitlementStatus.ACTIVE },
      { entitlement_status: EntitlementStatus.REFUNDED },
    );
    this.logger.log(`entitlement refunded: ${ids}, affected ${affected ?? 0}`);
  }

  /**
   * A revision went live on the course. Only an applied revision changes what
   * learners see, so rejected and discarded ones are ignored.
   * - Replaced videos: the old video's duration would stay as the
   *   denominator (saveVideoProgress keeps the longest duration seen), so a
   *   shorter new video could never reach the auto-complete threshold. Watch
   *   state restarts; a completed lesson stays completed (lesson_progress is
   *   kept). started_at goes to null, not now(), so the time check runs again
   *   from the learner's first heartbeat on the new video: now() would let a
   *   learner returning days later complete it with a single 90% heartbeat.
   * - Removed lessons: a learner who had finished every other lesson is now
   *   at 100% but only gets completed when they next complete a lesson, so
   *   unfinished enrollments are re-checked here.
   */
  private async onRevisionApplied(p: CourseRevisionClosedPayload) {
    if (p.outcome !== 'applied') return;
    // First, so a failing reset or re-check below can't skip it.
    this.heartbeatCache.deleteWhere((_key, v) => (v.kind === 'course' ? v.courseId : v.lesson.course_id) === p.course_id);
    // CoursePublished only fires on a first publish, so an approved rename
    // reaches My Learning and the progress/inactivity messages only from here.
    // course_title is the post-apply title. A failed write only leaves the old
    // title, so it must not stop the progress fixes below.
    if (p.course_title) {
      try {
        await this.courseCache.update({ course_id: p.course_id }, { title: p.course_title });
      } catch (err) {
        this.logger.warn(`revision ${p.revision_id}: course title cache not updated: ${(err as Error).message}`);
      }
    }
    if (p.replaced_video_lesson_ids?.length) {
      const { affected } = await this.videoProgress.update(
        { lesson_id: In(p.replaced_video_lesson_ids) },
        // Keep updated_at so the reset doesn't make this lesson the player's "resume here" lesson.
        { position_seconds: 0, duration_seconds: 0, percent_watched: 0, started_at: null, updated_at: () => 'updated_at' },
      );
      this.logger.log(`revision ${p.revision_id}: video progress reset on ${affected ?? 0} row(s)`);
    }
    if (p.removed_lesson_ids?.length) await this.recheckCompletions(p.course_id, p.revision_id);
  }

  /** Completes every unfinished active enrollment on the course that has now done all live lessons. */
  private async recheckCompletions(courseId: string, revisionId: string) {
    const { lesson_ids } = await this.internal.get<{ lesson_ids: string[] }>(internalPath`/api/v1/internal/courses/${courseId}/lesson-ids`);
    if (lesson_ids.length === 0) return;
    let completed = 0;
    let afterId: string | null = null;
    for (;;) {
      // Keyset paging: completing an enrollment drops it out of the
      // completed_at IS NULL filter, so OFFSET paging would skip rows.
      const batch: Enrollment[] = await this.enrollments.find({
        where: {
          course_id: courseId,
          entitlement_status: EntitlementStatus.ACTIVE,
          completed_at: IsNull(),
          ...(afterId ? { id: MoreThan(afterId) } : {}),
        },
        order: { id: 'ASC' },
        take: RECHECK_BATCH,
      });
      if (batch.length === 0) break;
      afterId = batch[batch.length - 1].id;
      const done = await this.liveLessonsDone(batch.map((e) => e.id), lesson_ids);
      for (const enrollment of batch) {
        if ((done.get(enrollment.id) ?? 0) < lesson_ids.length) continue;
        try {
          // No request context here: detectCompletion looks the learner's email up.
          if (await this.detectCompletion(enrollment, '', lesson_ids)) completed += 1;
        } catch (err) {
          this.logger.warn(`completion re-check failed for enrollment ${enrollment.id}: ${(err as Error).message}`);
        }
      }
      if (batch.length < RECHECK_BATCH) break;
    }
    this.logger.log(`revision ${revisionId}: ${completed} enrollment(s) completed after lessons were removed`);
  }

  /** Completed live lessons per enrollment, in one grouped query. */
  private async liveLessonsDone(enrollmentIds: string[], lessonIds: string[]): Promise<Map<string, number>> {
    const rows = await this.progress
      .createQueryBuilder('p')
      .select('p.enrollment_id', 'enrollment_id')
      .addSelect('COUNT(*)', 'done')
      .where('p.enrollment_id IN (:...enrollmentIds)', { enrollmentIds })
      .andWhere('p.lesson_id = ANY(CAST(:lessonIds AS uuid[]))', { lessonIds })
      .groupBy('p.enrollment_id')
      .getRawMany<{ enrollment_id: string; done: string }>();
    return new Map(rows.map((r) => [r.enrollment_id, Number(r.done)]));
  }

  /**
   * Saves an activated enrollment and its EnrollmentCreated in one outbox
   * transaction (Phase 9b), so the course's enrolled count and the welcome
   * email follow even when the broker is down. The names are looked up first:
   * the transaction never waits on auth or course, and a failed lookup leaves
   * them blank, as before.
   */
  private async saveActivated(
    enrollment: Enrollment,
    courseTitle: string,
    learnerEmail: string,
    pricing: PricingType,
    learnerName?: string,
  ): Promise<Enrollment> {
    let name = learnerName ?? '';
    let email = learnerEmail;
    let educatorName = '';
    try {
      if (!name || !email) {
        const user = await this.internal.get<{ name: string; email: string }>(internalPath`/api/v1/internal/users/${enrollment.learner_id}`);
        name = name || user.name;
        email = email || user.email;
      }
      const cached = await this.courseCache.findOne({ where: { course_id: enrollment.course_id } });
      if (cached) {
        const path = cached.owner_type === 'institution' ? 'institutions' : 'educators';
        const owner = await this.internal.get<{ name: string }>(internalPath`/api/v1/internal/${path}/${cached.owner_id}`);
        educatorName = owner.name;
      }
    } catch (err) {
      this.logger.warn(`enrichment failed for EnrollmentCreated: ${(err as Error).message}`);
    }
    return this.outbox.transaction(async (m, emit) => {
      const saved = await m.getRepository(Enrollment).save(enrollment);
      emit<EnrollmentCreatedPayload>('EnrollmentCreated', {
        enrollment_id: saved.id,
        learner_id: saved.learner_id,
        learner_email: email,
        learner_name: name,
        course_id: saved.course_id,
        course_title: courseTitle,
        educator_name: educatorName,
        pricing_type: pricing,
      });
      return saved;
    });
  }

  /**
   * Returns true when this call completed the enrollment (and emitted CourseCompleted).
   * The names are looked up before the transaction and a failed lookup leaves them
   * blank, so a completion never waits on, or fails with, auth or course being
   * asleep: outcomes and notification fetch what's missing (9b plan-review B1).
   */
  private async detectCompletion(enrollment: Enrollment, learnerEmail: string, lessonIds?: string[]): Promise<boolean> {
    if (enrollment.completed_at) return false;
    const lesson_ids =
      lessonIds ??
      (await this.internal.get<{ lesson_ids: string[] }>(internalPath`/api/v1/internal/courses/${enrollment.course_id}/lesson-ids`)).lesson_ids;
    if (lesson_ids.length === 0) return false;
    const done = await this.progress.count({ where: { enrollment_id: enrollment.id, lesson_id: In(lesson_ids) } });
    if (done < lesson_ids.length) return false;

    let learnerName = '';
    let educatorId = '';
    let educatorName = '';
    let courseTitle = '';
    try {
      const user = await this.internal.get<{ name: string; email: string }>(internalPath`/api/v1/internal/users/${enrollment.learner_id}`);
      learnerName = user.name;
      learnerEmail = learnerEmail || user.email;
      const course = await this.internal.get<{ title: string; owner_id: string; owner_type: string }>(
        internalPath`/api/v1/internal/courses/${enrollment.course_id}`,
      );
      courseTitle = course.title;
      educatorId = course.owner_id;
      const path = course.owner_type === 'institution' ? 'institutions' : 'educators';
      const owner = await this.internal.get<{ name: string }>(internalPath`/api/v1/internal/${path}/${course.owner_id}`);
      educatorName = owner.name;
    } catch (err) {
      this.logger.warn(`enrichment failed for CourseCompleted: ${(err as Error).message}`);
    }

    // Conditional write: the learner's own last lesson and the revision
    // re-check can race, and only one of them may emit CourseCompleted. The
    // completion and its event commit together (Phase 9b), so a certificate
    // follows even when the broker is down.
    const completedAt = new Date();
    const completed = await this.outbox.transaction(async (m, emit) => {
      const { affected } = await m.getRepository(Enrollment).update({ id: enrollment.id, completed_at: IsNull() }, { completed_at: completedAt });
      if (affected === 0) return false;
      emit<CourseCompletedPayload>('CourseCompleted', {
        enrollment_id: enrollment.id,
        learner_id: enrollment.learner_id,
        learner_email: learnerEmail,
        learner_name: learnerName,
        course_id: enrollment.course_id,
        course_title: courseTitle,
        educator_id: educatorId,
        educator_name: educatorName,
        completed_at: completedAt.toISOString(),
      });
      return true;
    });
    if (!completed) return false;
    enrollment.completed_at = completedAt;
    this.logger.log(`course completed: enrollment ${enrollment.id}`);
    return true;
  }

  /**
   * Progress of many enrollments: one lesson-ids batch call and one grouped
   * count. Strict: a failed lesson-ids read propagates.
   */
  private async percentsFor(rows: Enrollment[]): Promise<Map<string, number>> {
    if (!rows.length) return new Map();
    const lessonIds = await courseLessonIds(this.internal, rows.map((r) => r.course_id));
    const all = [...new Set([...lessonIds.values()].flat())];
    // Lesson ids are unique across courses, so counting against all of them counts each enrollment's own live lessons.
    const done = all.length ? await this.liveLessonsDone(rows.map((r) => r.id), all) : new Map<string, number>();
    return new Map(
      rows.map((r) => {
        const total = lessonIds.get(r.course_id)?.length ?? 0;
        return [r.id, total ? Math.min(100, Math.round(((done.get(r.id) ?? 0) / total) * 100)) : 0];
      }),
    );
  }

  /** percentsFor for display lists: null, with one warn, when course can't answer. */
  private async percentsOrNull(rows: Enrollment[], what: string): Promise<Map<string, number> | null> {
    try {
      return await this.percentsFor(rows);
    } catch (err) {
      this.logger.warn(`${what}: progress unavailable (${(err as Error).message})`);
      return null;
    }
  }

  /** Progress batch for other services (Phase 9e): one row per `learner:course` pair that has an enrollment. */
  async progressForPairs(pairs: string[]) {
    const wanted = pairs.map((p) => {
      const [learner_id, course_id] = p.toLowerCase().split(':');
      return { learner_id, course_id };
    });
    const rows = await this.enrollments.find({ where: wanted });
    const percents = await this.percentsOrNull(rows, 'progress batch');
    return rows.map((e) => ({
      learner_id: e.learner_id,
      course_id: e.course_id,
      active: e.entitlement_status === EntitlementStatus.ACTIVE,
      progress_percent: percents ? (percents.get(e.id) ?? 0) : null,
      lessons_complete: !!e.completed_at,
    }));
  }

  /**
   * Percent of the course's current lessons completed, or null when the course
   * service can't be reached (P1-18): "unknown", never a made-up 0%.
   */
  private async progressPercent(enrollment: Enrollment, known?: string[]): Promise<number | null> {
    let lessonIds: string[];
    try {
      lessonIds =
        known ??
        (await this.internal.get<{ lesson_ids: string[] }>(internalPath`/api/v1/internal/courses/${enrollment.course_id}/lesson-ids`))
          .lesson_ids;
    } catch (err) {
      this.logger.warn(`progress of enrollment ${enrollment.id} unknown: ${(err as Error).message}`);
      return null;
    }
    if (lessonIds.length === 0) return 0;
    // Only count lessons that still exist (an educator may have removed some).
    const done = await this.progress.count({ where: { enrollment_id: enrollment.id, lesson_id: In(lessonIds) } });
    return Math.min(100, Math.round((done / lessonIds.length) * 100));
  }

  private async ownerIdsFor(ctx: UserContext): Promise<string[]> {
    const ids = [ctx.id];
    if (ctx.role === Role.INSTITUTION_ADMIN) {
      try {
        const inst = await this.internal.get<{ id: string }>(internalPath`/api/v1/internal/institutions/by-owner/${ctx.id}`);
        ids.push(inst.id);
      } catch (err) {
        // 404: no institution yet. Anything else (auth asleep) fails the read, as the analytics do.
        if (!(err instanceof PeerNotFoundError)) throw err;
      }
    }
    return ids;
  }

  private async owned(ctx: UserContext, enrollmentId: string): Promise<Enrollment> {
    const enrollment = await this.enrollments.findOne({ where: { id: enrollmentId } });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.learner_id !== ctx.id && ctx.role !== Role.PLATFORM_ADMIN) throw new ForbiddenException('Not your enrollment');
    return enrollment;
  }
}
