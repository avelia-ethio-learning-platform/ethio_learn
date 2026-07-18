import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import {
  CourseCompletedPayload,
  CoursePublishedPayload,
  EnrollmentCreatedPayload,
  EntitlementStatus,
  PaymentConfirmedPayload,
  PricingType,
  RefundDecisionPayload,
  Role,
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
    // THE only path to paid entitlement (spec §0 rule 3 / §12.2).
    this.bus.subscribe<PaymentConfirmedPayload>('PaymentConfirmed', (p) => this.grantFromPayment(p));
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
      enrollment = this.enrollments.create({ learner_id: ctx.id, course_id: courseId });
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
   * position_seconds is the resume point; percent_watched is a high-water mark.
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

  private async recordCompletion(enrollment: Enrollment, lessonId: string, learnerEmail: string) {
    const existing = await this.progress.findOne({ where: { enrollment_id: enrollment.id, lesson_id: lessonId } });
    if (!existing) {
      await this.progress.save(this.progress.create({ enrollment_id: enrollment.id, lesson_id: lessonId, completed_at: new Date() }));
    }
    await this.detectCompletion(enrollment, learnerEmail);
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

  // ---- event reactions ----

  private async grantFromPayment(p: PaymentConfirmedPayload) {
    let enrollment = await this.enrollments.findOne({ where: { learner_id: p.learner_id, course_id: p.course_id } });
    if (!enrollment) {
      enrollment = this.enrollments.create({ learner_id: p.learner_id, course_id: p.course_id });
    }
    if (enrollment.entitlement_status === EntitlementStatus.ACTIVE) return; // idempotent
    enrollment.entitlement_status = EntitlementStatus.ACTIVE;
    enrollment = await this.enrollments.save(enrollment);
    this.logger.log(`entitlement granted: learner ${p.learner_id} course ${p.course_id}`);
    await this.publishEnrollmentCreated(enrollment, p.course_title, p.learner_email, PricingType.PAID, p.learner_name);
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
    let educatorName = '';
    try {
      if (!name) {
        const user = await this.internal.get<{ name: string }>(`/api/v1/internal/users/${enrollment.learner_id}`);
        name = user.name;
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
      learner_email: learnerEmail,
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
    const done = await this.progress.count({ where: { enrollment_id: enrollment.id } });
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
      const done = await this.progress.count({ where: { enrollment_id: enrollment.id } });
      return Math.round((done / lesson_ids.length) * 100);
    } catch {
      return 0;
    }
  }

  private async owned(ctx: UserContext, enrollmentId: string): Promise<Enrollment> {
    const enrollment = await this.enrollments.findOne({ where: { id: enrollmentId } });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.learner_id !== ctx.id && ctx.role !== Role.PLATFORM_ADMIN) throw new ForbiddenException('Not your enrollment');
    return enrollment;
  }
}
