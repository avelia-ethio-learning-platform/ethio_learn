import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { envInt, EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import {
  CourseCompletedPayload,
  CourseProgressMilestonePayload,
  CoursePublishedPayload,
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

interface CourseInfo {
  id: string;
  title: string;
  owner_id: string;
  owner_type: string;
  pricing_type: PricingType;
  status: string;
}

const MILESTONES = [25, 50, 75] as const;

@Injectable()
export class EnrollmentService implements OnModuleInit {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    @InjectRepository(Enrollment) private readonly enrollments: Repository<Enrollment>,
    @InjectRepository(LessonProgress) private readonly progress: Repository<LessonProgress>,
    @InjectRepository(CourseCache) private readonly courseCache: Repository<CourseCache>,
    @InjectRepository(VideoProgress) private readonly videoProgress: Repository<VideoProgress>,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
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
  }

  /** Direct enrollment — FREE courses only. Paid/freemium go through the payment flow (spec §4.3). */
  async enrollFree(ctx: UserContext, courseId: string) {
    const course = await this.internal.get<CourseInfo>(`/api/v1/internal/courses/${courseId}`);
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
    enrollment = await this.enrollments.save(enrollment);

    await this.publishEnrollmentCreated(enrollment, course.title, ctx.email, course.pricing_type);
    return enrollment;
  }

  async listForLearner(ctx: UserContext) {
    const rows = await this.enrollments.find({ where: { learner_id: ctx.id }, order: { enrolled_at: 'DESC' } });
    const out = [];
    for (const enrollment of rows) {
      const cached = await this.courseCache.findOne({ where: { course_id: enrollment.course_id } });
      const percent = await this.progressPercent(enrollment);
      out.push({
        id: enrollment.id,
        course_id: enrollment.course_id,
        course_title: cached?.title ?? null,
        entitlement_status: enrollment.entitlement_status,
        enrolled_at: enrollment.enrolled_at,
        completed_at: enrollment.completed_at,
        progress_percent: percent,
        source: enrollment.source,
        last_activity_at: enrollment.last_activity_at,
      });
    }
    return out;
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

  async completeLesson(ctx: UserContext, lessonId: string) {
    const lesson = await this.internal.get<{ course_id: string }>(`/api/v1/internal/lessons/${lessonId}`);
    const enrollment = await this.enrollments.findOne({ where: { learner_id: ctx.id, course_id: lesson.course_id } });
    if (!enrollment || enrollment.entitlement_status !== EntitlementStatus.ACTIVE) {
      throw new ForbiddenException('No active entitlement for this course');
    }
    await this.recordCompletion(enrollment, lessonId, ctx.email);
    return this.progressDetail(ctx, enrollment.id);
  }

  /**
   * Heartbeat from the video player (every ~10s / on pause / on leave).
   * position_seconds is the resume point; percent_watched is a high-water mark
   * (idempotent + commutative, so offline replays can never corrupt it).
   * Watching ≥90% auto-completes the lesson.
   */
  async saveVideoProgress(ctx: UserContext, lessonId: string, positionSeconds: number, durationSeconds: number) {
    const lesson = await this.internal.get<{ course_id: string }>(`/api/v1/internal/lessons/${lessonId}`);
    const enrollment = await this.enrollments.findOne({ where: { learner_id: ctx.id, course_id: lesson.course_id } });
    if (!enrollment || enrollment.entitlement_status !== EntitlementStatus.ACTIVE) {
      throw new ForbiddenException('No active entitlement for this course');
    }
    let row = await this.videoProgress.findOne({ where: { enrollment_id: enrollment.id, lesson_id: lessonId } });
    if (!row) {
      row = this.videoProgress.create({ enrollment_id: enrollment.id, lesson_id: lessonId });
    }
    row.position_seconds = Math.max(0, positionSeconds);
    row.duration_seconds = Math.max(row.duration_seconds ?? 0, durationSeconds);
    const percent = row.duration_seconds > 0 ? Math.min(100, Math.round((positionSeconds / row.duration_seconds) * 100)) : 0;
    row.percent_watched = Math.max(row.percent_watched ?? 0, percent);
    row = await this.videoProgress.save(row);
    await this.touch(enrollment);

    if (row.percent_watched >= 90) {
      await this.recordCompletion(enrollment, lessonId, ctx.email);
    }
    return {
      lesson_id: lessonId,
      position_seconds: row.position_seconds,
      duration_seconds: row.duration_seconds,
      percent_watched: row.percent_watched,
    };
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

  private async recordCompletion(enrollment: Enrollment, lessonId: string, learnerEmail: string) {
    const existing = await this.progress.findOne({ where: { enrollment_id: enrollment.id, lesson_id: lessonId } });
    if (!existing) {
      await this.progress.save(this.progress.create({ enrollment_id: enrollment.id, lesson_id: lessonId, completed_at: new Date() }));
    }
    await this.touch(enrollment);
    await this.announceMilestone(enrollment, learnerEmail);
    await this.detectCompletion(enrollment, learnerEmail);
  }

  /** Any learning activity resets the inactivity escalation. */
  private async touch(enrollment: Enrollment) {
    enrollment.last_activity_at = new Date();
    if (enrollment.nudge_level !== 0) enrollment.nudge_level = 0;
    await this.enrollments.save(enrollment);
  }

  /** "You're 50% through" — each of 25/50/75 fires exactly once per enrollment. */
  private async announceMilestone(enrollment: Enrollment, learnerEmail: string) {
    if (enrollment.completed_at) return;
    const percent = await this.progressPercent(enrollment);
    const sent = enrollment.milestones_sent ?? [];
    const due = MILESTONES.filter((m) => percent >= m && !sent.includes(m));
    if (!due.length) return;
    const highest = due[due.length - 1];
    enrollment.milestones_sent = [...sent, ...due];
    await this.enrollments.save(enrollment);
    const cached = await this.courseCache.findOne({ where: { course_id: enrollment.course_id } });
    await this.bus.publish<CourseProgressMilestonePayload>('CourseProgressMilestone', {
      enrollment_id: enrollment.id,
      learner_id: enrollment.learner_id,
      learner_email: learnerEmail,
      course_id: enrollment.course_id,
      course_title: cached?.title ?? 'your course',
      percent: highest,
    });
  }

  /**
   * Inactivity nudges, daily at 06:00 UTC (09:00 Addis). An active, unfinished
   * enrollment with no activity for INACTIVITY_DAYS gets an in-app ping; if it
   * is still idle after INACTIVITY_EMAIL_DAYS it gets one email. Any activity
   * resets the ladder (see touch()).
   */
  @Cron('0 6 * * *')
  async nudgeInactiveLearners(): Promise<void> {
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
    let sent = 0;
    for (const e of candidates) {
      const since = e.last_activity_at ?? e.enrolled_at;
      const days = Math.floor((now - since.getTime()) / 86_400_000);
      const channel: 'in_app' | 'email' = e.nudge_level === 0 ? 'in_app' : 'email';
      e.nudge_level = e.nudge_level === 0 ? 1 : 2;
      await this.enrollments.save(e);
      const cached = await this.courseCache.findOne({ where: { course_id: e.course_id } });
      await this.bus.publish<LearnerInactivePayload>('LearnerInactive', {
        enrollment_id: e.id,
        learner_id: e.learner_id,
        course_id: e.course_id,
        course_title: cached?.title ?? 'your course',
        days_inactive: days,
        progress_percent: await this.progressPercent(e),
        channel,
      });
      sent += 1;
    }
    if (sent) this.logger.log(`inactivity nudges published: ${sent}`);
  }

  // ---- Analytics ---------------------------------------------------------

  /** Per-course learner funnel for educators / institutions / admins. Ownership is checked per course. */
  async analytics(ctx: UserContext, courseIds: string[]) {
    const ids = [...new Set(courseIds)].slice(0, 25);
    const ownerIds = await this.ownerIdsFor(ctx);
    const out = [];
    for (const courseId of ids) {
      let course: CourseInfo;
      try {
        course = await this.internal.get<CourseInfo>(`/api/v1/internal/courses/${courseId}`);
      } catch {
        continue;
      }
      if (ctx.role !== Role.PLATFORM_ADMIN && !ownerIds.includes(course.owner_id)) continue;

      const rows = await this.enrollments.find({ where: { course_id: courseId } });
      const active = rows.filter((r) => r.entitlement_status === EntitlementStatus.ACTIVE);
      const completed = active.filter((r) => !!r.completed_at);
      let lessonCount = 0;
      try {
        lessonCount = (await this.internal.get<{ lesson_ids: string[] }>(`/api/v1/internal/courses/${courseId}/lesson-ids`)).lesson_ids.length;
      } catch {
        lessonCount = 0;
      }
      // Lessons completed per enrollment in one grouped query (no N+1).
      const doneRows = active.length
        ? await this.progress
            .createQueryBuilder('p')
            .select('p.enrollment_id', 'enrollment_id')
            .addSelect('COUNT(*)', 'done')
            .where('p.enrollment_id IN (:...ids)', { ids: active.map((r) => r.id) })
            .groupBy('p.enrollment_id')
            .getRawMany<{ enrollment_id: string; done: string }>()
        : [];
      const doneMap = new Map(doneRows.map((r) => [r.enrollment_id, Number(r.done)]));
      const avgProgress = active.length && lessonCount
        ? Math.round(active.reduce((s, r) => s + Math.min(100, ((doneMap.get(r.id) ?? 0) / lessonCount) * 100), 0) / active.length)
        : 0;

      const week = Date.now() - 7 * 86_400_000;
      const month = Date.now() - 30 * 86_400_000;
      out.push({
        course_id: courseId,
        course_title: course.title,
        enrolled: active.length,
        refunded: rows.filter((r) => r.entitlement_status === EntitlementStatus.REFUNDED).length,
        completed: completed.length,
        completion_rate: active.length ? Math.round((completed.length / active.length) * 100) : 0,
        avg_progress_percent: avgProgress,
        active_last_7d: active.filter((r) => r.last_activity_at && r.last_activity_at.getTime() > week).length,
        active_last_30d: active.filter((r) => r.last_activity_at && r.last_activity_at.getTime() > month).length,
        never_started: active.filter((r) => !r.last_activity_at && !(doneMap.get(r.id) ?? 0)).length,
        sponsored: active.filter((r) => r.source === 'sponsorship').length,
        enrollments_by_month: this.byMonth(active.map((r) => r.enrolled_at)),
        completions_by_month: this.byMonth(completed.map((r) => r.completed_at!)),
      });
    }
    return out;
  }

  /** Platform-wide learner funnel for the admin console. */
  async adminAnalytics() {
    const rows = await this.enrollments.find();
    const active = rows.filter((r) => r.entitlement_status === EntitlementStatus.ACTIVE);
    const week = Date.now() - 7 * 86_400_000;
    return {
      enrollments_total: rows.length,
      active: active.length,
      completed: active.filter((r) => !!r.completed_at).length,
      refunded: rows.filter((r) => r.entitlement_status === EntitlementStatus.REFUNDED).length,
      sponsored: active.filter((r) => r.source === 'sponsorship').length,
      active_last_7d: active.filter((r) => r.last_activity_at && r.last_activity_at.getTime() > week).length,
      distinct_learners: new Set(active.map((r) => r.learner_id)).size,
      enrollments_by_month: this.byMonth(active.map((r) => r.enrolled_at)),
      completions_by_month: this.byMonth(active.filter((r) => r.completed_at).map((r) => r.completed_at!)),
    };
  }

  private byMonth(dates: Date[]) {
    const months: Record<string, number> = {};
    const start = new Date();
    start.setUTCDate(1);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - i, 1));
      months[d.toISOString().slice(0, 7)] = 0;
    }
    for (const d of dates) {
      const key = d.toISOString().slice(0, 7);
      if (key in months) months[key] += 1;
    }
    return Object.entries(months).map(([month, count]) => ({ month, count }));
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
    this.logger.log(`entitlement granted: learner ${p.learner_id} course ${p.course_id}`);
    await this.publishEnrollmentCreated(enrollment, p.course_title, p.learner_email, PricingType.PAID, p.learner_name);
  }

  private async grantFromSponsorship(p: SponsorshipGrantedPayload) {
    const enrollment = await this.activate(p.recipient_user_id, p.course_id, 'sponsorship', p.sponsor_id);
    if (!enrollment) return;
    this.logger.log(`sponsored entitlement (${p.source}): learner ${p.recipient_user_id} course ${p.course_id}`);
    await this.publishEnrollmentCreated(enrollment, p.course_title, p.recipient_email, PricingType.PAID);
  }

  /** Idempotent activation shared by both grant paths. Returns null when already active. */
  private async activate(learnerId: string, courseId: string, source: string, sponsorId: string | null): Promise<Enrollment | null> {
    let enrollment = await this.enrollments.findOne({ where: { learner_id: learnerId, course_id: courseId } });
    if (!enrollment) enrollment = this.enrollments.create({ learner_id: learnerId, course_id: courseId });
    if (enrollment.entitlement_status === EntitlementStatus.ACTIVE) return null;
    enrollment.entitlement_status = EntitlementStatus.ACTIVE;
    enrollment.source = source;
    enrollment.sponsor_id = sponsorId;
    return this.enrollments.save(enrollment);
  }

  private async revokeFromRefund(p: RefundDecisionPayload) {
    const enrollment = await this.enrollments.findOne({ where: { learner_id: p.learner_id, course_id: p.course_id } });
    if (!enrollment) return;
    enrollment.entitlement_status = EntitlementStatus.REFUNDED;
    await this.enrollments.save(enrollment);
    this.logger.log(`entitlement refunded: enrollment ${enrollment.id}`);
  }

  private async publishEnrollmentCreated(
    enrollment: Enrollment,
    courseTitle: string,
    learnerEmail: string,
    pricing: PricingType,
    learnerName?: string,
  ) {
    let name = learnerName ?? '';
    let email = learnerEmail;
    let educatorName = '';
    try {
      if (!name || !email) {
        const user = await this.internal.get<{ name: string; email: string }>(`/api/v1/internal/users/${enrollment.learner_id}`);
        name = name || user.name;
        email = email || user.email;
      }
      const cached = await this.courseCache.findOne({ where: { course_id: enrollment.course_id } });
      if (cached) {
        const path = cached.owner_type === 'institution' ? 'institutions' : 'educators';
        const owner = await this.internal.get<{ name: string }>(`/api/v1/internal/${path}/${cached.owner_id}`);
        educatorName = owner.name;
      }
    } catch (err) {
      this.logger.warn(`enrichment failed for EnrollmentCreated: ${(err as Error).message}`);
    }
    await this.bus.publish<EnrollmentCreatedPayload>('EnrollmentCreated', {
      enrollment_id: enrollment.id,
      learner_id: enrollment.learner_id,
      learner_email: email,
      learner_name: name,
      course_id: enrollment.course_id,
      course_title: courseTitle,
      educator_name: educatorName,
      pricing_type: pricing,
    });
  }

  private async detectCompletion(enrollment: Enrollment, learnerEmail: string) {
    if (enrollment.completed_at) return;
    const { lesson_ids } = await this.internal.get<{ lesson_ids: string[] }>(
      `/api/v1/internal/courses/${enrollment.course_id}/lesson-ids`,
    );
    if (lesson_ids.length === 0) return;
    const done = await this.progress.count({ where: { enrollment_id: enrollment.id, lesson_id: In(lesson_ids) } });
    if (done < lesson_ids.length) return;

    enrollment.completed_at = new Date();
    await this.enrollments.save(enrollment);

    let learnerName = '';
    let educatorId = '';
    let educatorName = '';
    let courseTitle = '';
    try {
      const user = await this.internal.get<{ name: string }>(`/api/v1/internal/users/${enrollment.learner_id}`);
      learnerName = user.name;
      const course = await this.internal.get<{ title: string; owner_id: string; owner_type: string }>(
        `/api/v1/internal/courses/${enrollment.course_id}`,
      );
      courseTitle = course.title;
      educatorId = course.owner_id;
      const path = course.owner_type === 'institution' ? 'institutions' : 'educators';
      const owner = await this.internal.get<{ name: string }>(`/api/v1/internal/${path}/${course.owner_id}`);
      educatorName = owner.name;
    } catch (err) {
      this.logger.warn(`enrichment failed for CourseCompleted: ${(err as Error).message}`);
    }

    await this.bus.publish<CourseCompletedPayload>('CourseCompleted', {
      enrollment_id: enrollment.id,
      learner_id: enrollment.learner_id,
      learner_email: learnerEmail,
      learner_name: learnerName,
      course_id: enrollment.course_id,
      course_title: courseTitle,
      educator_id: educatorId,
      educator_name: educatorName,
      completed_at: enrollment.completed_at.toISOString(),
    });
    this.logger.log(`course completed: enrollment ${enrollment.id}`);
  }

  private async progressPercent(enrollment: Enrollment): Promise<number> {
    try {
      const { lesson_ids } = await this.internal.get<{ lesson_ids: string[] }>(
        `/api/v1/internal/courses/${enrollment.course_id}/lesson-ids`,
      );
      if (lesson_ids.length === 0) return 0;
      // Only count lessons that still exist (an educator may have removed some).
      const done = await this.progress.count({ where: { enrollment_id: enrollment.id, lesson_id: In(lesson_ids) } });
      return Math.min(100, Math.round((done / lesson_ids.length) * 100));
    } catch {
      return 0;
    }
  }

  private async ownerIdsFor(ctx: UserContext): Promise<string[]> {
    const ids = [ctx.id];
    if (ctx.role === Role.INSTITUTION_ADMIN) {
      try {
        const inst = await this.internal.get<{ id: string }>(`/api/v1/internal/institutions/by-owner/${ctx.id}`);
        ids.push(inst.id);
      } catch {
        /* no institution yet */
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
