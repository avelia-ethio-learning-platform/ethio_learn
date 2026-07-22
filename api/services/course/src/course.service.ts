import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import { AiAssessor, createAiAssessor, GeneratedSection, MockAiAssessor } from '@ethiopialearn/ai';
import {
  CourseCategory,
  CourseRatedPayload,
  CourseReviewedPayload,
  EnrollmentCreatedPayload,
  CourseStatus,
  OwnerType,
  PricingType,
  QaDecisionAction,
  Role,
} from '@ethiopialearn/contracts';
import { Course, Lesson, Section } from './entities';
import { CreateCourseDto, SectionInputDto, UpdateCourseDto } from './dto';

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
  ) {}

  onModuleInit() {
    // QO decision → lifecycle transition (spec §12.1).
    this.bus.subscribe<CourseReviewedPayload>('CourseReviewed', async (payload) => {
      const course = await this.courses.findOne({ where: { id: payload.course_id } });
      if (!course) return;
      // Persist the quality officer's decision + notes so the educator sees the
      // feedback on the course page itself, not only in a notification.
      course.last_review_action = payload.action;
      course.last_review_notes = payload.notes ?? null;
      course.last_reviewed_at = new Date();
      if (payload.action === QaDecisionAction.APPROVE) {
        course.status = CourseStatus.PUBLISHED;
        course.published_at = new Date();
        await this.courses.save(course);
        this.searchCache.clear(); // new course is now visible in the catalog
        await this.bus.publish('CoursePublished', {
          course_id: course.id,
          title: course.title,
          owner_id: course.owner_id,
          owner_type: course.owner_type,
          owner_user_id: course.created_by,
          owner_email: payload.owner_email,
          pricing_type: course.pricing_type,
          price_etb: course.price_etb ? Number(course.price_etb) : null,
        });
      } else if (payload.action === QaDecisionAction.COACH) {
        course.status = CourseStatus.DRAFT;
        await this.courses.save(course);
      } else if (payload.action === QaDecisionAction.FLAG) {
        course.status = CourseStatus.FLAGGED;
        await this.courses.save(course);
      }
      this.logger.log(`course ${course.id} -> ${course.status} (QO ${payload.action})`);
    });

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

  async create(ctx: UserContext, dto: CreateCourseDto): Promise<Course> {
    // Institutions do not author courses directly — their instructors do.
    if (ctx.role === Role.INSTITUTION_ADMIN) {
      throw new ForbiddenException('Institutions do not create courses directly. Invite instructors to create courses.');
    }
    if (dto.pricing_type === PricingType.PAID && !dto.price_etb) {
      throw new BadRequestException('price_etb is required for paid courses');
    }
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
    if (dto.sections) {
      for (let i = 0; i < dto.sections.length; i++) {
        await this.addSectionInternal(course.id, dto.sections[i], i);
      }
    }
    return this.detailForOwner(course.id);
  }

  async update(ctx: UserContext, courseId: string, dto: UpdateCourseDto): Promise<Course> {
    const course = await this.ownedDraft(ctx, courseId);
    Object.assign(course, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.category !== undefined ? { category: dto.category } : {}),
      ...(dto.thumbnail_url !== undefined ? { thumbnail_url: dto.thumbnail_url } : {}),
      ...(dto.pricing_type !== undefined ? { pricing_type: dto.pricing_type } : {}),
      ...(dto.price_etb !== undefined ? { price_etb: dto.price_etb.toFixed(2) } : {}),
    });
    await this.courses.save(course);
    return this.detailForOwner(courseId);
  }

  async addSection(ctx: UserContext, courseId: string, dto: SectionInputDto): Promise<Section> {
    await this.ownedDraft(ctx, courseId);
    const count = await this.sections.count({ where: { course_id: courseId } });
    return this.addSectionInternal(courseId, dto, count);
  }

  /**
   * Apply an AI-generated outline in ONE call: every section + lesson (with its
   * summary) lands on the course together, instead of N client round-trips that
   * can fail halfway and leave a partial outline.
   */
  async applyStructure(ctx: UserContext, courseId: string, sectionsIn: SectionInputDto[]) {
    await this.ownedDraft(ctx, courseId);
    if (!sectionsIn?.length) throw new BadRequestException('sections[] is required');
    const offset = await this.sections.count({ where: { course_id: courseId } });
    for (let i = 0; i < sectionsIn.length; i++) {
      await this.addSectionInternal(courseId, sectionsIn[i], offset + i);
    }
    return {
      applied: true,
      sections_added: sectionsIn.length,
      lessons_added: sectionsIn.reduce((n, s) => n + (s.lessons?.length ?? 0), 0),
    };
  }

  /**
   * AI-assisted outline: turn a prompt / pasted document into a draft of
   * sections + lessons. NOT saved — the educator reviews & edits it, then the
   * frontend creates the sections/lessons via the normal endpoints.
   */
  async generateStructure(
    ctx: UserContext,
    dto: { title: string; source_text?: string; prompt?: string; section_count?: number; lessons_per_section?: number; level?: string; learning_style?: string },
  ): Promise<{ sections: GeneratedSection[]; ai_live: boolean; note?: string }> {
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
    // starter outline they can edit, and tell them the AI was unavailable.
    try {
      const result = await this.ai.generateCourseStructure(input);
      if (result.sections?.length) return { sections: result.sections, ai_live: this.ai.isLive };
      this.logger.warn('AI returned an empty outline — using offline draft');
    } catch (err) {
      this.logger.error(`AI outline generation failed: ${(err as Error).message}`);
    }
    const fallback = await new MockAiAssessor().generateCourseStructure(input);
    return {
      sections: fallback.sections,
      ai_live: false,
      note: 'The AI outline service was unavailable, so here is a starter outline. Edit the titles to fit your course.',
    };
  }

  async updateLesson(ctx: UserContext, lessonId: string, dto: { title?: string; duration_seconds?: number; video_s3_key?: string }) {
    const lesson = await this.lessons.findOne({ where: { id: lessonId } });
    if (!lesson) throw new NotFoundException('Lesson not found');
    const section = await this.sections.findOne({ where: { id: lesson.section_id } });
    await this.ownedDraft(ctx, section!.course_id);
    if (dto.title !== undefined) lesson.title = dto.title;
    if (dto.duration_seconds !== undefined) lesson.duration_seconds = dto.duration_seconds;
    if (dto.video_s3_key !== undefined) lesson.video_s3_key = dto.video_s3_key;
    return this.lessons.save(lesson);
  }

  async deleteLesson(ctx: UserContext, lessonId: string) {
    const lesson = await this.lessons.findOne({ where: { id: lessonId } });
    if (!lesson) throw new NotFoundException('Lesson not found');
    const section = await this.sections.findOne({ where: { id: lesson.section_id } });
    await this.ownedDraft(ctx, section!.course_id);
    await this.lessons.remove(lesson);
    return { deleted: true };
  }

  async deleteSection(ctx: UserContext, sectionId: string) {
    const section = await this.sections.findOne({ where: { id: sectionId } });
    if (!section) throw new NotFoundException('Section not found');
    await this.ownedDraft(ctx, section.course_id);
    await this.lessons.delete({ section_id: sectionId });
    await this.sections.remove(section);
    return { deleted: true };
  }

  async addLesson(ctx: UserContext, sectionId: string, dto: { title: string; video_s3_key?: string; duration_seconds?: number }) {
    const section = await this.sections.findOne({ where: { id: sectionId } });
    if (!section) throw new NotFoundException('Section not found');
    await this.ownedDraft(ctx, section.course_id);
    const count = await this.lessons.count({ where: { section_id: sectionId } });
    return this.lessons.save(
      this.lessons.create({
        section_id: sectionId,
        title: dto.title,
        video_s3_key: dto.video_s3_key ?? null,
        duration_seconds: dto.duration_seconds ?? 0,
        order_index: count,
      }),
    );
  }

  /** draft → submitted; validates the §7.2 required fields. */
  async submit(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.DRAFT) {
      throw new BadRequestException(`Only draft courses can be submitted (current: ${course.status})`);
    }
    const sections = await this.sections.find({ where: { course_id: courseId }, order: { order_index: 'ASC' } });
    if (sections.length === 0) throw new BadRequestException('Add at least one section before submitting');
    const lessonCount = await this.lessons
      .createQueryBuilder('l')
      .innerJoin(Section, 's', 's.id = l.section_id')
      .where('s.course_id = :courseId', { courseId })
      .getCount();
    if (lessonCount === 0) throw new BadRequestException('Add at least one lesson before submitting');
    if (!course.thumbnail_url) throw new BadRequestException('Thumbnail is required before submitting');
    if (course.pricing_type === PricingType.PAID && !course.price_etb) {
      throw new BadRequestException('price_etb is required for paid courses');
    }
    if (course.pricing_type === PricingType.FREEMIUM && !sections.some((s) => s.is_free_preview)) {
      throw new BadRequestException('Freemium courses need at least one free-preview section');
    }

    // Institution-owned courses go through internal institution review FIRST;
    // solo educators go straight to the platform QO queue.
    if (course.institution_id) {
      course.status = CourseStatus.INSTITUTION_REVIEW;
      await this.courses.save(course);
      const inst = await this.resolveInstitution(course.created_by);
      const owner = await this.ownerContact(course);
      if (inst?.institution_admin_user_id) {
        await this.bus.publish('CourseSubmittedToInstitution', {
          course_id: course.id,
          course_title: course.title,
          institution_admin_user_id: inst.institution_admin_user_id,
          instructor_name: owner.name,
        });
      }
      return course;
    }

    course.status = CourseStatus.SUBMITTED;
    await this.courses.save(course);
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

  private async myInstitutionId(ctx: UserContext): Promise<string> {
    const inst = await this.internal.get<{ id: string }>(`/api/v1/internal/institutions/by-owner/${ctx.id}`);
    return inst.id;
  }

  /** Courses awaiting the institution's internal review. */
  async institutionReviewQueue(ctx: UserContext) {
    const institutionId = await this.myInstitutionId(ctx);
    const items = await this.courses.find({ where: { institution_id: institutionId, status: CourseStatus.INSTITUTION_REVIEW }, order: { created_at: 'ASC' } });
    return this.withInstructorNames(items);
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

  /** Institution approves (→ platform QO) or rejects (→ instructor draft) a course. */
  async institutionDecide(ctx: UserContext, courseId: string, action: 'approve' | 'reject', notes?: string) {
    const institutionId = await this.myInstitutionId(ctx);
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course || course.institution_id !== institutionId) throw new NotFoundException('Course not in your review queue');
    if (course.status !== CourseStatus.INSTITUTION_REVIEW) throw new BadRequestException('Course is not awaiting institution review');
    const owner = await this.ownerContact(course);

    if (action === 'approve') {
      course.status = CourseStatus.SUBMITTED;
      await this.courses.save(course);
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
      course.status = CourseStatus.DRAFT;
      course.last_review_action = 'institution_reject';
      course.last_review_notes = notes ?? null;
      course.last_reviewed_at = new Date();
      await this.courses.save(course);
    }
    await this.bus.publish('CourseInstitutionReviewed', {
      course_id: course.id,
      course_title: course.title,
      owner_user_id: course.created_by,
      action,
      notes: notes ?? null,
    });
    return course;
  }

  /** Institution unlists / restores one of its own published/unlisted courses. */
  async institutionTransition(ctx: UserContext, courseId: string, action: 'unlist' | 'restore') {
    const institutionId = await this.myInstitutionId(ctx);
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course || course.institution_id !== institutionId) throw new NotFoundException('Not your institution course');
    if (action === 'unlist') {
      if (course.status !== CourseStatus.PUBLISHED) throw new BadRequestException('Only a published course can be unlisted');
      course.status = CourseStatus.UNLISTED;
    } else {
      if (course.status !== CourseStatus.UNLISTED) throw new BadRequestException('Only an unlisted course can be restored');
      course.status = CourseStatus.PUBLISHED;
    }
    await this.courses.save(course);
    return course;
  }

  /** Duplicate a course (with its sections + lessons) as a fresh draft. */
  async duplicate(ctx: UserContext, courseId: string): Promise<Course> {
    const source = await this.ownedCourse(ctx, courseId);
    const copy = await this.courses.save(
      this.courses.create({
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
    const sections = await this.sections.find({ where: { course_id: source.id }, order: { order_index: 'ASC' } });
    for (const s of sections) {
      const ns = await this.sections.save(this.sections.create({ course_id: copy.id, title: s.title, is_free_preview: s.is_free_preview, order_index: s.order_index }));
      const lessons = await this.lessons.find({ where: { section_id: s.id }, order: { order_index: 'ASC' } });
      for (const l of lessons) {
        await this.lessons.save(this.lessons.create({ section_id: ns.id, title: l.title, summary: l.summary, video_s3_key: l.video_s3_key, duration_seconds: l.duration_seconds, order_index: l.order_index }));
      }
    }
    return copy;
  }

  /** Educator archives their own course (reversible via restore). */
  async archiveOwn(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status === CourseStatus.ARCHIVED) return course;
    course.status = CourseStatus.ARCHIVED;
    await this.courses.save(course);
    return course;
  }

  async restoreOwn(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.ARCHIVED) throw new BadRequestException('Only an archived course can be restored');
    course.status = CourseStatus.DRAFT;
    await this.courses.save(course);
    return course;
  }

  /** Educator withdraws a course still in review back to draft to edit it. */
  async withdraw(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (![CourseStatus.SUBMITTED, CourseStatus.UNDER_REVIEW, CourseStatus.INSTITUTION_REVIEW].includes(course.status)) {
      throw new BadRequestException(`Only a course in review can be withdrawn (current: ${course.status})`);
    }
    course.status = CourseStatus.DRAFT;
    await this.courses.save(course);
    return course;
  }

  /** Educator unpublishes their own live course (hidden from the catalog). */
  async unpublishOwn(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.PUBLISHED) {
      throw new BadRequestException(`Only a published course can be unpublished (current: ${course.status})`);
    }
    course.status = CourseStatus.UNLISTED;
    await this.courses.save(course);
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

  /** Educator re-publishes a course they had unlisted themselves. */
  async republishOwn(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.UNLISTED) {
      throw new BadRequestException(`Only an unlisted course can be re-published (current: ${course.status})`);
    }
    course.status = CourseStatus.PUBLISHED;
    if (!course.published_at) course.published_at = new Date();
    await this.courses.save(course);
    this.searchCache.clear();
    return course;
  }

  /** Educator appeals a flagged course; it goes back into the review queue. */
  async appeal(ctx: UserContext, courseId: string, note: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.FLAGGED) {
      throw new BadRequestException('Only a flagged course can be appealed');
    }
    course.status = CourseStatus.SUBMITTED;
    await this.courses.save(course);
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

  /** Platform-admin lifecycle overrides (unlist/restore/archive). */
  async adminTransition(courseId: string, action: 'unlist' | 'restore' | 'archive'): Promise<Course> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');
    this.searchCache.clear(); // moderation must reflect in the catalog immediately
    const owner = await this.ownerContact(course);
    if (action === 'unlist') {
      if (![CourseStatus.PUBLISHED, CourseStatus.FLAGGED].includes(course.status)) {
        throw new BadRequestException(`Cannot unlist a ${course.status} course`);
      }
      course.status = CourseStatus.UNLISTED;
      await this.courses.save(course);
      await this.bus.publish('CourseUnlisted', { course_id: course.id, title: course.title, owner_id: course.owner_id, owner_user_id: course.created_by, owner_email: owner.email });
    } else if (action === 'restore') {
      if (![CourseStatus.UNLISTED, CourseStatus.FLAGGED].includes(course.status)) {
        throw new BadRequestException(`Cannot restore a ${course.status} course`);
      }
      course.status = CourseStatus.PUBLISHED;
      await this.courses.save(course);
    } else {
      course.status = CourseStatus.ARCHIVED;
      await this.courses.save(course);
      await this.bus.publish('CourseArchived', { course_id: course.id, title: course.title, owner_id: course.owner_id, owner_user_id: course.created_by, owner_email: owner.email });
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

  /** Public course detail. Lesson video keys are stripped (spec §9.2). */
  async publicDetail(courseId: string, ctx: UserContext | null) {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');
    let isPrivileged =
      !!ctx &&
      (ctx.id === course.created_by || ctx.role === Role.QUALITY_OFFICER || ctx.role === Role.PLATFORM_ADMIN);
    // Institution admins can view their own institution's courses (for internal review).
    if (!isPrivileged && ctx?.role === Role.INSTITUTION_ADMIN && course.institution_id) {
      try {
        isPrivileged = (await this.myInstitutionId(ctx)) === course.institution_id;
      } catch {
        /* not their institution */
      }
    }
    if (course.status !== CourseStatus.PUBLISHED && !isPrivileged) {
      throw new NotFoundException('Course not found');
    }
    const sections = await this.sections.find({ where: { course_id: courseId }, order: { order_index: 'ASC' } });
    const sectionsOut = [];
    for (const section of sections) {
      const lessons = await this.lessons.find({ where: { section_id: section.id }, order: { order_index: 'ASC' } });
      sectionsOut.push({
        id: section.id,
        title: section.title,
        order: section.order_index,
        is_free_preview: section.is_free_preview,
        lessons: lessons.map((l) => ({
          id: l.id,
          title: l.title,
          summary: l.summary,
          duration_seconds: l.duration_seconds,
          order: l.order_index,
          has_video: !!l.video_s3_key,
        })),
      });
    }
    // Reviewer feedback (QO coaching/flag or institution send-back) is private
    // to the owner and platform staff — never shown to learners.
    const reviewFeedback =
      isPrivileged && course.last_review_action
        ? { action: course.last_review_action, notes: course.last_review_notes, reviewed_at: course.last_reviewed_at }
        : null;
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

  async lessonIdsForCourse(courseId: string): Promise<string[]> {
    const rows = await this.lessons
      .createQueryBuilder('l')
      .innerJoin(Section, 's', 's.id = l.section_id')
      .where('s.course_id = :courseId', { courseId })
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

  private async ownedDraft(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.DRAFT) {
      throw new BadRequestException('Course can only be edited while in draft');
    }
    return course;
  }

  private async detailForOwner(courseId: string): Promise<Course> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    const sections = await this.sections.find({ where: { course_id: courseId }, order: { order_index: 'ASC' } });
    for (const section of sections) {
      section.lessons = await this.lessons.find({ where: { section_id: section.id }, order: { order_index: 'ASC' } });
    }
    course!.sections = sections;
    return course!;
  }

  private async addSectionInternal(courseId: string, dto: SectionInputDto, orderIndex: number): Promise<Section> {
    const section = await this.sections.save(
      this.sections.create({
        course_id: courseId,
        title: dto.title,
        is_free_preview: dto.is_free_preview,
        order_index: orderIndex,
      }),
    );
    if (dto.lessons) {
      for (let i = 0; i < dto.lessons.length; i++) {
        const l = dto.lessons[i];
        await this.lessons.save(
          this.lessons.create({
            section_id: section.id,
            title: l.title,
            summary: l.summary ?? null,
            video_s3_key: l.video_s3_key ?? null,
            duration_seconds: l.duration_seconds ?? 0,
            order_index: i,
          }),
        );
      }
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

  private async ownerContact(course: Course): Promise<{ email: string; name: string }> {
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
