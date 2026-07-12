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
import { AiAssessor, createAiAssessor } from '@ethiopialearn/ai';
import {
  CourseAppealSubmittedPayload,
  CourseCompletedPayload,
  CourseReviewedPayload,
  CourseSubmittedPayload,
  FraudFlagPayload,
  FraudSignalStatus,
  FraudSubjectType,
  OwnerType,
  PaymentConfirmedPayload,
  QaDecisionAction,
  QaReviewStatus,
  RefundDecisionPayload,
  TrustTier,
  TrustTierChangedPayload,
} from '@ethiopialearn/contracts';
import {
  CourseReview,
  EducatorTrustTier,
  FraudSignal,
  PayeeStats,
  QaReviewItem,
  QualityCourseCache,
  RefundLog,
} from './entities';

// Confirmed thresholds (spec §10.5).
const PROVEN = { courses: 5, rating: 4.0, refundRate: 0.05 };
const TRUSTED = { courses: 20, rating: 4.5, refundRate: 0.03 };
// Post-publish QO triggers (spec §8).
const RATING_TRIGGER = 2.5;
const RATING_TRIGGER_MIN_REVIEWS = 3;
const REFUND_ABUSE_COUNT = 3; // >3 refunds / 30 days (spec §10.6)

@Injectable()
export class QualityService implements OnModuleInit {
  private readonly logger = new Logger(QualityService.name);
  private readonly ai: AiAssessor = createAiAssessor();

  constructor(
    @InjectRepository(QaReviewItem) private readonly reviewItems: Repository<QaReviewItem>,
    @InjectRepository(CourseReview) private readonly courseReviews: Repository<CourseReview>,
    @InjectRepository(FraudSignal) private readonly fraudSignals: Repository<FraudSignal>,
    @InjectRepository(EducatorTrustTier) private readonly trustTiers: Repository<EducatorTrustTier>,
    @InjectRepository(QualityCourseCache) private readonly courseCache: Repository<QualityCourseCache>,
    @InjectRepository(PayeeStats) private readonly stats: Repository<PayeeStats>,
    @InjectRepository(RefundLog) private readonly refundLog: Repository<RefundLog>,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
  ) {}

  onModuleInit() {
    // Submission → AI plagiarism screen → QO queue (spec §12.1).
    this.bus.subscribe<CourseSubmittedPayload>('CourseSubmitted', (p) => this.enqueueSubmission(p));
    // Appeal on a flagged course → back into the review queue for a fresh look.
    this.bus.subscribe<CourseAppealSubmittedPayload>('CourseAppealSubmitted', (p) => this.enqueueAppeal(p));
    // Behavioral signals for trust computation (spec §4.3).
    this.bus.subscribe<CourseCompletedPayload>('CourseCompleted', async (p) => {
      const cache = await this.courseCache.findOne({ where: { course_id: p.course_id } });
      if (cache) {
        await this.bumpStats(cache.owner_id, { completions: 1 });
        await this.recomputeTier(cache.owner_id);
      }
    });
    this.bus.subscribe<PaymentConfirmedPayload>('PaymentConfirmed', async (p) => {
      await this.bumpStats(p.payee_id, { payments: 1 });
      await this.recomputeTier(p.payee_id);
    });
    // TODO(spec-open-question): RefundApproved is not in Quality & Trust's §5
    // subscription list, but §10.5/§10.6 require refund_rate and refund-abuse
    // tracking — this subscription is the only event-driven way to get them.
    this.bus.subscribe<RefundDecisionPayload>('RefundApproved', async (p) => {
      await this.refundLog.save(this.refundLog.create({ learner_id: p.learner_id }));
      const cache = await this.courseCache.findOne({ where: { course_id: p.course_id } });
      if (cache) {
        await this.bumpStats(cache.owner_id, { refunds: 1 });
        await this.recomputeTier(cache.owner_id);
        await this.checkRefundRateTrigger(cache);
      }
      await this.checkRefundAbuse(p.learner_id);
    });
  }

  // ---- QO queue & decisions ----

