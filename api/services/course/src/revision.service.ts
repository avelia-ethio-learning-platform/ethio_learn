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
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import {
  CourseInstitutionReviewedPayload,
  CourseReviewWithdrawnPayload,
  CourseRevisionClosedPayload,
  CourseRevisionReviewedPayload,
  CourseRevisionStatus,
  CourseRevisionSubmittedPayload,
  CourseStatus,
  CourseSubmittedToInstitutionPayload,
  CourseUpdatedPayload,
  OPEN_REVISION_STATUSES,
  Role,
} from '@ethiopialearn/contracts';
import { Course, CourseChangeLog, CourseRevision } from './entities';
import { CourseService } from './course.service';
import { CourseExtrasService } from './course-extras.service';
import {
  changedText,
  changelogSentence,
  computeDiff,
  contentHash,
  frozenAssessments,
  mergedCourse,
  pendingAssessmentIds,
  RevisionDiffBody,
  validateMerged,
} from './revision-diff';
import { AppliedLessonIds, applyStagedState, discardStagedState, hasStagedState, loadStagedState } from './staging';

/** An approval arrived, but the staged content no longer matches what the officer reviewed. */
export const HASH_MISMATCH_NOTE = 'Your update was approved but the course changed during review — please check and resubmit.';
/** An approval arrived, but every attempt to apply it failed (e.g. the database was unavailable). */
export const APPLY_FAILED_NOTE = 'We could not apply your approved update — please resubmit.';

const IN_REVIEW: CourseRevisionStatus[] = ['submitted', 'institution_review'];

type ApplyResult =
  | { outcome: 'stale'; reason: string }
  | { outcome: 'hash_mismatch' }
  | {
      outcome: 'applied';
      course: Course;
      revision: CourseRevision;
      lessonIds: AppliedLessonIds;
      assessmentIds: string[];
      title: string;
      changelog: CourseChangeLog;
      closedAt: Date;
    };

/** First characters of a content hash, enough to tell submissions apart in a log line. */
function short(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 12) : 'none';
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * Lifecycle of a staged change set on a live (published/unlisted) course:
 * the educator submits it, a QO approves (apply), coaches or rejects it.
 * Writes that stage the changes live in CourseService; this service owns the
 * review side and the apply step. course.status and published_at never change
 * because of a revision.
 */
@Injectable()
export class RevisionService implements OnModuleInit {
  private readonly logger = new Logger(RevisionService.name);

  /**
   * Backoff between the 3 attempts of a revision decision. The event bus acks
   * a message even when its handler throws, so a transient DB error would
   * otherwise lose an approval for good.
   */
  retryDelaysMs = [1000, 3000];

  constructor(
    @InjectRepository(CourseRevision) private readonly revisions: Repository<CourseRevision>,
    private readonly dataSource: DataSource,
    private readonly courseService: CourseService,
    private readonly extras: CourseExtrasService,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
  ) {}

  onModuleInit() {
    this.bus.subscribe<CourseRevisionReviewedPayload>('CourseRevisionReviewed', (payload) => this.onRevisionReviewed(payload));
  }

  async onRevisionReviewed(payload: CourseRevisionReviewedPayload): Promise<void> {
    // The hash names the submission the officer decided on. Without it the
    // decision cannot be told apart from one on an earlier submission of the
    // same (reused) revision id, so it is never acted on.
    if (typeof payload.content_hash !== 'string' || !payload.content_hash) {
      this.logger.warn(
        `ignoring CourseRevisionReviewed ${payload.action} for revision ${payload.revision_id}: it carries no content_hash, so it cannot be matched to a submission`,
      );
      return;
    }
    if (payload.action === 'approve') return this.apply(payload);
    if (payload.action === 'coach') return this.coach(payload);
    if (payload.action === 'reject') return this.reject(payload);
    this.logger.warn(`ignoring CourseRevisionReviewed ${payload.revision_id} with unknown action '${String(payload.action)}'`);
  }

  // ---- Educator + reviewer reads -----------------------------------------

