import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, In, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import { aiFallbackNote, AiAssessor, CourseStructureOrigin, createAiAssessor, GeneratedSection, MockAiAssessor } from '@ethiopialearn/ai';
import {
  CourseCategory,
  CourseRatedPayload,
  CourseReviewedPayload,
  CourseReviewWithdrawnPayload,
  EnrollmentCreatedPayload,
  CourseStatus,
  OPEN_REVISION_STATUSES,
  OwnerType,
  PricingType,
  QaDecisionAction,
  Role,
} from '@ethiopialearn/contracts';
import { Course, CoursePending, CourseRevision, Lesson, LessonPending, PendingState, Section, SectionPending } from './entities';
import { CourseExtrasService } from './course-extras.service';
import { CreateCourseDto, LessonInputDto, SectionInputDto, UpdateCourseDto, UpdateLessonDto, UpdateSectionDto } from './dto';
import { VideoKeyService } from './video-key.service';
import { applyStagedRows, hasStagedRows } from './staging';

/** Approved courses: every content edit is staged into an open revision. */
export const LIVE_COURSE_STATUSES: CourseStatus[] = [CourseStatus.PUBLISHED, CourseStatus.UNLISTED];
const IN_REVIEW_STATUSES: CourseStatus[] = [CourseStatus.SUBMITTED, CourseStatus.UNDER_REVIEW, CourseStatus.INSTITUTION_REVIEW];
/** A QO flag only applies to a course in the QO queue or live; anything else is a stale decision. */
const FLAGGABLE_STATUSES: CourseStatus[] = [CourseStatus.SUBMITTED, CourseStatus.UNDER_REVIEW, CourseStatus.PUBLISHED, CourseStatus.UNLISTED];

const STATUS_CHANGED = 'This course changed state a moment ago. Reload the page and try again.';

/** Where a generated outline came from: the model, or the offline outline (document headings or generic placeholders). */
export type OutlineOrigin = CourseStructureOrigin;

/** What the educator is told when the outline did not come from the model. */
function offlineOutlineNote(origin: Exclude<OutlineOrigin, 'model'>, aiConfigured: boolean): string {
  // With a working key the model answered, just not usably: "offline" would
  // send the educator looking for a configuration problem that is not there.
  const lead = aiConfigured ? 'The AI reply could not be used' : 'AI is offline';
  return origin === 'headings'
    ? `${lead} — this is a starter outline built from your document's headings; edit it.`
    : `${lead} — this is a generic starter outline; edit it or paste your notes with headings.`;
}

/** Result of the content-write gate (see CourseService.assertEditable). */
export interface EditGate {
  course: Course;
  mode: 'direct' | 'staged';
  revision: CourseRevision | null;
  /** Leftover staged rows were folded into the draft: rows loaded before the gate are stale. */
  folded: boolean;
}

/** Learners see every row except those created inside a not-yet-approved revision ('removed' rows stay live until apply). */
export function isLiveRow(row: { pending_state?: PendingState | null }): boolean {
  return row.pending_state !== 'added';
}

// Working copy = live columns overlaid with the staged overrides. `pending`
// only ever holds keys that differ from live, so a plain spread is the merge.
export function mergedCourse(course: Course): Course {
  return course.pending ? { ...course, ...course.pending } : course;
}

export function mergedSection(section: Section) {
  return { title: section.title, is_free_preview: section.is_free_preview, ...section.pending };
}

export function mergedLesson(lesson: Lesson) {
  return {
    title: lesson.title,
    summary: lesson.summary,
    duration_seconds: lesson.duration_seconds,
    video_s3_key: lesson.video_s3_key,
    ...lesson.pending,
  };
}

/**
 * Overlay `changes` onto a row's staged overrides: a value equal to the live
 * one drops the key (the edit was undone), anything else is staged. Returns
 * null when nothing differs, so "no staged change" has a single representation.
 */
function stageFields<T extends object>(live: T, pending: Partial<T> | null, changes: Partial<T>): Partial<T> | null {
  const next: Partial<T> = { ...(pending ?? {}) };
  for (const key of Object.keys(changes) as (keyof T)[]) {
    const value = changes[key];
    if (value === undefined) continue;
    if (value === live[key]) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length ? next : null;
}

/** Only the keys the client actually sent — undefined means "leave unchanged". */
function definedFields<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Tiny in-process TTL cache for the hot public catalog reads. */
class TtlCache<T> {
  private readonly store = new Map<string, { expires: number; value: T }>();
  constructor(private readonly ttlMs: number, private readonly max = 500) {}
  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: T) {
    if (this.store.size >= this.max) this.store.clear();
    this.store.set(key, { expires: Date.now() + this.ttlMs, value });
  }
  clear() {
    this.store.clear();
  }
}

/**
 * Bayesian-weighted rating for catalog ranking: pulls each course's average
 * toward the global prior C=3.75 until it has m=3 ratings of its own.
 * score = (v/(v+m))·R + (m/(v+m))·C
 */
const BAYES_SCORE =
  '((c.rating_count::float / (c.rating_count + 3)) * COALESCE(c.rating_avg, 0)::float + (3.0 / (c.rating_count + 3)) * 3.75)';

@Injectable()
export class CourseService implements OnModuleInit {
  private readonly logger = new Logger(CourseService.name);
  private readonly ai: AiAssessor = createAiAssessor();
  // Catalog changes slowly relative to read volume; a short TTL shields Postgres
  // from repeated identical search queries under high concurrency.
  private readonly searchCache = new TtlCache<{ total: number; page: number; items: unknown[] }>(30_000);