  private async enqueueSubmission(p: CourseSubmittedPayload) {
    await this.courseCache.save(
      this.courseCache.create({ course_id: p.course_id, owner_id: p.owner_id, owner_type: p.owner_type, title: p.title }),
    );
    // Real catalog-aware screening: give the AI the existing course titles from
    // other owners so it can detect near-duplication within the platform, not
    // just against its own training knowledge.
    let plagiarism: Record<string, unknown> = {};
    try {
      const others = await this.courseCache
        .createQueryBuilder('c')
        .select('c.title', 'title')
        .where('c.owner_id != :owner', { owner: p.owner_id })
        .andWhere('c.course_id != :cid', { cid: p.course_id })
        .limit(60)
        .getRawMany<{ title: string }>();
      plagiarism = { ...(await this.ai.plagiarismCheck(p.title, p.description, others.map((o) => o.title))) };
    } catch (err) {
      plagiarism = { error: (err as Error).message };
    }
    const item = await this.reviewItems.save(
      this.reviewItems.create({
        course_id: p.course_id,
        course_title: p.title,
        owner_id: p.owner_id,
        owner_type: p.owner_type,
        owner_user_id: p.owner_user_id,
        owner_email: p.owner_email,
        owner_name: p.owner_name,
        status: QaReviewStatus.PENDING,
        plagiarism,
        trigger: 'submission',
      }),
    );
    if (plagiarism.flagged) {
      await this.raiseFraudSignal({
        subject_type: FraudSubjectType.COURSE,
        subject_id: p.course_id,
        signal_type: 'plagiarism_suspected',
        detail: String(plagiarism.reason ?? ''),
        payee_id: p.owner_id,
      });
    }
    this.logger.log(`course ${p.course_id} queued for QO review (item ${item.id})`);
  }

  private async enqueueAppeal(p: CourseAppealSubmittedPayload) {
    const last = await this.reviewItems.findOne({ where: { course_id: p.course_id }, order: { created_at: 'DESC' } });
    await this.reviewItems.save(
      this.reviewItems.create({
        course_id: p.course_id,
        course_title: p.course_title,
        owner_id: last?.owner_id ?? p.owner_user_id,
        owner_type: last?.owner_type ?? OwnerType.EDUCATOR,
        owner_user_id: p.owner_user_id,
        owner_email: p.owner_email,
        owner_name: last?.owner_name ?? '',
        status: QaReviewStatus.PENDING,
        plagiarism: {},
        trigger: `appeal: ${p.appeal_note.slice(0, 300)}`,
      }),
    );
    this.logger.log(`course ${p.course_id} re-queued via appeal`);
  }

  async queue() {
    const items = await this.reviewItems.find({
      where: [{ status: QaReviewStatus.PENDING }, { status: QaReviewStatus.IN_REVIEW }],
      order: { created_at: 'ASC' },
    });
    // SLA countdown: review target is 24-48h from submission (spec §2.1).
    return items.map((item) => ({
      ...item,
      sla_deadline: new Date(item.created_at.getTime() + 48 * 3600 * 1000),
    }));
  }

  async reviewDetail(courseId: string) {
    const item = await this.reviewItems.findOne({
      where: { course_id: courseId },
      order: { created_at: 'DESC' },
    });
    if (!item) throw new NotFoundException('No review item for this course');
    return item;
  }

  /** Checklist decision: approve | coach | flag (spec §8). */
  async decide(ctx: UserContext, courseId: string, action: QaDecisionAction, notes?: string) {
    const item = await this.reviewItems.findOne({
      where: [
        { course_id: courseId, status: QaReviewStatus.PENDING },
        { course_id: courseId, status: QaReviewStatus.IN_REVIEW },
      ],
      order: { created_at: 'DESC' },
    });
    if (!item) throw new NotFoundException('No pending review for this course');
    if (action === QaDecisionAction.COACH && !notes?.trim()) {
      throw new BadRequestException('Coaching requires notes for the educator');
    }

    item.qo_id = ctx.id;
    item.coaching_notes = notes ?? '';
    item.reviewed_at = new Date();
    item.status =
      action === QaDecisionAction.APPROVE
        ? QaReviewStatus.APPROVED
        : action === QaDecisionAction.COACH
          ? QaReviewStatus.COACHED
          : QaReviewStatus.FLAGGED;
    await this.reviewItems.save(item);

    await this.bus.publish<CourseReviewedPayload>('CourseReviewed', {
      course_id: courseId,
      action,
      notes: notes ?? null,
      qo_id: ctx.id,
      owner_user_id: item.owner_user_id ?? '',
      owner_email: item.owner_email,
      course_title: item.course_title,
    });
    return item;
  }

  // ---- Learner ratings & reviews (spec §10.7) ----