  /** Before/after of the open revision. QOs only see it once it is submitted. */
  async currentDiff(ctx: UserContext, courseId: string) {
    const course = await this.courseService.courseOrThrow(courseId);
    if (!(await this.courseService.isStaffFor(ctx, course))) {
      throw new ForbiddenException("Only the course's instructor, its institution admin and reviewers can see its staged changes");
    }
    const revision = await this.openRevision(courseId);
    const isAuthor = course.created_by === ctx.id || course.owner_id === ctx.id;
    if (!revision || (ctx.role === Role.QUALITY_OFFICER && !isAuthor && revision.status !== 'submitted')) {
      throw new NotFoundException('This course has no staged changes waiting for review');
    }
    // In review, only the assessments frozen at submit are part of the decision
    // (approve/reject act on exactly those); one created later waits for the next revision.
    const frozenIds = IN_REVIEW.includes(revision.status) ? this.frozenAssessmentIds(revision) : null;
    let assessments: unknown[] = [];
    if (!frozenIds || frozenIds.length) {
      const fetched = await this.fetchPendingAssessments(courseId);
      // Fail closed: an empty list here would let a reviewer approve quizzes
      // (with their answer keys) that they never saw.
      if (!fetched.ok) throw new ServiceUnavailableException('Could not load the new assessments — try again in a minute.');
      assessments = frozenIds ? frozenAssessments(fetched.items, frozenIds) : fetched.items;
    }
    const state = await loadStagedState(this.dataSource.manager, course);
    return { revision: this.revisionView(revision), ...computeDiff(state, assessments) };
  }

  // ---- Educator actions ------------------------------------------------------

  async submit(ctx: UserContext, courseId: string, dto: { summary?: string; major?: boolean }) {
    const course = await this.courseService.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.PUBLISHED && course.status !== CourseStatus.UNLISTED) {
      throw new BadRequestException(
        `Only a live course has staged changes to submit (this one is ${course.status}). Use "Submit for review" to send a draft course for its first review.`,
      );
    }
    let revision = await this.openRevision(courseId);
    if (revision && revision.status !== 'draft') {
      throw new ConflictException('These changes are already in review. Withdraw them first if you need to edit them again.');
    }

    const assessments = await this.fetchPendingAssessments(courseId);
    // Fail closed: the assessments frozen here are exactly what the reviewer
    // sees and what an approval makes live. Freezing an empty list because
    // outcomes was asleep would hide new quizzes from the review, and "nothing
    // to submit" might be wrong for a revision that only adds assessments.
    if (!assessments.ok) throw new ServiceUnavailableException('Could not check your pending assessments right now. Please try again in a minute.');
    const state = await loadStagedState(this.dataSource.manager, course);
    const diff = computeDiff(state, assessments.items);
    if (diff.empty) {
      // Staged values that equal the live ones (e.g. a title changed and changed
      // back) still show as unpublished changes on the teach page.
      if (hasStagedState(state)) {
        throw new BadRequestException('Your staged edits match the live course, so there is nothing to review. Use "Discard changes" to clear them.');
      }
      throw new BadRequestException('There are no changes to submit.');
    }
    const invalid = validateMerged(state);
    if (invalid) throw new BadRequestException(invalid);

    // No open revision but staged rows: a flag or archive closed the previous
    // revision and kept its rows for after reinstatement. They get a new one.
    if (!revision) revision = await this.createRevision(courseId, ctx.id);
    const status: CourseRevisionStatus = course.institution_id ? 'institution_review' : 'submitted';
    const summary = dto.summary?.trim() ? dto.summary.trim().slice(0, 1000) : null;
    const major = !!dto.major;
    // The hash names this submission (the revision id is reused after a
    // withdraw or coach), so a decision can only apply what the officer saw.
    const hash = contentHash(state, pendingAssessmentIds(diff.pending_assessments));
    const res = await this.revisions.update(
      { id: revision.id, status: 'draft' },
      {
        status,
        diff: diff as unknown as QueryDeepPartialEntity<Record<string, unknown>>,
        content_hash: hash,
        changelog_summary: summary,
        changelog_major: major,
        submitted_at: new Date(),
        // A resubmission after coaching starts a fresh decision.
        decided_at: null,
        decided_by: null,
        decision_notes: null,
      },
    );
    if (!res.affected) throw new ConflictException('Your changes changed state while submitting. Reload the page and try again.');