  constructor(
    @InjectRepository(Course) private readonly courses: Repository<Course>,
    @InjectRepository(Section) private readonly sections: Repository<Section>,
    @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
    private readonly extras: CourseExtrasService,
    @InjectRepository(CourseRevision) private readonly revisions: Repository<CourseRevision>,
    private readonly videoKeys: VideoKeyService,
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit() {
    // QO decision on a first-time submission, appeal or post-publish item (spec §12.1).
    // Revisions never come through here — they use CourseRevisionReviewed.
    this.bus.subscribe<CourseReviewedPayload>('CourseReviewed', (payload) => this.onCourseReviewed(payload));

    // Rating aggregates from the quality service → catalog ranking columns.
    this.bus.subscribe<CourseRatedPayload>('CourseRated', async (payload) => {
      await this.courses.update(
        { id: payload.course_id },
        {
          rating_avg: payload.average_rating.toFixed(2),
          rating_count: payload.rating_count,
          rating_points: payload.total_points,
        },
      );
      this.searchCache.clear(); // ranking order may have changed
      this.logger.log(`course ${payload.course_id} rated ${payload.average_rating} (${payload.rating_count} reviews)`);
    });

    // Enrollment counter → popularity signal for catalog sorting.
    this.bus.subscribe<EnrollmentCreatedPayload>('EnrollmentCreated', async (payload) => {
      await this.courses.increment({ id: payload.course_id }, 'enrolled_count', 1);
      this.searchCache.clear();
    });
  }

  /**
   * The event bus acks even when a handler fails and a decision can arrive
   * late (the educator withdrew, or the item was a post-publish check on a live
   * course), so every transition is guarded by the course's CURRENT status —
   * checked here and again in the UPDATE itself, so a withdraw that lands
   * between the read and the write is never reverted.
   */
  private async onCourseReviewed(payload: CourseReviewedPayload) {
    const course = await this.courses.findOne({ where: { id: payload.course_id } });
    if (!course) return;
    const inReview = course.status === CourseStatus.SUBMITTED || course.status === CourseStatus.UNDER_REVIEW;
    const live = LIVE_COURSE_STATUSES.includes(course.status);
    // Persist the quality officer's decision + notes so the educator sees the
    // feedback on the course page itself, not only in a notification.
    const feedback = { last_review_action: payload.action, last_review_notes: payload.notes ?? null, last_reviewed_at: new Date() };
    const stale = (why: string) => this.logger.warn(`ignoring stale QO ${payload.action} for course ${course.id} (${why})`);

    if (payload.action === QaDecisionAction.APPROVE) {
      if (inReview || course.status === CourseStatus.FLAGGED) {
        // An appeal re-approves a course that was live before: it keeps its
        // original publish date and must not re-announce itself to followers.
        const firstPublish = !course.published_at;
        const publishedAt = firstPublish ? new Date() : course.published_at;
        const moved = await this.transition(course.id, [course.status], {
          ...feedback,
          status: CourseStatus.PUBLISHED,
          ...(firstPublish ? { published_at: publishedAt } : {}),
        });
        if (!moved) return stale(`status changed from ${course.status} while deciding`);
        Object.assign(course, feedback, { status: CourseStatus.PUBLISHED, published_at: publishedAt });
        this.searchCache.clear(); // the course is now visible in the catalog
        // Tutor corpus: description + lesson outline become searchable on publish.
        this.extras.reindexCourse(course.id).catch((err) => this.logger.warn(`tutor reindex failed: ${(err as Error).message}`));
        if (firstPublish) {
          await this.bus.publish('CoursePublished', {
            course_id: course.id,
            title: course.title,
            category: course.category,
            owner_id: course.owner_id,
            owner_type: course.owner_type,
            owner_user_id: course.created_by,
            owner_email: payload.owner_email,
            pricing_type: course.pricing_type,
            price_etb: course.price_etb ? Number(course.price_etb) : null,
          });
        }
      } else if (live) {
        // A post-publish check was cleared: nothing about the course changes.
        if (!(await this.transition(course.id, LIVE_COURSE_STATUSES, feedback))) return stale('no longer live');
      } else {
        return stale(`status ${course.status}`);
      }
    } else if (payload.action === QaDecisionAction.COACH) {
      if (inReview) {
        // An appeal that is coached back to draft may still carry staged work
        // from when the course was live; it becomes part of the draft.
        if (!(await this.moveToDraft(course.id, [CourseStatus.SUBMITTED, CourseStatus.UNDER_REVIEW], feedback))) {
          return stale(`status changed from ${course.status} while deciding`);
        }
        course.status = CourseStatus.DRAFT;
      } else if (live) {
        // Coaching on a live course is advice only: demoting it would cut off
        // every enrolled learner.
        if (!(await this.transition(course.id, LIVE_COURSE_STATUSES, feedback))) return stale('no longer live');
      } else {
        return stale(`status ${course.status}`);
      }
    } else if (payload.action === QaDecisionAction.FLAG) {
      // A flag decided on an item the educator already withdrew (a DRAFT
      // course) or on an archived/flagged course must not lock the course.
      if (!FLAGGABLE_STATUSES.includes(course.status)) return stale(`status ${course.status}`);
      if (!(await this.transition(course.id, FLAGGABLE_STATUSES, { ...feedback, status: CourseStatus.FLAGGED }))) {
        return stale(`status changed from ${course.status} while deciding`);
      }
      course.status = CourseStatus.FLAGGED;
      this.searchCache.clear();
      await this.closeOpenRevision(course.id);
    } else {
      return;
    }
    this.logger.log(`course ${course.id} -> ${course.status} (QO ${payload.action})`);
  }

  /**
   * Status change as ONE targeted UPDATE, guarded by the status the caller
   * checked. A whole-entity save() would write back every column of a
   * possibly stale entity — e.g. the old title/price and `pending` a revision
   * apply replaced meanwhile — and could undo a concurrent withdraw.
   * Returns false when the course is no longer in one of `from`.
   */
  private async transition(courseId: string, from: CourseStatus[], patch: QueryDeepPartialEntity<Course>, m?: EntityManager): Promise<boolean> {
    const repo = m ? m.getRepository(Course) : this.courses;
    const res = await repo.update({ id: courseId, status: In(from) }, patch);
    return !!res.affected;
  }

  /**
   * Back to DRAFT (withdraw, restore, coach, institution send-back) in one
   * transaction with folding any staged work left from when the course was
   * live: a draft has no learners to protect, so that work simply becomes
   * the draft and the editor never shows stale staged values over the draft.
   */
  private async moveToDraft(courseId: string, from: CourseStatus[], patch: QueryDeepPartialEntity<Course> = {}): Promise<boolean> {
    return this.dataSource.transaction(async (m) => {
      // The UPDATE row-locks the course, so no revision apply can interleave with the fold.
      if (!(await this.transition(courseId, from, { ...patch, status: CourseStatus.DRAFT }, m))) return false;
      await this.foldStaged(m, courseId);
      return true;
    });
  }

  /** Staged rows → live rows on a course that is not live. Caller holds the course row lock. */
  private async foldStaged(m: EntityManager, courseId: string): Promise<boolean> {
    if (!(await hasStagedRows(m, courseId))) return false;
    const ids = await applyStagedRows(m, courseId);
    this.logger.log(
      `course ${courseId}: staged changes folded into the draft (${ids.addedLessonIds.length} lesson(s) added, ${ids.removedLessonIds.length} removed)`,
    );
    return true;
  }

  /**
   * Safety net for the direct-mode gate: a DRAFT course that still has staged
   * rows (e.g. from before this fold existed) gets them folded before the
   * edit, otherwise the edit writes live columns the editor keeps hiding
   * behind the stale overrides. Returns the refreshed course, or null when
   * there was nothing to fold.
   */
  private async foldLeftoverStaging(course: Course): Promise<Course | null> {
    // Checked outside a transaction first: nearly every draft has nothing staged.
    if (!(await hasStagedRows(this.dataSource.manager, course.id))) return null;
    const fresh = await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Course);
      const locked = await repo.findOne({ where: { id: course.id }, lock: { mode: 'pessimistic_write' } });
      if (locked?.status === CourseStatus.DRAFT) await this.foldStaged(m, course.id);
      return repo.findOne({ where: { id: course.id } });
    });
    // Even if a concurrent edit did the fold, the rows changed under the caller.
    return fresh ?? course;
  }

  async create(ctx: UserContext, dto: CreateCourseDto) {
    // Institutions do not author courses directly — their instructors do.
    if (ctx.role === Role.INSTITUTION_ADMIN) {
      throw new ForbiddenException('Institutions do not create courses directly. Invite instructors to create courses.');
    }
    if (dto.pricing_type === PricingType.PAID && !dto.price_etb) {
      throw new BadRequestException('price_etb is required for paid courses');
    }
    // Check every lesson video before anything is written, so a bad key cannot
    // leave a half-created course behind.
    if (dto.sections) await this.assertSectionVideoKeys({ created_by: ctx.id, owner_id: ctx.id }, dto.sections);
    const institution = await this.resolveInstitution(ctx.id);
    const course = await this.courses.save(
      this.courses.create({
        owner_id: ctx.id,
        owner_type: OwnerType.EDUCATOR,
        created_by: ctx.id,
        institution_id: institution?.institution_id ?? null,
        title: dto.title,
        description: dto.description,
        category: dto.category,
        language: dto.language,
        thumbnail_url: dto.thumbnail_url ?? null,
        pricing_type: dto.pricing_type,
        price_etb: dto.price_etb != null ? dto.price_etb.toFixed(2) : null,
        status: CourseStatus.DRAFT,
      }),
    );
    const sectionsIn = dto.sections ?? [];
    if (sectionsIn.length) {
      await this.dataSource.transaction(async (m) => {
        for (let i = 0; i < sectionsIn.length; i++) await this.insertSection(m, course.id, sectionsIn[i], i, false);
      });
    }
    return this.workingView(course);
  }

  // ---- Editing: direct on drafts, staged on approved courses ----

  /**
   * Gate for every content write. Drafts are edited in place. Approved
   * (published/unlisted) courses are edited through a staged revision so
   * learners keep the reviewed version until a QO approves the change set.
   * Courses in review are locked so the reviewer never approves a moving target.
   */
  async assertEditable(ctx: UserContext, courseId: string): Promise<EditGate> {
    const course = await this.ownedCourse(ctx, courseId);
    return this.editGate(course, ctx.id);
  }

  /**
   * The status half of assertEditable, for callers that authorize on their
   * own. `openRevision: false` checks that the change set is not with a
   * reviewer without opening an (empty) draft revision.
   */
  private async editGate(course: Course, userId: string, opts: { openRevision: boolean } = { openRevision: true }): Promise<EditGate> {
    if (course.status === CourseStatus.DRAFT) {
      const fresh = await this.foldLeftoverStaging(course);
      return { course: fresh ?? course, mode: 'direct', revision: null, folded: !!fresh };
    }
    if (IN_REVIEW_STATUSES.includes(course.status)) {
      throw new ConflictException('This course is in review. Withdraw it to make changes.');
    }
    if (LIVE_COURSE_STATUSES.includes(course.status)) {
      const revision = opts.openRevision ? await this.draftRevisionFor(course, userId) : await this.editableOpenRevision(course.id);
      return { course, mode: 'staged', revision, folded: false };
    }
    throw new BadRequestException(
      course.status === CourseStatus.ARCHIVED
        ? 'This course is archived. Restore it before making changes.'
        : 'This course is flagged and cannot be edited. Appeal the decision from the course page first.',
    );
  }

  /** assertEditable for a lesson's course (upload endpoints check before any bytes move). */
  async assertLessonEditable(ctx: UserContext, lessonId: string): Promise<{ lesson: Lesson; section: Section; course: Course }> {
    // Via editableLesson so a lesson the draft fold removed is a 404 here, before any bytes move.
    const { lesson, section, course } = await this.editableLesson(ctx, lessonId);
    return { lesson, section, course };
  }

  private openRevision(courseId: string): Promise<CourseRevision | null> {
    return this.revisions.findOne({ where: { course_id: courseId, status: In(OPEN_REVISION_STATUSES) } });
  }

  /** The open revision, if any, as long as it is not with a reviewer (409 then: the reviewer must never approve a moving target). */
  private async editableOpenRevision(courseId: string): Promise<CourseRevision | null> {
    const open = await this.openRevision(courseId);
    if (open && open.status !== 'draft') throw new ConflictException('Your changes are in review — withdraw them to keep editing.');
    return open;
  }

  /** The draft revision a staged edit belongs to — created by the first edit after approval. */
  private async draftRevisionFor(course: Course, userId: string): Promise<CourseRevision> {
    const open = await this.editableOpenRevision(course.id);
    if (open) return open;
    try {
      return await this.revisions.save(this.revisions.create({ course_id: course.id, status: 'draft', created_by: userId }));
    } catch (err) {
      // Two first edits raced; the partial unique index lets only one insert win.
      const winner = await this.openRevision(course.id);
      if (winner?.status === 'draft') return winner;
      throw err;
    }
  }

  async update(ctx: UserContext, courseId: string, dto: UpdateCourseDto) {
    const { course, mode } = await this.assertEditable(ctx, courseId);
    const changes: CoursePending = definedFields({
      title: dto.title,
      description: dto.description,
      category: dto.category,
      thumbnail_url: dto.thumbnail_url,
      pricing_type: dto.pricing_type,
      price_etb: dto.price_etb === undefined ? undefined : dto.price_etb != null ? dto.price_etb.toFixed(2) : null,
    });
    // Targeted UPDATEs guarded by the mode's status: only the columns this edit
    // owns are written, and a course that moved on (submitted, flagged) since
    // the gate is not edited behind the reviewer's back.
    if (mode === 'direct') {
      if (Object.keys(changes).length && !(await this.transition(course.id, [CourseStatus.DRAFT], changes as QueryDeepPartialEntity<Course>))) {
        throw new ConflictException(STATUS_CHANGED);
      }
      Object.assign(course, changes);
    } else {
      const pending = stageFields<CoursePending>(course, course.pending, changes);
      // The live price is what checkout charges, so a staged pricing change must
      // already be coherent on its own when the reviewer sees it.
      if (changes.pricing_type !== undefined || changes.price_etb !== undefined) this.assertPricing({ ...course, ...pending });
      if (!(await this.transition(course.id, LIVE_COURSE_STATUSES, { pending: pending as QueryDeepPartialEntity<CoursePending> | null }))) {
        throw new ConflictException(STATUS_CHANGED);
      }
      course.pending = pending;
    }
    return this.workingView(course);
  }

  private assertPricing(c: { pricing_type: PricingType; price_etb: string | null }) {
    if ((c.pricing_type === PricingType.PAID || c.pricing_type === PricingType.FREEMIUM) && !c.price_etb) {
      throw new BadRequestException(`Set a price (price_etb) for a ${c.pricing_type} course.`);
    }
  }

  async addSection(ctx: UserContext, courseId: string, dto: SectionInputDto): Promise<Section> {
    const { course, mode } = await this.assertEditable(ctx, courseId);
    const count = await this.sections.count({ where: { course_id: courseId } });
    return this.addSectionInternal(course, dto, count, mode === 'staged');
  }

  /** Section title / free-preview flag. On a live section the change is staged. */
  async updateSection(ctx: UserContext, sectionId: string, dto: UpdateSectionDto): Promise<Section> {
    const { section, mode } = await this.editableSection(ctx, sectionId);
    const changes: SectionPending = definedFields({ title: dto.title, is_free_preview: dto.is_free_preview });
    if (mode === 'direct' || !isLiveRow(section)) Object.assign(section, changes);
    // A free-preview flip on a live section would open paid content to everyone,
    // so it waits for review like any other change.
    else section.pending = stageFields<SectionPending>(section, section.pending, changes);
    return this.sections.save(section);
  }

  /**
   * Apply an AI-generated outline in ONE call and ONE transaction: every
   * section + lesson (with its summary) lands together or not at all, instead
   * of N client round-trips that can fail halfway and leave a partial outline.
   */
  async applyStructure(ctx: UserContext, courseId: string, sectionsIn: SectionInputDto[]) {
    if (!sectionsIn?.length) throw new BadRequestException('The outline has no sections — add at least one section before applying it.');
    const { course, mode } = await this.assertEditable(ctx, courseId);
    await this.assertSectionVideoKeys(course, sectionsIn);
    await this.dataSource.transaction(async (m) => {
      const offset = await m.getRepository(Section).count({ where: { course_id: courseId } });
      for (let i = 0; i < sectionsIn.length; i++) {
        await this.insertSection(m, courseId, sectionsIn[i], offset + i, mode === 'staged');
      }
    });
    return {
      applied: true,
      sections_added: sectionsIn.length,
      lessons_added: sectionsIn.reduce((n, s) => n + (s.lessons?.length ?? 0), 0),
    };
  }

  /**
   * AI-assisted outline: turn a prompt / pasted document into a draft of
   * sections + lessons. NOT saved — the educator reviews & edits it, then the
   * frontend applies it with POST /courses/:id/apply-structure.
   */
  async generateStructure(
    ctx: UserContext,
    dto: { title: string; source_text?: string; prompt?: string; section_count?: number; lessons_per_section?: number; level?: string; learning_style?: string },
  ): Promise<{ sections: GeneratedSection[]; ai_live: boolean; origin: OutlineOrigin; note?: string }> {
    const input = {
      title: dto.title,
      source_text: dto.source_text,
      prompt: dto.prompt,
      section_count: dto.section_count ?? 4,
      lessons_per_section: dto.lessons_per_section ?? 3,
      level: dto.level,
      learning_style: dto.learning_style,
    };
    // The AI call can fail (upstream outage, rate limit, malformed model reply).
    // Never surface that as a 500 to the educator — fall back to an offline
    // starter outline they can edit, and say how it was built: an outline
    // from their headings and a generic placeholder need different next steps.
    let aiError: unknown;
    try {
      const result = await this.ai.generateCourseStructure(input);
      if (result.sections?.length) {
        // An assessor that does not report origin is taken at its word for the
        // live model, and as the generic outline otherwise (never claim the
        // document was read when it may not have been).
        const origin: OutlineOrigin = result.origin ?? (this.ai.isLive ? 'model' : 'placeholder');
        if (origin === 'model') return { sections: result.sections, ai_live: this.ai.isLive, origin };
        // A live key whose reply was replaced by the offline outline is not an AI outline.
        return { sections: result.sections, ai_live: false, origin, note: offlineOutlineNote(origin, this.ai.isLive) };
      }
      this.logger.warn('AI returned an empty outline — using offline draft');
    } catch (err) {
      aiError = err;
      this.logger.error(`AI outline generation failed: ${(err as Error).message}`);
    }
    const fallback = await new MockAiAssessor().generateCourseStructure(input);
    // The offline outline never comes from the model, whatever it reports.
    const origin = fallback.origin === 'headings' ? 'headings' : 'placeholder';
    return {
      sections: fallback.sections,
      ai_live: false,
      origin,
      // A failed call on a configured key keeps the actionable reason (bad key, quota, outage).
      note: aiError ? aiFallbackNote(aiError, 'outline') : offlineOutlineNote(origin, this.ai.isLive),
    };
  }

  /**
   * A section plus the edit gate for its course. Folding leftover staged rows
   * rewrites them, so the section is re-read then (and a section the fold
   * removed is gone): editing the stale entity would write the old values back.
   */
  private async editableSection(ctx: UserContext, sectionId: string): Promise<{ section: Section; course: Course; mode: 'direct' | 'staged' }> {
    const found = await this.sections.findOne({ where: { id: sectionId } });
    if (!found) throw new NotFoundException('Section not found');
    const { course, mode, folded } = await this.assertEditable(ctx, found.course_id);
    const section = folded ? await this.sections.findOne({ where: { id: sectionId } }) : found;
    if (!section) throw new NotFoundException('Section not found — it was removed in your earlier changes. Reload the page.');
    return { section, course, mode };
  }

  /** editableSection for a lesson (with its section and course). */
  private async editableLesson(ctx: UserContext, lessonId: string): Promise<{ lesson: Lesson; section: Section; course: Course; mode: 'direct' | 'staged' }> {
    const found = await this.lessonWithCourse(lessonId);
    const { mode, folded } = await this.assertEditable(ctx, found.course.id);
    if (!folded) return { ...found, mode };
    const fresh = await this.lessonWithCourse(lessonId).catch((err: unknown) => {
      if (err instanceof NotFoundException) throw new NotFoundException('Lesson not found — it was removed in your earlier changes. Reload the page.');
      throw err;
    });
    return { ...fresh, mode };
  }

  async updateLesson(ctx: UserContext, lessonId: string, dto: UpdateLessonDto) {
    const { lesson, section, course, mode } = await this.editableLesson(ctx, lessonId);
    await this.videoKeys.assertOwnVideoKey(course, dto.video_s3_key, [lesson.video_s3_key, lesson.pending?.video_s3_key]);
    const changes: LessonPending = definedFields({
      title: dto.title,
      summary: dto.summary,
      duration_seconds: dto.duration_seconds,
      // '' clears the video like null does; store one representation.
      video_s3_key: dto.video_s3_key === undefined ? undefined : dto.video_s3_key || null,
    });
    // Rows created inside the open revision are not live yet: edit them in place.
    if (mode === 'direct' || !isLiveRow(lesson) || !isLiveRow(section)) Object.assign(lesson, changes);
    else lesson.pending = stageFields<LessonPending>(lesson, lesson.pending, changes);
    return this.lessons.save(lesson);
  }

  async deleteLesson(ctx: UserContext, lessonId: string) {
    const { lesson, section, mode } = await this.editableLesson(ctx, lessonId);
    if (mode === 'direct' || !isLiveRow(lesson) || !isLiveRow(section)) {
      await this.lessons.remove(lesson);
      return { deleted: true, staged: false };
    }
    // Learners keep the lesson (and their progress on it) until the removal is approved.
    lesson.pending_state = 'removed';
    await this.lessons.save(lesson);
    return { deleted: true, staged: true };
  }

  async deleteSection(ctx: UserContext, sectionId: string) {
    const { section, mode } = await this.editableSection(ctx, sectionId);
    const staged = mode === 'staged' && isLiveRow(section);
    await this.dataSource.transaction(async (m) => {
      const lessons = m.getRepository(Lesson);
      if (!staged) {
        await lessons.delete({ section_id: sectionId });
        await m.getRepository(Section).remove(section);
        return;
      }
      // Lessons added in this revision were never live: drop them outright.
      await lessons.delete({ section_id: sectionId, pending_state: 'added' });
      await lessons.update({ section_id: sectionId }, { pending_state: 'removed' });
      section.pending_state = 'removed';
      await m.getRepository(Section).save(section);
    });
    return { deleted: true, staged };
  }

  async addLesson(ctx: UserContext, sectionId: string, dto: LessonInputDto) {
    const { section, course, mode } = await this.editableSection(ctx, sectionId);
    if (mode === 'staged' && section.pending_state === 'removed') {
      throw new BadRequestException('This section is being removed in your pending changes — add the lesson to another section.');
    }
    await this.videoKeys.assertOwnVideoKey(course, dto.video_s3_key, []);
    const count = await this.lessons.count({ where: { section_id: sectionId } });
    return this.lessons.save(
      this.lessons.create({
        section_id: sectionId,
        title: dto.title,
        summary: dto.summary ?? null,
        video_s3_key: dto.video_s3_key || null,
        duration_seconds: dto.duration_seconds ?? 0,
        order_index: count,
        pending_state: mode === 'staged' ? 'added' : null,
      }),
    );
  }

  /**
   * Tutor notes follow the same gate as every content write (409 in review,
   * 400 flagged/archived). On an approved course they join the open revision
   * (state 'pending') so the tutor never answers learners from unreviewed
   * material; on a draft they are live at once.
   */
  async addKnowledge(ctx: UserContext, courseId: string, title: string, text: string) {
    const { course, mode } = await this.knowledgeGate(ctx, courseId, true);
    return this.extras.addKnowledge(course, title, text, mode === 'staged' ? 'pending' : 'live');
  }

  /**
   * Remove a tutor note by title, behind the same gate as addKnowledge. On an
   * approved course a title can exist twice (the live note and a pending
   * re-upload); only one of them is ever removed — see CourseExtrasService.deleteKnowledge.
   * No draft revision is opened: removing a live note needs no review.
   */
  async deleteKnowledge(ctx: UserContext, courseId: string, title: string, state?: 'live' | 'pending') {
    const { mode } = await this.knowledgeGate(ctx, courseId, false);
    return this.extras.deleteKnowledge(courseId, title, mode === 'staged', state);
  }

  /** Institution admins manage their instructors' tutor notes, so this authorizes with canAuthor rather than ownedCourse. */
  private async knowledgeGate(ctx: UserContext, courseId: string, openRevision: boolean): Promise<EditGate> {
    const course = await this.courseOrThrow(courseId);
    if (!(await this.canAuthor(ctx, course))) throw new ForbiddenException('Not your course');
    return this.editGate(course, ctx.id, { openRevision });
  }

  /** The first rule of §7.2 a course fails before it can be submitted, or null. */
  private async submitBlocker(m: EntityManager, course: Course): Promise<string | null> {
    const sections = await m.getRepository(Section).find({ where: { course_id: course.id } });
    if (sections.length === 0) return 'Add at least one section before submitting';
    const lessonCount = await m.getRepository(Lesson).count({ where: { section_id: In(sections.map((s) => s.id)) } });
    if (lessonCount === 0) return 'Add at least one lesson before submitting';
    if (!course.thumbnail_url) return 'Thumbnail is required before submitting';
    if (course.pricing_type === PricingType.PAID && !course.price_etb) return 'price_etb is required for paid courses';
    if (course.pricing_type === PricingType.FREEMIUM && !sections.some((s) => s.is_free_preview)) {
      return 'Freemium courses need at least one free-preview section';
    }
    return null;
  }

  /** draft → submitted; validates the §7.2 required fields. */
  async submit(ctx: UserContext, courseId: string): Promise<Course> {
    const owned = await this.ownedCourse(ctx, courseId);
    if (owned.status !== CourseStatus.DRAFT) {
      throw new BadRequestException(`Only draft courses can be submitted (current: ${owned.status})`);
    }
    // Institution-owned courses go through internal institution review FIRST;
    // solo educators go straight to the platform QO queue.
    const next = owned.institution_id ? CourseStatus.INSTITUTION_REVIEW : CourseStatus.SUBMITTED;
    const outcome = await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Course);
      const locked = await repo.findOne({ where: { id: courseId }, lock: { mode: 'pessimistic_write' } });
      if (locked?.status !== CourseStatus.DRAFT) return { error: new ConflictException(STATUS_CHANGED) };
      // Staged work left from when the course was live becomes part of the
      // draft first, so the reviewer sees (and learners later get) exactly
      // what the educator sees in the editor. The fold is kept even when a
      // rule below fails: the course is not live, so it is the draft either way.
      const course = (await this.foldStaged(m, courseId)) ? ((await repo.findOne({ where: { id: courseId } })) ?? locked) : locked;
      const blocker = await this.submitBlocker(m, course);
      if (blocker) return { error: new BadRequestException(blocker) };
      await repo.update({ id: courseId }, { status: next });
      course.status = next;
      return { course };
    });
    if ('error' in outcome) throw outcome.error;
    const { course } = outcome;

    if (next === CourseStatus.INSTITUTION_REVIEW) {
      const inst = await this.resolveInstitution(course.created_by);
      const owner = await this.ownerContact(course);
      if (inst?.institution_admin_user_id) {
        await this.bus.publish('CourseSubmittedToInstitution', {
          course_id: course.id,
          course_title: course.title,
          institution_admin_user_id: inst.institution_admin_user_id,
          instructor_name: owner.name,
          revision_id: null,
        });
      }
      return course;
    }

    const owner = await this.ownerContact(course);
    await this.bus.publish('CourseSubmitted', {
      course_id: course.id,
      title: course.title,
      description: course.description,
      owner_id: course.owner_id,
      owner_type: course.owner_type,
      owner_user_id: course.created_by,
      owner_email: owner.email,
      owner_name: owner.name,
      pricing_type: course.pricing_type,
    });
    return course;
  }

  // ---- Institution internal review workflow ----

  private async resolveInstitution(userId: string) {
    try {
      return await this.internal.get<{ institution_id: string | null; institution_admin_user_id: string | null; institution_name: string | null }>(
        `/api/v1/internal/users/${userId}/institution`,
      );
    } catch {
      return null;
    }
  }

  async myInstitutionId(ctx: UserContext): Promise<string> {
    const inst = await this.internal.get<{ id: string }>(`/api/v1/internal/institutions/by-owner/${ctx.id}`);
    return inst.id;
  }

  /** A course of the calling institution admin's institution, else 404 (never reveal other institutions' courses). */
  async institutionCourseOrThrow(ctx: UserContext, courseId: string): Promise<Course> {
    const institutionId = await this.myInstitutionId(ctx);
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course || course.institution_id !== institutionId) throw new NotFoundException('Course not found in your institution');
    return course;
  }

  /** First-time submissions awaiting the institution's internal review (revisions are merged in by the controller). */
  async institutionReviewQueue(institutionId: string) {
    const items = await this.courses.find({ where: { institution_id: institutionId, status: CourseStatus.INSTITUTION_REVIEW }, order: { created_at: 'ASC' } });
    return (await this.withInstructorNames(items)).map((row) => ({ ...row, kind: 'new_course' as const, revision_id: null }));
  }

  /** All courses belonging to the institution (any status). */
  async institutionCourses(ctx: UserContext) {
    const institutionId = await this.myInstitutionId(ctx);
    const items = await this.courses.find({ where: { institution_id: institutionId }, order: { created_at: 'DESC' } });
    return this.withInstructorNames(items);
  }

  /** Attach the authoring instructor's name/email so the institution admin can
   *  see who created each course when approving or sending it back. */
  private async withInstructorNames(items: Course[]) {
    const ids = [...new Set(items.map((c) => c.created_by))];
    const authors = new Map<string, { name: string; email: string }>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          authors.set(id, await this.internal.get<{ name: string; email: string }>(`/api/v1/internal/users/${id}`));
        } catch {
          /* best-effort — fall back to placeholders below */
        }
      }),
    );
    return items.map((c) => ({
      ...this.publicSummary(c),
      status: c.status,
      created_by: c.created_by,
      instructor_name: authors.get(c.created_by)?.name || '(unknown instructor)',
      instructor_email: authors.get(c.created_by)?.email || '',
    }));
  }

  /** Institution approves (→ platform QO) or rejects (→ instructor draft) a first-time submission. */
  async institutionDecide(ctx: UserContext, courseId: string, action: 'approve' | 'reject', notes?: string) {
    const course = await this.institutionCourseOrThrow(ctx, courseId);
    if (course.status !== CourseStatus.INSTITUTION_REVIEW) throw new NotFoundException('Nothing from this course is awaiting institution review');
    const owner = await this.ownerContact(course);

    if (action === 'approve') {
      // Guarded by INSTITUTION_REVIEW: the instructor may have withdrawn while the owner lookup ran.
      if (!(await this.transition(course.id, [CourseStatus.INSTITUTION_REVIEW], { status: CourseStatus.SUBMITTED }))) {
        throw new ConflictException('The instructor withdrew this course a moment ago. Reload the queue.');
      }
      course.status = CourseStatus.SUBMITTED;
      await this.bus.publish('CourseSubmitted', {
        course_id: course.id,
        title: course.title,
        description: course.description,
        owner_id: course.owner_id,
        owner_type: course.owner_type,
        owner_user_id: course.created_by,
        owner_email: owner.email,
        owner_name: owner.name,
        pricing_type: course.pricing_type,
      });
    } else {
      const feedback = { last_review_action: 'institution_reject', last_review_notes: notes ?? null, last_reviewed_at: new Date() };
      if (!(await this.moveToDraft(course.id, [CourseStatus.INSTITUTION_REVIEW], feedback))) {
        throw new ConflictException('The instructor withdrew this course a moment ago. Reload the queue.');
      }
      Object.assign(course, feedback, { status: CourseStatus.DRAFT });
    }
    await this.bus.publish('CourseInstitutionReviewed', {
      course_id: course.id,
      course_title: course.title,
      owner_user_id: course.created_by,
      action,
      notes: notes ?? null,
      revision_id: null,
    });
    return course;
  }

  /** Institution unlists / restores one of its own published/unlisted courses. */
  async institutionTransition(ctx: UserContext, courseId: string, action: 'unlist' | 'restore') {
    const course = await this.institutionCourseOrThrow(ctx, courseId);
    const [from, to] = action === 'unlist' ? [CourseStatus.PUBLISHED, CourseStatus.UNLISTED] : [CourseStatus.UNLISTED, CourseStatus.PUBLISHED];
    if (course.status !== from) {
      throw new BadRequestException(action === 'unlist' ? 'Only a published course can be unlisted' : 'Only an unlisted course can be restored');
    }
    if (!(await this.transition(course.id, [from], { status: to }))) throw new ConflictException(STATUS_CHANGED);
    course.status = to;
    this.searchCache.clear(); // catalog visibility changed
    return course;
  }

  /**
   * Duplicate a course as a fresh draft. Copies the educator's working copy
   * (live + staged edits) because that is what they see on the authoring page;
   * rows staged for removal are left out and no pending markers carry over.
   */
  async duplicate(ctx: UserContext, courseId: string): Promise<Course> {
    const source = mergedCourse(await this.ownedCourse(ctx, courseId));
    const tree = await this.loadTree(source.id);
    return this.dataSource.transaction(async (m) => {
      const courses = m.getRepository(Course);
      const sections = m.getRepository(Section);
      const lessons = m.getRepository(Lesson);
      const copy = await courses.save(
        courses.create({
          owner_id: source.owner_id,
          owner_type: source.owner_type,
          created_by: source.created_by,
          institution_id: source.institution_id,
          title: `${source.title} (copy)`.slice(0, 120),
          description: source.description,
          category: source.category,
          language: source.language,
          thumbnail_url: source.thumbnail_url,
          pricing_type: source.pricing_type,
          price_etb: source.price_etb,
          status: CourseStatus.DRAFT,
        }),
      );
      for (const { section, lessons: sectionLessons } of tree) {
        if (section.pending_state === 'removed') continue;
        const ns = await sections.save(sections.create({ course_id: copy.id, ...mergedSection(section), order_index: section.order_index }));
        const rows = sectionLessons
          .filter((l) => l.pending_state !== 'removed')
          .map((l) => lessons.create({ section_id: ns.id, ...mergedLesson(l), order_index: l.order_index }));
        if (rows.length) await lessons.save(rows);
      }
      return copy;
    });
  }

  /** Educator archives their own course (reversible via restore). */
  async archiveOwn(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status === CourseStatus.ARCHIVED) return course;
    const previous = course.status;
    if (!(await this.transition(course.id, [previous], { status: CourseStatus.ARCHIVED }))) throw new ConflictException(STATUS_CHANGED);
    course.status = CourseStatus.ARCHIVED;
    this.searchCache.clear();
    await this.closeReviewsOnArchive(course.id, previous);
    return course;
  }

  /**
   * Archiving takes the course out of every review: an open revision is
   * closed, and a first-time submission (or appeal) in the QA queue is
   * withdrawn too — otherwise its item stays decidable, and a later flag or
   * approval would act on an archived course.
   */
  private async closeReviewsOnArchive(courseId: string, previous: CourseStatus) {
    await this.closeOpenRevision(courseId);
    if (IN_REVIEW_STATUSES.includes(previous)) {
      await this.bus.publish<CourseReviewWithdrawnPayload>('CourseReviewWithdrawn', { course_id: courseId, revision_id: null });
    }
  }

  /** Archived → draft. Staged work left from when the course was live becomes the draft (see moveToDraft). */
  async restoreOwn(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.ARCHIVED) throw new BadRequestException('Only an archived course can be restored');
    if (!(await this.moveToDraft(course.id, [CourseStatus.ARCHIVED]))) throw new ConflictException(STATUS_CHANGED);
    return this.courseOrThrow(course.id);
  }

  /** Educator withdraws a course still in review back to draft to edit it. */
  async withdraw(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (!IN_REVIEW_STATUSES.includes(course.status)) {
      throw new BadRequestException(`Only a course in review can be withdrawn (current: ${course.status})`);
    }
    if (!(await this.moveToDraft(course.id, IN_REVIEW_STATUSES))) {
      throw new ConflictException('This course was decided a moment ago. Reload the page to see the result.');
    }
    // Closes the QA item, so a late decision on the withdrawn version is never applied.
    await this.bus.publish<CourseReviewWithdrawnPayload>('CourseReviewWithdrawn', { course_id: course.id, revision_id: null });
    return this.courseOrThrow(course.id);
  }

  /**
   * A course leaving the live states (flagged, archived) cannot keep a change
   * set in review: close the open revision and tell quality to drop its queue
   * item. The staged rows stay, so the educator can resubmit after reinstatement.
   * The UPDATE is conditional so a revision that was applied or decided in the
   * meantime is never overwritten with 'withdrawn'.
   */
  private async closeOpenRevision(courseId: string) {
    const open = await this.openRevision(courseId);
    if (!open) return;
    const res = await this.revisions.update({ id: open.id, status: In(OPEN_REVISION_STATUSES) }, { status: 'withdrawn', decided_at: new Date() });
    if (!res.affected) return;
    await this.bus.publish<CourseReviewWithdrawnPayload>('CourseReviewWithdrawn', { course_id: courseId, revision_id: open.id });
  }

  /** Educator unpublishes their own live course (hidden from the catalog). */
  async unpublishOwn(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.PUBLISHED) {
      throw new BadRequestException(`Only a published course can be unpublished (current: ${course.status})`);
    }
    if (!(await this.transition(course.id, [CourseStatus.PUBLISHED], { status: CourseStatus.UNLISTED }))) throw new ConflictException(STATUS_CHANGED);
    course.status = CourseStatus.UNLISTED;
    this.searchCache.clear();
    const owner = await this.ownerContact(course);
    await this.bus.publish('CourseUnlisted', {
      course_id: course.id,
      title: course.title,
      owner_id: course.owner_id,
      owner_user_id: course.created_by,
      owner_email: owner.email,
    });
    return course;
  }

  /** Educator re-publishes a course they had unlisted themselves. Staged edits stay staged. */
  async republishOwn(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.UNLISTED) {
      throw new BadRequestException(`Only an unlisted course can be re-published (current: ${course.status})`);
    }
    const publishedAt = course.published_at ?? new Date();
    const patch = { status: CourseStatus.PUBLISHED, ...(course.published_at ? {} : { published_at: publishedAt }) };
    if (!(await this.transition(course.id, [CourseStatus.UNLISTED], patch))) throw new ConflictException(STATUS_CHANGED);
    Object.assign(course, { status: CourseStatus.PUBLISHED, published_at: publishedAt });
    this.searchCache.clear();
    return course;
  }

  /** Educator appeals a flagged course; it goes back into the review queue. */
  async appeal(ctx: UserContext, courseId: string, note: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.FLAGGED) {
      throw new BadRequestException('Only a flagged course can be appealed');
    }
    if (!(await this.transition(course.id, [CourseStatus.FLAGGED], { status: CourseStatus.SUBMITTED }))) throw new ConflictException(STATUS_CHANGED);
    course.status = CourseStatus.SUBMITTED;
    const owner = await this.ownerContact(course);
    await this.bus.publish('CourseAppealSubmitted', {
      course_id: course.id,
      course_title: course.title,
      owner_user_id: course.created_by,
      owner_email: owner.email,
      appeal_note: note,
    });
    return course;
  }

  /** Platform-admin lifecycle overrides (unlist/restore/archive). Staged edits are never applied here. */
  async adminTransition(courseId: string, action: 'unlist' | 'restore' | 'archive'): Promise<Course> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');
    const previous = course.status;
    let to: CourseStatus;
    if (action === 'unlist') {
      if (![CourseStatus.PUBLISHED, CourseStatus.FLAGGED].includes(previous)) throw new BadRequestException(`Cannot unlist a ${previous} course`);
      to = CourseStatus.UNLISTED;
    } else if (action === 'restore') {
      if (![CourseStatus.UNLISTED, CourseStatus.FLAGGED].includes(previous)) throw new BadRequestException(`Cannot restore a ${previous} course`);
      to = CourseStatus.PUBLISHED;
    } else {
      to = CourseStatus.ARCHIVED;
    }
    // Status only, and before the (up to 8 s) owner lookup: nothing the
    // admin did not decide can be written back over a concurrent change.
    if (!(await this.transition(course.id, [previous], { status: to }))) {
      throw new ConflictException(`This course changed state a moment ago (it was ${previous}). Reload and try again.`);
    }
    course.status = to;
    this.searchCache.clear(); // moderation must reflect in the catalog immediately
    if (action === 'restore') return course;
    const owner = await this.ownerContact(course);
    const event = { course_id: course.id, title: course.title, owner_id: course.owner_id, owner_user_id: course.created_by, owner_email: owner.email };
    if (action === 'unlist') {
      await this.bus.publish('CourseUnlisted', event);
    } else {
      await this.closeReviewsOnArchive(course.id, previous);
      await this.bus.publish('CourseArchived', event);
    }
    return course;
  }

  async search(params: { q?: string; category?: string; pricing_type?: string; sort?: string; page: number; limit: number }) {
    const cacheKey = JSON.stringify(params);
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cached;
    const qb = this.courses
      .createQueryBuilder('c')
      .where('c.status = :status', { status: CourseStatus.PUBLISHED });
    if (params.q) {
      qb.andWhere(
        new Brackets((w) => w.where('c.title ILIKE :q', { q: `%${params.q}%` }).orWhere('c.description ILIKE :q', { q: `%${params.q}%` })),
      );
    }
    if (params.category && Object.values(CourseCategory).includes(params.category as CourseCategory)) {
      qb.andWhere('c.category = :category', { category: params.category });
    }
    if (params.pricing_type && Object.values(PricingType).includes(params.pricing_type as PricingType)) {
      qb.andWhere('c.pricing_type = :pricing', { pricing: params.pricing_type });
    }

    // Catalog ordering. Default "top": Bayesian-weighted rating so one lone
    // 5★ review can't outrank a course with fifty 4.8★ reviews — each course's
    // average is pulled toward the global prior (C) until it has enough votes (m).
    const sort = params.sort ?? 'top';
    if (sort === 'new') {
      qb.orderBy('c.published_at', 'DESC');
    } else if (sort === 'popular') {
      qb.orderBy('c.enrolled_count', 'DESC').addOrderBy(BAYES_SCORE, 'DESC');
    } else if (sort === 'price_asc') {
      qb.orderBy('c.price_etb', 'ASC', 'NULLS FIRST');
    } else if (sort === 'price_desc') {
      qb.orderBy('c.price_etb', 'DESC', 'NULLS LAST');
    } else {
      qb.orderBy(BAYES_SCORE, 'DESC').addOrderBy('c.enrolled_count', 'DESC').addOrderBy('c.published_at', 'DESC');
    }

    const take = Math.min(params.limit || 12, 50);
    const [items, total] = await qb
      .take(take)
      .skip((Math.max(params.page || 1, 1) - 1) * take)
      .getManyAndCount();
    const result = { total, page: params.page || 1, sort, items: items.map((c) => this.publicSummary(c)) };
    this.searchCache.set(cacheKey, result);
    return result;
  }

  /** Drops cached catalog pages (a revision apply changes live titles and prices). */
  clearSearchCache(): void {
    this.searchCache.clear();
  }

  /**
   * Top educators, ranked by total rating points (the sum of every star their
   * courses ever received) — quality × volume in one number — with enrollments
   * as the tiebreaker. Names resolved once per educator via the auth service.
   */
  async topEducators(limit = 12) {
    const rows: {
      educator_id: string;
      course_count: string;
      total_points: string;
      rating_count: string;
      learner_count: string;
      best_avg: string | null;
    }[] = await this.courses
      .createQueryBuilder('c')
      .select('c.created_by', 'educator_id')
      .addSelect('COUNT(*)', 'course_count')
      .addSelect('COALESCE(SUM(c.rating_points), 0)', 'total_points')
      .addSelect('COALESCE(SUM(c.rating_count), 0)', 'rating_count')
      .addSelect('COALESCE(SUM(c.enrolled_count), 0)', 'learner_count')
      .addSelect('MAX(c.rating_avg)', 'best_avg')
      .where('c.status = :status', { status: CourseStatus.PUBLISHED })
      .groupBy('c.created_by')
      .orderBy('total_points', 'DESC')
      .addOrderBy('learner_count', 'DESC')
      .addOrderBy('course_count', 'DESC')
      .limit(Math.min(limit, 50))
      .getRawMany();

    const out = [];
    for (const r of rows) {
      let name = 'Educator';
      try {
        name = (await this.internal.get<{ name: string }>(`/api/v1/internal/users/${r.educator_id}`)).name;
      } catch {
        /* keep placeholder */
      }
      const ratingCount = Number(r.rating_count);
      out.push({
        educator_id: r.educator_id,
        name,
        course_count: Number(r.course_count),
        total_rating_points: Number(r.total_points),
        rating_count: ratingCount,
        average_rating: ratingCount > 0 ? Number((Number(r.total_points) / ratingCount).toFixed(2)) : null,
        learner_count: Number(r.learner_count),
      });
    }
    return out;
  }

  /** Public educator profile: their published courses + aggregate stats. */
  async educatorProfile(educatorId: string) {
    const courses = await this.courses.find({
      where: { created_by: educatorId, status: CourseStatus.PUBLISHED },
      order: { rating_points: 'DESC', published_at: 'DESC' },
    });
    if (!courses.length) throw new NotFoundException('Educator has no published courses');

    let name = 'Educator';
    let bio: string | null = null;
    let expertise: string | null = null;
    try {
      name = (await this.internal.get<{ name: string }>(`/api/v1/internal/users/${educatorId}`)).name;
    } catch {
      /* placeholder name */
    }
    try {
      const profile = await this.internal.get<{ bio?: string; expertise_area?: string }>(
        `/api/v1/internal/educators/${educatorId}`,
      );
      bio = profile.bio ?? null;
      expertise = profile.expertise_area ?? null;
    } catch {
      /* profile enrichment is optional */
    }

    const totalPoints = courses.reduce((s, c) => s + c.rating_points, 0);
    const ratingCount = courses.reduce((s, c) => s + c.rating_count, 0);
    return {
      educator_id: educatorId,
      name,
      bio,
      expertise_area: expertise,
      course_count: courses.length,
      total_rating_points: totalPoints,
      rating_count: ratingCount,
      average_rating: ratingCount > 0 ? Number((totalPoints / ratingCount).toFixed(2)) : null,
      learner_count: courses.reduce((s, c) => s + c.enrolled_count, 0),
      courses: courses.map((c) => this.publicSummary(c)),
    };
  }

  /**
   * Public course detail = the LIVE version, for everyone including the owner
   * (this is the learner URL; the staged working copy is GET /courses/:id/working).
   * Lesson video keys are stripped (spec §9.2).
   */
  async publicDetail(courseId: string, ctx: UserContext | null) {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');
    const isPrivileged = !!ctx && (await this.isStaffFor(ctx, course));
    if (course.status !== CourseStatus.PUBLISHED && !isPrivileged) {
      throw new NotFoundException('Course not found');
    }
    const sectionsOut = (await this.loadTree(courseId))
      .filter(({ section }) => isLiveRow(section))
      .map(({ section, lessons }) => ({
        id: section.id,
        title: section.title,
        order: section.order_index,
        is_free_preview: section.is_free_preview,
        lessons: lessons.filter(isLiveRow).map((l) => ({
          id: l.id,
          title: l.title,
          summary: l.summary,
          duration_seconds: l.duration_seconds,
          order: l.order_index,
          has_video: !!l.video_s3_key,
        })),
      }));
    // Reviewer feedback (QO coaching/flag or institution send-back) is private
    // to the owner and platform staff — never shown to learners.
    const reviewFeedback = isPrivileged ? this.reviewFeedback(course) : null;
    // Instructor identity (public info) so the course page can link the
    // educator's profile and open a direct message.
    let instructorName = '';
    try {
      instructorName = (await this.internal.get<{ name: string }>(`/api/v1/internal/users/${course.created_by}`)).name;
    } catch {
      /* course page renders without it */
    }
    return {
      ...this.publicSummary(course),
      status: course.status,
      sections: sectionsOut,
      review_feedback: reviewFeedback,
      instructor_id: course.created_by,
      instructor_name: instructorName,
    };
  }

  /** The educator's working copy (live + staged edits, with change markers). */
  async working(ctx: UserContext, courseId: string) {
    const course = await this.courseOrThrow(courseId);
    if (!(await this.canAuthor(ctx, course))) throw new ForbiddenException('Not your course');
    // A draft never shows staged markers: leftovers from when it was live
    // (e.g. moved back to draft before folding existed) become the draft
    // here, exactly as the next edit or submit would fold them.
    if (course.status === CourseStatus.DRAFT) return this.workingView((await this.foldLeftoverStaging(course)) ?? course);
    return this.workingView(course);
  }

  private async workingView(course: Course) {
    const pendingFields = Object.keys(course.pending ?? {});
    const tree = await this.loadTree(course.id);
    const isStaged = (row: Section | Lesson) => !!row.pending_state || !!row.pending;
    const structureChanged = tree.some(({ section, lessons }) => isStaged(section) || lessons.some(isStaged));
    const sections = tree.map(({ section, lessons }) => {
      const s = mergedSection(section);
      return {
        id: section.id,
        title: s.title,
        order: section.order_index,
        is_free_preview: s.is_free_preview,
        pending_state: section.pending_state ?? null,
        changed_fields: Object.keys(section.pending ?? {}),
        lessons: lessons.map((lesson) => {
          const l = mergedLesson(lesson);
          return {
            id: lesson.id,
            title: l.title,
            summary: l.summary,
            duration_seconds: l.duration_seconds,
            order: lesson.order_index,
            has_video: !!l.video_s3_key,
            video_pending: !!lesson.pending && 'video_s3_key' in lesson.pending,
            pending_state: lesson.pending_state ?? null,
            changed_fields: Object.keys(lesson.pending ?? {}),
          };
        }),
      };
    });
    const [revision, pendingKnowledge, pendingAssessments] = await Promise.all([
      this.openRevision(course.id),
      this.extras.pendingKnowledge(course.id),
      // Only approved courses can have assessments waiting for review.
      LIVE_COURSE_STATUSES.includes(course.status) ? this.pendingAssessmentCount(course.id) : Promise.resolve(0),
    ]);
    return {
      ...this.publicSummary(mergedCourse(course)),
      status: course.status,
      review_feedback: this.reviewFeedback(course),
      pending_fields: pendingFields,
      has_pending_changes: pendingFields.length > 0 || structureChanged || pendingKnowledge.length > 0 || pendingAssessments > 0,
      revision: revision
        ? {
            id: revision.id,
            status: revision.status,
            changelog_summary: revision.changelog_summary,
            major: revision.changelog_major,
            submitted_at: revision.submitted_at,
            decision_notes: revision.decision_notes,
          }
        : null,
      pending_assessments_count: pendingAssessments,
      pending_knowledge_count: pendingKnowledge.length,
      sections,
    };
  }

  private reviewFeedback(course: Course) {
    return course.last_review_action
      ? { action: course.last_review_action, notes: course.last_review_notes, reviewed_at: course.last_reviewed_at }
      : null;
  }

  private async pendingAssessmentCount(courseId: string): Promise<number> {
    try {
      const rows = await this.internal.get<unknown[]>(`/api/v1/internal/courses/${courseId}/pending-assessments`);
      return Array.isArray(rows) ? rows.length : 0;
    } catch (err) {
      // Outcomes may be asleep on the free tier; the rest of the page still works.
      this.logger.warn(`pending assessments unavailable for course ${courseId}: ${(err as Error).message}`);
      return 0;
    }
  }

  /** Sections in order, each with its lessons in order (two queries, whatever the course size). */
  private async loadTree(courseId: string): Promise<Array<{ section: Section; lessons: Lesson[] }>> {
    const sections = await this.sections.find({ where: { course_id: courseId }, order: { order_index: 'ASC' } });
    if (!sections.length) return [];
    const lessons = await this.lessons.find({ where: { section_id: In(sections.map((s) => s.id)) }, order: { order_index: 'ASC' } });
    return sections.map((section) => ({ section, lessons: lessons.filter((l) => l.section_id === section.id) }));
  }

  async listOwn(ctx: UserContext) {
    const { ownerId } = await this.resolveOwner(ctx);
    const items = await this.courses.find({ where: { owner_id: ownerId }, order: { created_at: 'DESC' } });
    return items.map((c) => ({ ...this.publicSummary(c), status: c.status }));
  }

  /** Admin course search by title, ANY status (for the admin console — no UUIDs). */
  async adminSearch(q: string) {
    const qb = this.courses.createQueryBuilder('c').orderBy('c.created_at', 'DESC').take(25);
    if (q) qb.where('c.title ILIKE :q', { q: `%${q}%` });
    const items = await qb.getMany();
    return items.map((c) => ({ id: c.id, title: c.title, status: c.status, category: c.category, pricing_type: c.pricing_type }));
  }

  async lessonWithCourse(lessonId: string): Promise<{ lesson: Lesson; section: Section; course: Course }> {
    const lesson = await this.lessons.findOne({ where: { id: lessonId } });
    if (!lesson) throw new NotFoundException('Lesson not found');
    const section = await this.sections.findOne({ where: { id: lesson.section_id } });
    if (!section) throw new NotFoundException('Section not found');
    const course = await this.courses.findOne({ where: { id: section.course_id } });
    if (!course) throw new NotFoundException('Course not found');
    return { lesson, section, course };
  }

  async courseOrThrow(courseId: string): Promise<Course> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');
    return course;
  }

  async publishedCountForOwner(ownerId: string): Promise<number> {
    return this.courses.count({ where: { owner_id: ownerId, status: CourseStatus.PUBLISHED } });
  }

  /** Flat "Section — Lesson" outline titles (live version) for the AI study coach. */
  async outlineForCourse(courseId: string): Promise<string[]> {
    const out: string[] = [];
    for (const { section, lessons } of await this.loadTree(courseId)) {
      if (!isLiveRow(section)) continue;
      const live = lessons.filter(isLiveRow);
      if (!live.length) out.push(section.title);
      for (const l of live) out.push(`${section.title} — ${l.title}`);
    }
    return out;
  }

  /** Live lesson ids — what progress % and completion are computed over. 'removed' rows count until the removal is approved. */
  async lessonIdsForCourse(courseId: string): Promise<string[]> {
    const rows = await this.lessons
      .createQueryBuilder('l')
      .innerJoin(Section, 's', 's.id = l.section_id')
      .where('s.course_id = :courseId', { courseId })
      .andWhere("l.pending_state IS DISTINCT FROM 'added'")
      .andWhere("s.pending_state IS DISTINCT FROM 'added'")
      .select('l.id', 'id')
      .getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  publicSummary(course: Course) {
    return {
      id: course.id,
      title: course.title,
      description: course.description,
      category: course.category,
      language: course.language,
      thumbnail_url: course.thumbnail_url,
      last_major_update_at: course.last_major_update_at,
      pricing_type: course.pricing_type,
      price_etb: course.price_etb ? Number(course.price_etb) : null,
      owner_id: course.owner_id,
      owner_type: course.owner_type,
      published_at: course.published_at,
      rating_avg: course.rating_avg != null ? Number(course.rating_avg) : null,
      rating_count: course.rating_count ?? 0,
      enrolled_count: course.enrolled_count ?? 0,
    };
  }

  async ownedCourse(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');
    if (course.created_by !== ctx.id && ctx.role !== Role.PLATFORM_ADMIN) {
      throw new ForbiddenException('Not your course');
    }
    return course;
  }

  /** Owner, platform staff (QO / admin) or the admin of the course's institution. */
  async isStaffFor(ctx: UserContext, course: Course): Promise<boolean> {
    return ctx.role === Role.QUALITY_OFFICER || this.canAuthor(ctx, course);
  }

  /** Owner, platform admin or the admin of the course's institution (who manages its instructors' courses). */
  private async canAuthor(ctx: UserContext, course: Course): Promise<boolean> {
    if (course.created_by === ctx.id || course.owner_id === ctx.id || ctx.role === Role.PLATFORM_ADMIN) return true;
    if (ctx.role !== Role.INSTITUTION_ADMIN || !course.institution_id) return false;
    try {
      return (await this.myInstitutionId(ctx)) === course.institution_id;
    } catch {
      return false;
    }
  }

  private async assertSectionVideoKeys(course: { created_by: string; owner_id?: string | null }, sections: SectionInputDto[]) {
    for (const s of sections) {
      for (const l of s.lessons ?? []) await this.videoKeys.assertOwnVideoKey(course, l.video_s3_key, []);
    }
  }

  /** One section and its lessons, atomically. On an approved course the rows are staged as 'added'. */
  private async addSectionInternal(course: Course, dto: SectionInputDto, orderIndex: number, staged: boolean): Promise<Section> {
    await this.assertSectionVideoKeys(course, [dto]);
    return this.dataSource.transaction((m) => this.insertSection(m, course.id, dto, orderIndex, staged));
  }

  /** Writes only — callers validate video keys first so no network call runs inside the transaction. */
  private async insertSection(m: EntityManager, courseId: string, dto: SectionInputDto, orderIndex: number, staged: boolean): Promise<Section> {
    const pendingState: PendingState | null = staged ? 'added' : null;
    const sections = m.getRepository(Section);
    const lessons = m.getRepository(Lesson);
    const section = await sections.save(
      sections.create({
        course_id: courseId,
        title: dto.title,
        is_free_preview: dto.is_free_preview,
        order_index: orderIndex,
        pending_state: pendingState,
      }),
    );
    if (dto.lessons?.length) {
      await lessons.save(
        dto.lessons.map((l, i) =>
          lessons.create({
            section_id: section.id,
            title: l.title,
            summary: l.summary ?? null,
            video_s3_key: l.video_s3_key || null,
            duration_seconds: l.duration_seconds ?? 0,
            order_index: i,
            pending_state: pendingState,
          }),
        ),
      );
    }
    return section;
  }

  private async resolveOwner(ctx: UserContext): Promise<{ ownerId: string; ownerType: OwnerType }> {
    if (ctx.role === Role.INSTITUTION_ADMIN) {
      try {
        const institution = await this.internal.get<{ id: string }>(`/api/v1/internal/institutions/by-owner/${ctx.id}`);
        return { ownerId: institution.id, ownerType: OwnerType.INSTITUTION };
      } catch {
        throw new BadRequestException('Create your institution profile before creating courses');
      }
    }
    return { ownerId: ctx.id, ownerType: OwnerType.EDUCATOR };
  }

  async ownerContact(course: Course): Promise<{ email: string; name: string }> {
    try {
      if (course.owner_type === OwnerType.INSTITUTION) {
        const inst = await this.internal.get<{ email: string; name: string }>(`/api/v1/internal/institutions/${course.owner_id}`);
        return { email: inst.email, name: inst.name };
      }
      const educator = await this.internal.get<{ email: string; name: string }>(`/api/v1/internal/educators/${course.owner_id}`);
      return { email: educator.email, name: educator.name };
    } catch (err) {
      this.logger.warn(`could not resolve owner contact for course ${course.id}: ${(err as Error).message}`);
      return { email: '', name: '' };
    }
  }
}
