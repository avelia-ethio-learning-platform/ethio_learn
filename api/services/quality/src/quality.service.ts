import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, LessThan, Not, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import { AiAssessor, createAiAssessor } from '@ethiopialearn/ai';
import {
  CourseAppealSubmittedPayload,
  CourseCompletedPayload,
  CourseRatedPayload,
  CourseReviewedPayload,
  CourseReviewWithdrawnPayload,
  CourseRevisionReviewedPayload,
  CourseRevisionSubmittedPayload,
  CourseSubmittedPayload,
  FraudFlagPayload,
  FraudSignalStatus,
  FraudSubjectType,
  OwnerType,
  PaymentConfirmedPayload,
  QaDecisionAction,
  QaItemKind,
  QaReviewStatus,
  RefundDecisionPayload,
  RevisionDiffSummary,
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

const OPEN_ITEM_STATUSES = [QaReviewStatus.PENDING, QaReviewStatus.IN_REVIEW];
/** Items that stand for the course's own review status (SUBMITTED), as opposed to a staged revision. */
const COURSE_SUBMISSION_KINDS: QaItemKind[] = ['new_course', 'appeal'];
// A claim lapses on its own so an officer who walks away never blocks an item.
export const CLAIM_TTL_MS = 30 * 60 * 1000;
// Review target is 24–48h (spec §2.1). A revision is a focused diff, so it gets the tight end.
const SLA_HOURS: Record<QaItemKind, number> = { revision: 24, new_course: 48, appeal: 48, post_publish: 48 };
const CHANGED_TEXT_LIMIT = 8000;

// A revision never touches the live course, so it can't be flagged; the others review the live
// (or about-to-be-live) course itself, so there are no staged changes to reject.
const REVISION_ACTIONS = [QaDecisionAction.APPROVE, QaDecisionAction.COACH, QaDecisionAction.REJECT];
const COURSE_ACTIONS = [QaDecisionAction.APPROVE, QaDecisionAction.COACH, QaDecisionAction.FLAG];
const DECISION_STATUS: Record<QaDecisionAction, QaReviewStatus> = {
  [QaDecisionAction.APPROVE]: QaReviewStatus.APPROVED,
  [QaDecisionAction.COACH]: QaReviewStatus.COACHED,
  [QaDecisionAction.FLAG]: QaReviewStatus.FLAGGED,
  [QaDecisionAction.REJECT]: QaReviewStatus.REJECTED,
};

export type QaQueueItem = QaReviewItem & { claim_active: boolean; sla_deadline: Date };
type ItemTransition = Partial<
  Pick<QaReviewItem, 'status' | 'claimed_by' | 'claimed_at' | 'qo_id' | 'coaching_notes' | 'reviewed_at'>
>;

/**
 * A revision is low risk when nothing a learner pays for or gets for free changes, no approved
 * video is swapped, and the text screen came back clear. It only raises queue priority — it is
 * never a reason to skip or shorten the human review.
 */
export function isLowRiskRevision(diff: Partial<RevisionDiffSummary>, plagiarism: Record<string, unknown>): boolean {
  const fields = diff.fields_changed ?? [];
  return (
    (diff.videos_replaced ?? 0) === 0 &&
    (diff.price_from ?? null) === (diff.price_to ?? null) &&
    !fields.includes('price_etb') &&
    (diff.pricing_type_from ?? null) === (diff.pricing_type_to ?? null) &&
    !fields.includes('pricing_type') &&
    !diff.new_free_preview_section &&
    plagiarism.flagged !== true &&
    // A screen that failed, or has not finished, is not a clear screen.
    !('error' in plagiarism) &&
    plagiarism.pending !== true
  );
}

/** Stored on a new item until its AI screen returns (see enqueueSubmission / enqueueRevision). */
const screenPending = (): Record<string, unknown> => ({ pending: true });

export function isClaimActive(item: Pick<QaReviewItem, 'status' | 'claimed_by' | 'claimed_at'>): boolean {
  return (
    OPEN_ITEM_STATUSES.includes(item.status) &&
    !!item.claimed_by &&
    !!item.claimed_at &&
    Date.now() - item.claimed_at.getTime() < CLAIM_TTL_MS
  );
}

@Injectable()
export class QualityService implements OnModuleInit {
  private readonly logger = new Logger(QualityService.name);
  private readonly ai: AiAssessor = createAiAssessor();
  /** Tail of the per-course chain that keeps review-item events in delivery order (see inCourseOrder). */
  private readonly courseChains = new Map<string, Promise<void>>();

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
    // Submission → QO queue, then the AI plagiarism screen fills in (spec §12.1).
    this.bus.subscribe<CourseSubmittedPayload>('CourseSubmitted', (p) => this.enqueueSubmission(p));
    // Appeal on a flagged course → back into the review queue for a fresh look.
    this.bus.subscribe<CourseAppealSubmittedPayload>('CourseAppealSubmitted', (p) =>
      this.inCourseOrder(p.course_id, () => this.enqueueAppeal(p)),
    );
    // Staged changes to a live course → a focused re-review of the diff only.
    this.bus.subscribe<CourseRevisionSubmittedPayload>('CourseRevisionSubmitted', (p) => this.enqueueRevision(p));
    // The educator pulled a submission back → its item must not be decidable any more.
    this.bus.subscribe<CourseReviewWithdrawnPayload>('CourseReviewWithdrawn', (p) =>
      this.inCourseOrder(p.course_id, () => this.withdrawItems(p)),
    );
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

  /**
   * Runs `task` once every earlier task for the same course has settled. The bus starts each
   * handler in delivery order but never waits for one to finish before starting the next (and a
   * backlog after a restart or free-tier sleep arrives all at once). Without this, the one-UPDATE
   * CourseReviewWithdrawn handler overtakes the CourseSubmitted / CourseRevisionSubmitted just
   * ahead of it, finds nothing to close, and the item inserted a moment later stays decidable
   * for a submission that is back in draft. Must be called synchronously from the bus handler
   * so the chain order is the delivery order. Single instance, so an in-process chain suffices.
   */
  private inCourseOrder<T>(courseId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.courseChains.get(courseId) ?? Promise.resolve()).then(task);
    // A failed task must not stall the course's later events (the bus acks it either way).
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.courseChains.set(courseId, tail);
    // Forget the course once nothing is queued behind this task, so the map stays small.
    void tail.then(() => {
      if (this.courseChains.get(courseId) === tail) this.courseChains.delete(courseId);
    });
    return run;
  }

  private async enqueueSubmission(p: CourseSubmittedPayload) {
    // Queue the item before the AI screen (a Groq call of up to ~25 s), inside the course's
    // event order, so a CourseReviewWithdrawn right behind this event always finds it to close.
    const item = await this.inCourseOrder(p.course_id, async () => {
      await this.courseCache.save(
        this.courseCache.create({ course_id: p.course_id, owner_id: p.owner_id, owner_type: p.owner_type, title: p.title }),
      );
      // A course is in first-time review at most once at a time, so any submission item still
      // open is stale (a withdraw that predates CourseReviewWithdrawn, or a redelivered event).
      // Left open it would be decidable and would make the by-course decision ambiguous.
      await this.closeOpenItems({ course_id: p.course_id, kind: In(COURSE_SUBMISSION_KINDS) });
      return this.reviewItems.save(
        this.reviewItems.create({
          course_id: p.course_id,
          course_title: p.title,
          owner_id: p.owner_id,
          owner_type: p.owner_type,
          owner_user_id: p.owner_user_id,
          owner_email: p.owner_email,
          owner_name: p.owner_name,
          status: QaReviewStatus.PENDING,
          plagiarism: screenPending(),
          trigger: 'submission',
          kind: 'new_course',
        }),
      );
    });
    this.logger.log(`course ${p.course_id} queued for QO review (item ${item.id})`);

    // Outside the course chain: a withdrawal should not wait on the AI.
    const plagiarism = await this.screenText(p.course_id, p.owner_id, p.title, p.description);
    await this.recordScreen(item.id, plagiarism);
    // The flagged text was submitted even if the item has since been withdrawn or decided.
    if (plagiarism.flagged) await this.raisePlagiarismSignal(p.course_id, p.owner_id, plagiarism);
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
        kind: 'appeal',
      }),
    );
    this.logger.log(`course ${p.course_id} re-queued via appeal`);
  }

  private async enqueueRevision(p: CourseRevisionSubmittedPayload) {
    // Screen only the new or changed text: the approved text was already cleared, and a
    // video- or price-only change has nothing for the AI to read.
    const changedText = (p.changed_text ?? '').slice(0, CHANGED_TEXT_LIMIT).trim();
    const diff = p.diff_summary ?? {};

    // Queue the item before the AI screen, inside the course's event order, so a
    // CourseReviewWithdrawn right behind this event always finds it to close (see inCourseOrder).
    const item = await this.inCourseOrder(p.course_id, async () => {
      // Courses seeded before the cache existed still need the owner mapping for trust math. An
      // existing row is left alone: the duplicate-screen corpus must only ever hold LIVE titles.
      const cached = await this.courseCache.findOne({ where: { course_id: p.course_id } });
      if (!cached) {
        await this.courseCache.save(
          this.courseCache.create({
            course_id: p.course_id,
            owner_id: p.owner_id,
            owner_type: p.owner_type,
            title: p.course_title,
          }),
        );
      }
      // One open revision per course (course service invariant), so an older open item is a
      // superseded submission of it — including an earlier submission of this same revision id.
      await this.closeOpenItems({ course_id: p.course_id, kind: 'revision' });
      const plagiarism = changedText ? screenPending() : { skipped: 'no new text' };
      return this.reviewItems.save(
        this.reviewItems.create({
          course_id: p.course_id,
          course_title: p.course_title,
          owner_id: p.owner_id,
          owner_type: p.owner_type,
          owner_user_id: p.owner_user_id,
          owner_email: p.owner_email,
          owner_name: p.owner_name,
          status: QaReviewStatus.PENDING,
          plagiarism,
          trigger: 'revision',
          kind: 'revision',
          revision_id: p.revision_id,
          // Binds this item's decision to exactly the content submitted with it.
          content_hash: p.content_hash || null,
          diff_summary: diff,
          changelog_summary: p.changelog_summary ?? '',
          priority: isLowRiskRevision(diff, plagiarism) ? 1 : 0,
        }),
      );
    });
    this.logger.log(`revision ${p.revision_id} of course ${p.course_id} queued for QO review (item ${item.id})`);
    if (!changedText) return;

    // Outside the course chain: a withdrawal should not wait on the AI.
    const plagiarism = await this.screenText(p.course_id, p.owner_id, p.course_title, changedText);
    await this.recordScreen(item.id, plagiarism, isLowRiskRevision(diff, plagiarism) ? 1 : 0);
    // The flagged text was submitted even if the item has since been withdrawn or decided.
    if (plagiarism.flagged) await this.raisePlagiarismSignal(p.course_id, p.owner_id, plagiarism);
  }

  /**
   * Stores the AI screen on an item only while it is still open. Once it was withdrawn (or
   * decided while the screen ran) it is out of the queue, and this write must never touch it.
   */
  private async recordScreen(itemId: string, plagiarism: Record<string, unknown>, priority?: number) {
    const res = await this.reviewItems.update(
      { id: itemId, status: In(OPEN_ITEM_STATUSES) },
      {
        plagiarism: plagiarism as QueryDeepPartialEntity<Record<string, unknown>>,
        ...(priority === undefined ? {} : { priority }),
      },
    );
    if (!res.affected) {
      this.logger.log(`item ${itemId} closed before its AI screen finished; screen result not stored on it`);
    }
  }

  private async withdrawItems(p: CourseReviewWithdrawnPayload) {
    // revision_id null = the course's own submission (first-time or appeal) went back to draft.
    const closed = await this.closeOpenItems(
      p.revision_id
        ? { course_id: p.course_id, kind: 'revision', revision_id: p.revision_id }
        : { course_id: p.course_id, kind: In(COURSE_SUBMISSION_KINDS) },
    );
    if (closed) this.logger.log(`course ${p.course_id}: ${closed} review item(s) withdrawn`);
  }

  private async closeOpenItems(where: FindOptionsWhere<QaReviewItem>): Promise<number> {
    const res = await this.reviewItems.update(
      { ...where, status: In(OPEN_ITEM_STATUSES) },
      { status: QaReviewStatus.WITHDRAWN },
    );
    return res.affected ?? 0;
  }

  /**
   * Catalog-aware screening: the AI also gets other owners' course titles so it can
   * detect near-duplication within the platform, not just against its training data.
   */
  private async screenText(
    courseId: string,
    ownerId: string,
    title: string,
    text: string,
  ): Promise<Record<string, unknown>> {
    try {
      const others = await this.courseCache
        .createQueryBuilder('c')
        .select('c.title', 'title')
        .where('c.owner_id != :owner', { owner: ownerId })
        .andWhere('c.course_id != :cid', { cid: courseId })
        .limit(60)
        .getRawMany<{ title: string }>();
      return { ...(await this.ai.plagiarismCheck(title, text, others.map((o) => o.title))) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  private async raisePlagiarismSignal(courseId: string, ownerId: string, plagiarism: Record<string, unknown>) {
    await this.raiseFraudSignal({
      subject_type: FraudSubjectType.COURSE,
      subject_id: courseId,
      signal_type: 'plagiarism_suspected',
      detail: String(plagiarism.reason ?? ''),
      payee_id: ownerId,
    });
  }

  /** Open items, most urgent first: SLA deadline, then priority (spec §2.1). */
  async queue(): Promise<QaQueueItem[]> {
    const items = await this.reviewItems.find({ where: { status: In(OPEN_ITEM_STATUSES) } });
    return items
      .map((item) => this.withReviewMeta(item))
      .sort(
        (a, b) =>
          a.sla_deadline.getTime() - b.sla_deadline.getTime() ||
          b.priority - a.priority ||
          a.created_at.getTime() - b.created_at.getTime(),
      );
  }

  async reviewDetail(courseId: string) {
    const item = await this.reviewItems.findOne({
      where: { course_id: courseId },
      order: { created_at: 'DESC' },
    });
    if (!item) throw new NotFoundException('No review item for this course');
    return item;
  }

  async getItem(itemId: string): Promise<QaQueueItem> {
    return this.withReviewMeta(await this.findItem(itemId));
  }

  /** Take (or refresh) the soft lock on an item so other officers see it is being reviewed. */
  async claim(ctx: UserContext, itemId: string): Promise<QaQueueItem> {
    const item = await this.findItem(itemId);
    this.assertActionable(item, ctx.id);
    const claim = { status: QaReviewStatus.IN_REVIEW, claimed_by: ctx.id, claimed_at: new Date() };
    await this.updateIfActionable(item.id, ctx.id, claim);
    return this.withReviewMeta(Object.assign(item, claim));
  }

  /**
   * Back-compat by-course decision (older QA UI). Ambiguous once a course can have a revision
   * and a post-publish item open at the same time, so it only works when exactly one is open.
   */
  async decide(ctx: UserContext, courseId: string, action: QaDecisionAction, notes?: string) {
    const open = await this.reviewItems.find({
      where: { course_id: courseId, status: In(OPEN_ITEM_STATUSES) },
      order: { created_at: 'DESC' },
      take: 2,
    });
    if (!open.length) throw new NotFoundException('No pending review for this course');
    if (open.length > 1) {
      throw new ConflictException('Multiple reviews open — decide by item (POST /qa/items/:id/decision).');
    }
    return this.decideLoaded(ctx, open[0], action, notes);
  }

  /**
   * Checklist decision on one item (spec §8). Revisions: approve | coach | reject, announced
   * with CourseRevisionReviewed so only the staged changes are applied or discarded. Every other
   * kind: approve | coach | flag via CourseReviewed. Nothing here is ever decided automatically.
   */
  async decideItem(ctx: UserContext, itemId: string, action: QaDecisionAction, notes?: string) {
    return this.decideLoaded(ctx, await this.findItem(itemId), action, notes);
  }

  private async decideLoaded(ctx: UserContext, item: QaReviewItem, action: QaDecisionAction, notes?: string) {
    this.assertActionable(item, ctx.id);
    const trimmed = notes?.trim() ?? '';
    this.assertDecisionAllowed(item, action, trimmed);

    const previous = {
      status: item.status,
      qo_id: item.qo_id,
      coaching_notes: item.coaching_notes,
      reviewed_at: item.reviewed_at,
    };
    const decided = {
      status: DECISION_STATUS[action],
      qo_id: ctx.id,
      coaching_notes: trimmed,
      reviewed_at: new Date(),
    };
    // Conditional write: of two officers deciding at once, exactly one wins and publishes.
    await this.updateIfActionable(item.id, ctx.id, decided);
    Object.assign(item, decided);

    try {
      await this.publishDecision(item, action, trimmed || null, ctx.id);
    } catch (err) {
      // The course only changes when it hears the decision. If the event never left, reopen
      // the item so it can be decided again instead of showing as decided forever.
      await this.reviewItems.update({ id: item.id, status: decided.status }, previous);
      this.logger.error(`decision on item ${item.id} not published: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        'The decision could not be delivered to the course service, so nothing changed. Try again in a minute.',
      );
    }
    return item;
  }

  private async publishDecision(item: QaReviewItem, action: QaDecisionAction, notes: string | null, qoId: string) {
    if (item.kind === 'revision') {
      await this.bus.publish<CourseRevisionReviewedPayload>('CourseRevisionReviewed', {
        course_id: item.course_id,
        revision_id: item.revision_id as string, // presence checked in assertDecisionAllowed
        review_item_id: item.id,
        action: action as CourseRevisionReviewedPayload['action'],
        notes,
        qo_id: qoId,
        owner_user_id: item.owner_user_id ?? '',
        owner_email: item.owner_email,
        course_title: item.course_title,
        // The course service applies the decision only if the revision still holds this exact
        // content, so a stale decision on a withdrawn-and-resubmitted revision is a no-op.
        content_hash: item.content_hash as string, // presence checked in assertDecisionAllowed
      });
      return;
    }
    await this.bus.publish<CourseReviewedPayload>('CourseReviewed', {
      course_id: item.course_id,
      action,
      notes,
      qo_id: qoId,
      owner_user_id: item.owner_user_id ?? '',
      owner_email: item.owner_email,
      course_title: item.course_title,
      // Lets subscribers tell a first publish ('new_course') from a re-check of a live course.
      kind: item.kind,
    });
  }

  private assertDecisionAllowed(item: QaReviewItem, action: QaDecisionAction, notes: string) {
    const isRevision = item.kind === 'revision';
    if (!(isRevision ? REVISION_ACTIONS : COURSE_ACTIONS).includes(action)) {
      throw new BadRequestException(
        isRevision
          ? 'Revisions are approved, returned (coach) or rejected. Use the admin tools to unlist a live course.'
          : 'Reject is only for changes to a live course. ' +
              'Use coach to send this course back to the educator, or flag to take it down.',
      );
    }
    if (action === QaDecisionAction.COACH && !notes) {
      throw new BadRequestException('Coaching requires notes for the educator — say what needs to change.');
    }
    if (action === QaDecisionAction.REJECT && !notes) {
      throw new BadRequestException(
        'Rejecting changes requires notes for the educator — say why they cannot go live.',
      );
    }
    if (isRevision && !item.revision_id) {
      throw new ConflictException(
        'This revision item is missing its revision id. Ask the educator to resubmit the changes.',
      );
    }
    // Without the fingerprint a decision can't be tied to the content that was reviewed, and the
    // course service would ignore it as stale — refuse here so nothing looks decided that isn't.
    if (isRevision && !item.content_hash) {
      throw new ConflictException(
        'This revision item was queued without a content fingerprint, so a decision could not be ' +
          'tied to the changes you reviewed. Ask the educator to withdraw and resubmit the changes.',
      );
    }
  }

  private async findItem(itemId: string): Promise<QaReviewItem> {
    const item = await this.reviewItems.findOne({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Review item not found. Refresh the queue.');
    return item;
  }

  /** The item can be claimed or decided by this officer: still open and not locked by someone else. */
  private assertActionable(item: QaReviewItem, officerId: string) {
    if (!OPEN_ITEM_STATUSES.includes(item.status)) {
      throw new ConflictException(`This review is already closed (${item.status}). Refresh the queue.`);
    }
    if (item.claimed_by !== officerId && isClaimActive(item)) {
      throw new ConflictException(
        'Already being reviewed by another officer. Pick another item, or try again once their 30-minute claim lapses.',
      );
    }
  }

  /**
   * Applies `changes` only while the item is still open and unclaimed, claimed by this officer,
   * or its claim has lapsed — the same rule as assertActionable, enforced by the database so a
   * concurrent claim or decision can't slip in between the read and the write.
   */
  private async updateIfActionable(itemId: string, officerId: string, changes: ItemTransition) {
    const open = { id: itemId, status: In(OPEN_ITEM_STATUSES) };
    const res = await this.reviewItems.update(
      [
        { ...open, claimed_by: IsNull() },
        { ...open, claimed_by: officerId },
        { ...open, claimed_at: LessThan(new Date(Date.now() - CLAIM_TTL_MS)) },
      ],
      changes,
    );
    if (res.affected) return;
    // Lost a race: re-read to report what changed.
    this.assertActionable(await this.findItem(itemId), officerId);
    throw new ConflictException('This review changed while you were working on it. Refresh the queue and try again.');
  }

  private withReviewMeta(item: QaReviewItem): QaQueueItem {
    const slaHours = SLA_HOURS[item.kind] ?? SLA_HOURS.new_course;
    return {
      ...item,
      claim_active: isClaimActive(item),
      sla_deadline: new Date(item.created_at.getTime() + slaHours * 3600 * 1000),
    };
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

    // Broadcast fresh aggregates so the course service can rank the catalog
    // (event-carried state — no cross-schema reads at query time).
    const all = await this.courseReviews.find({ where: { course_id: courseId } });
    const totalPoints = all.reduce((s, r) => s + r.rating, 0);
    await this.bus.publish<CourseRatedPayload>('CourseRated', {
      course_id: courseId,
      average_rating: Number((totalPoints / all.length).toFixed(2)),
      rating_count: all.length,
      total_points: totalPoints,
    });

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
    // An open revision item reviews staged changes, not the live course, so it must not
    // suppress a re-check of what learners are seeing now.
    const open = await this.reviewItems.findOne({
      where: { course_id: courseId, status: In(OPEN_ITEM_STATUSES), kind: Not('revision') },
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
        // Without the user id the decision notification has no recipient.
        owner_user_id: last.owner_user_id,
        owner_email: last.owner_email,
        owner_name: last.owner_name,
        status: QaReviewStatus.PENDING,
        plagiarism: {},
        trigger: `post-publish: ${reason}`,
        kind: 'post_publish',
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