    if (status === 'institution_review') {
      const inst = await this.resolveInstitution(course.created_by);
      const owner = await this.courseService.ownerContact(course);
      if (inst?.institution_admin_user_id) {
        await this.bus.publish<CourseSubmittedToInstitutionPayload>('CourseSubmittedToInstitution', {
          course_id: course.id,
          course_title: course.title,
          institution_admin_user_id: inst.institution_admin_user_id,
          instructor_name: owner.name,
          revision_id: revision.id,
        });
      } else {
        this.logger.warn(`revision ${revision.id}: no institution admin found for ${course.created_by}; it waits in the institution queue unannounced`);
      }
    } else {
      await this.publishSubmitted(course, revision.id, diff, summary, major, hash);
    }
    return { revision_id: revision.id, status };
  }

  async withdraw(ctx: UserContext, courseId: string) {
    await this.courseService.ownedCourse(ctx, courseId);
    const revision = await this.openRevision(courseId);
    if (!revision || !IN_REVIEW.includes(revision.status)) {
      throw new BadRequestException('There is no submitted update to withdraw.');
    }
    const res = await this.revisions.update({ id: revision.id, status: In(IN_REVIEW) }, { status: 'draft', submitted_at: null });
    if (!res.affected) throw new ConflictException('This update was decided a moment ago. Reload the page to see the result.');
    await this.bus.publish<CourseReviewWithdrawnPayload>('CourseReviewWithdrawn', { course_id: courseId, revision_id: revision.id });
    return { status: 'draft' as const };
  }

  async discard(ctx: UserContext, courseId: string) {
    const course = await this.courseService.ownedCourse(ctx, courseId);
    let revision = await this.openRevision(courseId);
    if (!revision) {
      // Staged changes can outlive their revision (a flag or archive closes it
      // and keeps the rows), and pending assessments live in the outcomes
      // service. Either way a revision row is needed so the discard is closed
      // through CourseRevisionClosed like any other. Only on a live course:
      // on a draft, leftover staged rows are the draft's own content and get
      // folded into it, never thrown away.
      if (course.status !== CourseStatus.PUBLISHED && course.status !== CourseStatus.UNLISTED) {
        throw new BadRequestException(`Only a live course has staged changes to discard (this one is ${course.status}).`);
      }
      if (!(await this.hasStagedChanges(course))) throw new NotFoundException('There are no staged changes to discard.');
      revision = await this.createRevision(courseId, ctx.id);
    }
    if (revision.status !== 'draft') throw new ConflictException('Your changes are in review. Withdraw them before discarding.');
    const open = revision;

    const closedAt = new Date();
    const discarded = await this.dataSource.transaction(async (m) => {
      const res = await m
        .getRepository(CourseRevision)
        .update({ id: open.id, status: 'draft' }, { status: 'discarded', decided_at: closedAt, decided_by: ctx.id });
      if (!res.affected) return false;
      const locked = await this.lockCourse(m, courseId);
      if (locked) await discardStagedState(m, await loadStagedState(m, locked));
      return true;
    });
    if (!discarded) throw new ConflictException('Your changes were submitted or discarded a moment ago. Reload the page and try again.');

    const owner = await this.courseService.ownerContact(course);
    await this.bus.publish<CourseRevisionClosedPayload>('CourseRevisionClosed', {
      // No ids: outcomes deletes every pending assessment created up to closed_at.
      ...this.closedBase(course, open, owner.email, [], closedAt),
      outcome: 'discarded',
      submitted_at: null,
      notes: null,
    });
    return { discarded: true };
  }

  // ---- QO decision (CourseRevisionReviewed subscriber) -------------------

  /**
   * Approve: copy the staged state onto the live rows in ONE transaction.
   * Idempotent — the conditional status UPDATE makes a redelivered, stale or
   * withdrawn decision a no-op — and bound to one submission by the content
   * hash: the decision must carry the hash frozen at that submit, and the
   * staged rows must still hash to it, so nothing other than what the QO
   * reviewed can go live.
   *
   * An approval that cannot be applied (content changed, or every attempt
   * failed) puts the revision back in the educator's hands with a coach
   * decision of its own: the officer's QA item is already closed, so otherwise
   * the educator would never learn that nothing went live.
   */
  async apply(payload: CourseRevisionReviewedPayload): Promise<void> {
    let result: ApplyResult;
    try {
      result = await this.withRetry(`apply revision ${payload.revision_id}`, () =>
        this.dataSource.transaction((m) => this.applyInTransaction(m, payload)),
      );
    } catch (err) {
      this.logger.error(`revision ${payload.revision_id}: every attempt to apply the approval failed (${(err as Error).message})`);
      await this.returnUnapplied(payload);
      return;
    }
    if (result.outcome === 'stale') {
      this.logger.warn(`revision ${payload.revision_id}: approve ignored — ${result.reason}`);
      return;
    }
    if (result.outcome === 'hash_mismatch') {
      this.logger.warn(`revision ${payload.revision_id} changed after submit — returned to draft, nothing applied`);
      await this.publishReturned(payload, HASH_MISMATCH_NOTE);
      return;
    }

    const { course, revision, lessonIds, assessmentIds, title, changelog, closedAt } = result;
    this.courseService.clearSearchCache();
    try {
      await this.extras.reindexCourse(course.id);
    } catch (err) {
      this.logger.warn(`tutor reindex after applying revision ${revision.id} failed: ${(err as Error).message}`);
    }
    const owner = await this.courseService.ownerContact(course);
    if (revision.changelog_major) {
      try {
        await this.withRetry('publish CourseUpdated', () =>
          this.bus.publish<CourseUpdatedPayload>('CourseUpdated', {
            course_id: course.id,
            course_title: title,
            owner_user_id: course.created_by,
            summary: changelog.summary,
            changelog_id: changelog.id,
          }),
        );
      } catch (err) {
        // Learners miss one announcement; CourseRevisionClosed below still has
        // to go out (it makes the reviewed assessments live and tells the educator).
        this.logger.error(`CourseUpdated for revision ${revision.id} could not be published: ${(err as Error).message}`);
      }
    }
    await this.withRetry('publish CourseRevisionClosed', () =>
      this.bus.publish<CourseRevisionClosedPayload>('CourseRevisionClosed', {
        ...this.closedBase(course, revision, owner.email || payload.owner_email, assessmentIds, closedAt),
        added_lesson_ids: lessonIds.addedLessonIds,
        removed_lesson_ids: lessonIds.removedLessonIds,
        replaced_video_lesson_ids: lessonIds.replacedVideoLessonIds,
        outcome: 'applied',
        submitted_at: iso(revision.submitted_at),
        course_title: title,
        notes: payload.notes ?? null,
      }),
    );
    this.logger.log(`revision ${revision.id} applied to course ${course.id}`);
  }

  private async applyInTransaction(m: EntityManager, payload: CourseRevisionReviewedPayload): Promise<ApplyResult> {
    const revisionRepo = m.getRepository(CourseRevision);
    const now = new Date();
    const claimed = await revisionRepo.update(
      this.decidable(payload),
      { status: 'applied', decided_at: now, decided_by: payload.qo_id, decision_notes: payload.notes ?? null },
    );
    if (!claimed.affected) return { outcome: 'stale', reason: await this.staleReason(revisionRepo, payload) };

    const course = await this.lockCourse(m, payload.course_id);
    const revision = await revisionRepo.findOne({ where: { id: payload.revision_id } });
    if (!course || !revision) return { outcome: 'stale', reason: 'the course no longer exists' };

    const assessmentIds = this.frozenAssessmentIds(revision);
    const state = await loadStagedState(m, course);
    if (contentHash(state, assessmentIds) !== revision.content_hash) {
      await revisionRepo.update({ id: revision.id }, { status: 'draft', submitted_at: null, decision_notes: HASH_MISMATCH_NOTE });
      return { outcome: 'hash_mismatch' };
    }

    // Read before the rows change: the title learners will see, and the
    // change-log fallback for a revision frozen without a diff.
    const title = mergedCourse(course).title;
    const frozen = revision.diff as unknown as RevisionDiffBody | null;
    const summary = (revision.changelog_summary?.trim() || changelogSentence(frozen?.diff_summary ?? computeDiff(state).diff_summary)).slice(0, 1000);
    const lessonIds = await applyStagedState(m, state);

    const changelogRepo = m.getRepository(CourseChangeLog);
    const changelog = await changelogRepo.save(
      changelogRepo.create({ course_id: course.id, kind: revision.changelog_major ? 'major' : 'minor', summary, created_by: revision.created_by }),
    );
    // Deliberately no status / published_at here: an UNLISTED course stays unlisted.
    await m.getRepository(Course).update(
      { id: course.id },
      {
        last_review_action: 'approve',
        last_review_notes: payload.notes ?? null,
        last_reviewed_at: now,
        ...(revision.changelog_major ? { last_major_update_at: now } : {}),
      },
    );
    return { outcome: 'applied', course, revision, lessonIds, assessmentIds, title, changelog, closedAt: now };
  }

  /**
   * Every attempt to apply an approval failed (e.g. the database was down for
   * longer than the retries). Leaving the revision 'submitted' would lock the
   * editor "In review" with no open QA item, so it goes back to draft and the
   * educator is asked to resubmit.
   */
  private async returnUnapplied(payload: CourseRevisionReviewedPayload): Promise<void> {
    try {
      const res = await this.revisions.update(this.decidable(payload), {
        status: 'draft',
        submitted_at: null,
        decided_at: new Date(),
        decided_by: payload.qo_id,
        decision_notes: APPLY_FAILED_NOTE,
      });
      if (!res.affected) {
        // Withdrawn, closed or decided meanwhile — someone else owns it now.
        this.logger.warn(`revision ${payload.revision_id} is no longer awaiting this decision; not returned to the educator`);
        return;
      }
    } catch (err) {
      // Still unreachable. The coach decision below also reaches this service's
      // own coach handler, which retries the same conditional move to draft.
      this.logger.error(`revision ${payload.revision_id} could not be returned to draft either: ${(err as Error).message}`);
    }
    await this.publishReturned(payload, APPLY_FAILED_NOTE);
  }

  /**
   * Tell the educator (notification handles 'coach') that an approved update
   * did not go live and why. Published as a coach decision on the same QA
   * item, officer and content hash. This service's own coach handler receives
   * it too and ignores it: the revision is already 'draft', and the handler
   * only acts on a 'submitted' one.
   */
  private async publishReturned(payload: CourseRevisionReviewedPayload, notes: string): Promise<void> {
    await this.withRetry('publish CourseRevisionReviewed (returned to educator)', () =>
      this.bus.publish<CourseRevisionReviewedPayload>('CourseRevisionReviewed', {
        course_id: payload.course_id,
        revision_id: payload.revision_id,
        review_item_id: payload.review_item_id,
        action: 'coach',
        notes,
        qo_id: payload.qo_id,
        owner_user_id: payload.owner_user_id,
        owner_email: payload.owner_email,
        course_title: payload.course_title,
        content_hash: payload.content_hash,
      }),
    );
  }

  /** Coach: back to the educator with notes; the staged data stays for them to fix and resubmit. */
  async coach(payload: CourseRevisionReviewedPayload): Promise<void> {
    const stale = await this.withRetry(`coach revision ${payload.revision_id}`, () =>
      this.dataSource.transaction(async (m) => {
        const now = new Date();
        const revisionRepo = m.getRepository(CourseRevision);
        const res = await revisionRepo.update(this.decidable(payload), {
          status: 'draft',
          submitted_at: null,
          decided_at: now,
          decided_by: payload.qo_id,
          decision_notes: payload.notes ?? null,
        });
        if (!res.affected) return this.staleReason(revisionRepo, payload);
        await m
          .getRepository(Course)
          .update({ id: payload.course_id }, { last_review_action: 'coach', last_review_notes: payload.notes ?? null, last_reviewed_at: now });
        return null;
      }),
    );
    if (stale) this.logger.log(`revision ${payload.revision_id}: coach ignored — ${stale}`);
  }

  /** Reject: the staged data is discarded exactly like an owner discard; the live course is untouched. */
  async reject(payload: CourseRevisionReviewedPayload): Promise<void> {
    const result = await this.withRetry(`reject revision ${payload.revision_id}`, () =>
      this.dataSource.transaction(async (m) => {
        const now = new Date();
        const revisionRepo = m.getRepository(CourseRevision);
        const res = await revisionRepo.update(this.decidable(payload), {
          status: 'rejected',
          decided_at: now,
          decided_by: payload.qo_id,
          decision_notes: payload.notes ?? null,
        });
        if (!res.affected) return { stale: await this.staleReason(revisionRepo, payload) };
        const course = await this.lockCourse(m, payload.course_id);
        const revision = await revisionRepo.findOne({ where: { id: payload.revision_id } });
        if (!course || !revision) return { stale: 'the course no longer exists' };
        await discardStagedState(m, await loadStagedState(m, course));
        await m
          .getRepository(Course)
          .update({ id: course.id }, { last_review_action: 'reject', last_review_notes: payload.notes ?? null, last_reviewed_at: now });
        return { course, revision, closedAt: now };
      }),
    );
    if ('stale' in result) {
      this.logger.warn(`revision ${payload.revision_id}: reject ignored — ${result.stale}`);
      return;
    }
    const { course, revision, closedAt } = result;
    const owner = await this.courseService.ownerContact(course);
    // The reviewed assessments are rejected with the rest; a later one stays for the next revision.
    const assessmentIds = this.frozenAssessmentIds(revision);
    await this.withRetry('publish CourseRevisionClosed', () =>
      this.bus.publish<CourseRevisionClosedPayload>('CourseRevisionClosed', {
        ...this.closedBase(course, revision, owner.email || payload.owner_email, assessmentIds, closedAt),
        outcome: 'rejected',
        submitted_at: iso(revision.submitted_at),
        notes: payload.notes ?? null,
      }),
    );
  }

  /**
   * The row a QO decision may act on: this course's revision, still awaiting
   * the officer, and still the submission they reviewed. The revision id is
   * reused after a withdraw or coach, so the hash is what tells a decision on
   * an earlier submission apart from one on the current submission.
   */
  private decidable(payload: CourseRevisionReviewedPayload) {
    return { id: payload.revision_id, course_id: payload.course_id, status: 'submitted' as const, content_hash: payload.content_hash };
  }

  /** Why a decision matched no row, for the log. */
  private async staleReason(repo: Repository<CourseRevision>, payload: CourseRevisionReviewedPayload): Promise<string> {
    const current = await repo.findOne({ where: { id: payload.revision_id } });
    if (!current || current.course_id !== payload.course_id) return 'no such revision on this course';
    if (current.status !== 'submitted') return `the revision is '${current.status}', not awaiting a decision`;
    return `the decision is for an earlier submission (content ${short(payload.content_hash)}); the revision was resubmitted with content ${short(current.content_hash)}`;
  }

  // ---- Institution review of revisions (institution-owned courses) --------

  /** Queue rows for revisions waiting on this institution's admin. */
  async institutionQueueRows(institutionId: string) {
    const open = await this.revisions
      .createQueryBuilder('r')
      .innerJoin(Course, 'c', 'c.id = r.course_id')
      .where('r.status = :status', { status: 'institution_review' })
      .andWhere('c.institution_id = :institutionId', { institutionId })
      .orderBy('r.submitted_at', 'ASC')
      .getMany();
    if (!open.length) return [];
    const courses = await this.dataSource.getRepository(Course).find({ where: { id: In(open.map((r) => r.course_id)) } });
    const byId = new Map(courses.map((c) => [c.id, c]));
    const authors = await this.authorContacts(courses.map((c) => c.created_by));
    return open
      .filter((r) => byId.has(r.course_id))
      .map((r) => {
        const course = byId.get(r.course_id)!;
        return {
          ...this.courseService.publicSummary(course),
          status: course.status,
          created_by: course.created_by,
          instructor_name: authors.get(course.created_by)?.name || '(unknown instructor)',
          instructor_email: authors.get(course.created_by)?.email || '',
          kind: 'revision' as const,
          revision_id: r.id,
          changelog_summary: r.changelog_summary,
          major: r.changelog_major,
          submitted_at: r.submitted_at,
          diff_summary: (r.diff as unknown as RevisionDiffBody | null)?.diff_summary ?? null,
        };
      });
  }

  async hasOpenInstitutionRevision(courseId: string): Promise<boolean> {
    return (await this.revisions.count({ where: { course_id: courseId, status: 'institution_review' } })) > 0;
  }

  /** Institution admin approves (→ platform QO queue) or sends back (→ educator draft) a revision. */
  async institutionDecideRevision(ctx: UserContext, courseId: string, action: 'approve' | 'reject', notes?: string) {
    const course = await this.courseService.courseOrThrow(courseId);
    const institutionId = await this.courseService.myInstitutionId(ctx).catch(() => null);
    if (!institutionId || course.institution_id !== institutionId) throw new NotFoundException('Course not in your review queue');
    const revision = await this.revisions.findOne({ where: { course_id: courseId, status: 'institution_review' } });
    if (!revision) throw new NotFoundException('This course has no update waiting for institution review');

    const now = new Date();
    const next: CourseRevisionStatus = action === 'approve' ? 'submitted' : 'draft';
    const res = await this.revisions.update(
      { id: revision.id, status: 'institution_review' },
      action === 'approve'
        ? { status: next }
        : { status: next, submitted_at: null, decided_at: now, decided_by: ctx.id, decision_notes: notes ?? null },
    );
    if (!res.affected) throw new ConflictException('This update was withdrawn or decided a moment ago. Reload the queue.');

    if (action === 'approve') {
      const frozen = revision.diff as unknown as RevisionDiffBody | null;
      if (frozen && revision.content_hash) {
        await this.publishSubmitted(course, revision.id, frozen, revision.changelog_summary, revision.changelog_major, revision.content_hash);
      } else {
        this.logger.error(`revision ${revision.id} reached institution approval without a frozen diff or content hash; QO queue not notified`);
      }
    } else {
      await this.dataSource
        .getRepository(Course)
        .update({ id: course.id }, { last_review_action: 'institution_reject', last_review_notes: notes ?? null, last_reviewed_at: now });
    }
    await this.bus.publish<CourseInstitutionReviewedPayload>('CourseInstitutionReviewed', {
      course_id: course.id,
      course_title: course.title,
      owner_user_id: course.created_by,
      action,
      notes: notes ?? null,
      revision_id: revision.id,
    });
    return { revision_id: revision.id, status: next };
  }

  // ---- helpers -------------------------------------------------------------

  private async openRevision(courseId: string): Promise<CourseRevision | null> {
    return this.revisions.findOne({ where: { course_id: courseId, status: In(OPEN_REVISION_STATUSES) } });
  }

  private async createRevision(courseId: string, userId: string): Promise<CourseRevision> {
    try {
      return await this.revisions.save(this.revisions.create({ course_id: courseId, created_by: userId, status: 'draft' }));
    } catch (err) {
      // The partial unique index allows one open revision per course: a
      // concurrent edit may have just created it — use that one.
      const existing = await this.openRevision(courseId);
      if (existing) return existing;
      throw err;
    }
  }

  private async lockCourse(m: EntityManager, courseId: string): Promise<Course | null> {
    return m.getRepository(Course).findOne({ where: { id: courseId }, lock: { mode: 'pessimistic_write' } });
  }

  /**
   * Anything the educator could still discard: staged rows (possibly left
   * from a revision a flag or archive closed) or pending assessments.
   */
  private async hasStagedChanges(course: Course): Promise<boolean> {
    if (hasStagedState(await loadStagedState(this.dataSource.manager, course))) return true;
    const assessments = await this.fetchPendingAssessments(course.id);
    if (!assessments.ok) throw new ServiceUnavailableException('Could not check your pending assessments right now. Please try again in a minute.');
    return assessments.items.length > 0;
  }

  /** Ids of the pending assessments frozen into the revision at submit — the ones the reviewer decides on. */
  private frozenAssessmentIds(revision: CourseRevision): string[] {
    return pendingAssessmentIds((revision.diff as unknown as RevisionDiffBody | null)?.pending_assessments);
  }

  /** `diff` and `hash` are the ones frozen on the revision at submit. */
  private async publishSubmitted(course: Course, revisionId: string, diff: RevisionDiffBody, summary: string | null, major: boolean, hash: string) {
    const owner = await this.courseService.ownerContact(course);
    await this.bus.publish<CourseRevisionSubmittedPayload>('CourseRevisionSubmitted', {
      course_id: course.id,
      revision_id: revisionId,
      course_title: course.title,
      owner_id: course.owner_id,
      owner_type: course.owner_type,
      owner_user_id: course.created_by,
      owner_email: owner.email,
      owner_name: owner.name,
      diff_summary: diff.diff_summary,
      changed_text: changedText(diff),
      changelog_summary: summary,
      major,
      content_hash: hash,
      assessment_ids: pendingAssessmentIds(diff.pending_assessments),
    });
  }

  private closedBase(course: Course, revision: CourseRevision, ownerEmail: string, assessmentIds: string[], closedAt: Date) {
    return {
      course_id: course.id,
      revision_id: revision.id,
      added_lesson_ids: [] as string[],
      removed_lesson_ids: [] as string[],
      replaced_video_lesson_ids: [] as string[],
      changelog_summary: revision.changelog_summary,
      major: revision.changelog_major,
      owner_user_id: course.created_by,
      owner_email: ownerEmail,
      course_title: course.title,
      assessment_ids: assessmentIds,
      closed_at: closedAt.toISOString(),
    };
  }

  private revisionView(r: CourseRevision) {
    return {
      id: r.id,
      status: r.status,
      changelog_summary: r.changelog_summary,
      major: r.changelog_major,
      submitted_at: r.submitted_at,
      decision_notes: r.decision_notes,
    };
  }

  /** Pending assessments from the outcomes service. `ok: false` (logged) when it could not be asked — callers fail closed. */
  private async fetchPendingAssessments(courseId: string): Promise<{ ok: boolean; items: unknown[] }> {
    try {
      const rows = await this.internal.get<unknown[]>(`/api/v1/internal/courses/${courseId}/pending-assessments`);
      return { ok: true, items: Array.isArray(rows) ? rows : [] };
    } catch (err) {
      this.logger.warn(`pending assessments for course ${courseId} unavailable: ${(err as Error).message}`);
      return { ok: false, items: [] };
    }
  }

  private async resolveInstitution(userId: string) {
    try {
      return await this.internal.get<{ institution_id: string | null; institution_admin_user_id: string | null }>(
        `/api/v1/internal/users/${userId}/institution`,
      );
    } catch {
      return null;
    }
  }

  private async authorContacts(userIds: string[]) {
    const out = new Map<string, { name: string; email: string }>();
    await Promise.all(
      [...new Set(userIds)].map(async (id) => {
        try {
          out.set(id, await this.internal.get<{ name: string; email: string }>(`/api/v1/internal/users/${id}`));
        } catch {
          /* best-effort — the caller shows a placeholder */
        }
      }),
    );
    return out;
  }

  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) throw err;
        this.logger.warn(`${label} failed (attempt ${attempt + 1}): ${(err as Error).message} — retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