  async addReview(ctx: UserContext, courseId: string, rating: number, comment?: string) {
    const entitlement = await this.internal.get<{ entitlement_status: string; progress_percent: number }>(
      `/api/v1/internal/entitlements?learner_id=${ctx.id}&course_id=${courseId}`,
    );
    if (entitlement.entitlement_status !== 'active' || entitlement.progress_percent < 20) {
      throw new ForbiddenException('Complete at least 20% of the course before reviewing');
    }
    const existing = await this.courseReviews.findOne({ where: { course_id: courseId, learner_id: ctx.id } });
    if (existing) throw new BadRequestException('You already reviewed this course');

    const review = await this.courseReviews.save(
      this.courseReviews.create({ course_id: courseId, learner_id: ctx.id, rating, comment: comment ?? null }),
    );

    const cache = await this.courseCache.findOne({ where: { course_id: courseId } });
    if (cache) await this.recomputeTier(cache.owner_id);
    await this.checkRatingTrigger(courseId);
    return review;
  }

  async listReviews(courseId: string) {
    const reviews = await this.courseReviews.find({ where: { course_id: courseId }, order: { created_at: 'DESC' } });
    const average = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : null;
    return {
      course_id: courseId,
      average_rating: average ? Number(average.toFixed(2)) : null,
      review_count: reviews.length,
      reviews: reviews.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment, created_at: r.created_at })),
    };
  }

  // ---- Trust tiers (spec §10.5) ----

  async trustTier(educatorId: string) {
    const row = await this.trustTiers.findOne({ where: { educator_id: educatorId } });
    return { educator_id: educatorId, tier: row?.tier ?? TrustTier.NEW, computed_at: row?.computed_at ?? null };
  }

  private async recomputeTier(payeeId: string) {
    const stats = (await this.stats.findOne({ where: { payee_id: payeeId } })) ?? { payments: 0, refunds: 0 };
    const refundRate = stats.payments > 0 ? stats.refunds / stats.payments : 0;

    let publishedCourses = 0;
    try {
      const res = await this.internal.get<{ published_count: number }>(`/api/v1/internal/owners/${payeeId}/published-count`);
      publishedCourses = res.published_count;
    } catch {
      /* course service unavailable — keep 0 */
    }

    const ownerCourses = await this.courseCache.find({ where: { owner_id: payeeId } });
    const courseIds = ownerCourses.map((c) => c.course_id);
    let avgRating = 0;
    if (courseIds.length) {
      const raw = await this.courseReviews
        .createQueryBuilder('r')
        .select('AVG(r.rating)', 'avg')
        .where('r.course_id IN (:...ids)', { ids: courseIds })
        .getRawOne<{ avg: string | null }>();
      avgRating = raw?.avg ? Number(raw.avg) : 0;
    }

    let tier = TrustTier.NEW;
    if (publishedCourses >= TRUSTED.courses && avgRating >= TRUSTED.rating && refundRate < TRUSTED.refundRate) {
      tier = TrustTier.TRUSTED;
    } else if (publishedCourses >= PROVEN.courses && avgRating >= PROVEN.rating && refundRate < PROVEN.refundRate) {
      tier = TrustTier.PROVEN;
    }

    const current = await this.trustTiers.findOne({ where: { educator_id: payeeId } });
    const previous = current?.tier ?? TrustTier.NEW;
    if (previous !== tier || !current) {
      await this.trustTiers.save(this.trustTiers.create({ educator_id: payeeId, tier, computed_at: new Date() }));
      if (previous !== tier) {
        await this.bus.publish<TrustTierChangedPayload>('TrustTierChanged', {
          educator_id: payeeId,
          previous_tier: previous,
          new_tier: tier,
        });
        this.logger.log(`trust tier ${payeeId}: ${previous} -> ${tier}`);
      }
    }
  }

  // ---- Fraud signals (spec §10.6) ----

  async raiseFraudSignal(input: {
    subject_type: FraudSubjectType;
    subject_id: string;
    signal_type: string;
    detail: string;
    payee_id?: string | null;
  }) {
    const signal = await this.fraudSignals.save(
      this.fraudSignals.create({
        subject_type: input.subject_type,
        subject_id: input.subject_id,
        signal_type: input.signal_type,
        detail: input.detail,
        payee_id: input.payee_id ?? null,
        status: FraudSignalStatus.OPEN,
      }),
    );
    await this.bus.publish<FraudFlagPayload>('FraudFlagRaised', {
      flag_id: signal.id,
      subject_type: signal.subject_type,
      subject_id: signal.subject_id,
      signal_type: signal.signal_type,
      payee_id: signal.payee_id,
      detail: signal.detail,
    });
    return signal;
  }

  async listFlags(status?: string) {
    return this.fraudSignals.find({
      where: status === 'resolved' ? { status: FraudSignalStatus.RESOLVED } : { status: FraudSignalStatus.OPEN },
      order: { created_at: 'DESC' },
    });
  }

  async resolveFlag(adminId: string, flagId: string) {
    const signal = await this.fraudSignals.findOne({ where: { id: flagId } });
    if (!signal) throw new NotFoundException('Fraud flag not found');
    if (signal.status === FraudSignalStatus.RESOLVED) return signal;
    signal.status = FraudSignalStatus.RESOLVED;
    signal.resolved_at = new Date();
    signal.resolved_by = adminId;
    await this.fraudSignals.save(signal);
    await this.bus.publish<FraudFlagPayload>('FraudFlagResolved', {
      flag_id: signal.id,
      subject_type: signal.subject_type,
      subject_id: signal.subject_id,
      signal_type: signal.signal_type,
      payee_id: signal.payee_id,
      detail: signal.detail,
    });
    return signal;
  }

  // ---- Post-publish auto triggers (spec §8) ----

  private async checkRatingTrigger(courseId: string) {
    const reviews = await this.courseReviews.find({ where: { course_id: courseId } });
    if (reviews.length < RATING_TRIGGER_MIN_REVIEWS) return;
    const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
    if (avg >= RATING_TRIGGER) return;
    await this.reopenForReview(courseId, `avg_rating ${avg.toFixed(2)} < ${RATING_TRIGGER}`);
  }

  private async checkRefundRateTrigger(cache: QualityCourseCache) {
    const stats = await this.stats.findOne({ where: { payee_id: cache.owner_id } });
    if (!stats || stats.payments < 5) return;
    if (stats.refunds / stats.payments > 0.2) {
      await this.reopenForReview(cache.course_id, `payee refund_rate > 20%`);
    }
  }

  private async reopenForReview(courseId: string, reason: string) {
    const open = await this.reviewItems.findOne({
      where: [
        { course_id: courseId, status: QaReviewStatus.PENDING },
        { course_id: courseId, status: QaReviewStatus.IN_REVIEW },
      ],
    });
    if (open) return;
    const last = await this.reviewItems.findOne({ where: { course_id: courseId }, order: { created_at: 'DESC' } });
    if (!last) return;
    await this.reviewItems.save(
      this.reviewItems.create({
        course_id: courseId,
        course_title: last.course_title,
        owner_id: last.owner_id,
        owner_type: last.owner_type,
        owner_email: last.owner_email,
        owner_name: last.owner_name,
        status: QaReviewStatus.PENDING,
        plagiarism: {},
        trigger: `post-publish: ${reason}`,
      }),
    );
    this.logger.warn(`course ${courseId} re-queued for QO review (${reason})`);
  }

  private async checkRefundAbuse(learnerId: string) {
    const count = await this.refundLog
      .createQueryBuilder('r')
      .where('r.learner_id = :learnerId', { learnerId })
      .andWhere("r.created_at > NOW() - INTERVAL '30 days'")
      .getCount();
    if (count > REFUND_ABUSE_COUNT) {
      const open = await this.fraudSignals.findOne({
        where: { subject_id: learnerId, signal_type: 'refund_abuse', status: FraudSignalStatus.OPEN },
      });
      if (!open) {
        await this.raiseFraudSignal({
          subject_type: FraudSubjectType.USER,
          subject_id: learnerId,
          signal_type: 'refund_abuse',
          detail: `${count} approved refunds in 30 days`,
          payee_id: null,
        });
      }
    }
  }

  private async bumpStats(payeeId: string, delta: Partial<Pick<PayeeStats, 'payments' | 'refunds' | 'completions'>>) {
    const row =
      (await this.stats.findOne({ where: { payee_id: payeeId } })) ??
      this.stats.create({ payee_id: payeeId, payments: 0, refunds: 0, completions: 0 });
    row.payments += delta.payments ?? 0;
    row.refunds += delta.refunds ?? 0;
    row.completions += delta.completions ?? 0;
    await this.stats.save(row);
  }
}
