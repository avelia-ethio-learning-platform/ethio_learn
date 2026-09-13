import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import { AiAssessor, createAiAssessor, MockAiAssessor, TutorChunk } from '@ethiopialearn/ai';
import { CourseStatus, CourseUpdatedPayload, EntitlementStatus, Role } from '@ethiopialearn/contracts';
import { Course, CourseChangeLog, CourseChatMessage, CourseKnowledge, Lesson, Section } from './entities';

const CHUNK_CHARS = 800;
const MAX_KNOWLEDGE_CHARS = 200_000; // per upload
const TOP_K = 6;

/** Split text on paragraph/sentence boundaries into ~CHUNK_CHARS pieces. */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const para of paragraphs) {
    const sentences = para.split(/(?<=[.!?።])\s+/);
    for (const sentence of sentences) {
      if ((current + ' ' + sentence).length > size && current) push();
      if (sentence.length > size) {
        for (let i = 0; i < sentence.length; i += size) {
          current = sentence.slice(i, i + size);
          push();
        }
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current.length > size * 0.6) push();
  }
  push();
  return chunks;
}

/**
 * Course change log, tutor knowledge base and the per-course RAG chatbot.
 * Kept out of CourseService so the authoring core stays readable.
 */
@Injectable()
export class CourseExtrasService {
  private readonly logger = new Logger(CourseExtrasService.name);
  private readonly ai: AiAssessor = createAiAssessor();

  constructor(
    @InjectRepository(Course) private readonly courses: Repository<Course>,
    @InjectRepository(Section) private readonly sections: Repository<Section>,
    @InjectRepository(Lesson) private readonly lessons: Repository<Lesson>,
    @InjectRepository(CourseChangeLog) private readonly changelog: Repository<CourseChangeLog>,
    @InjectRepository(CourseKnowledge) private readonly knowledge: Repository<CourseKnowledge>,
    @InjectRepository(CourseChatMessage) private readonly chat: Repository<CourseChatMessage>,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
  ) {}

  // ---- Change log ----------------------------------------------------------

  /** Educator posts an update. Major → enrolled learners are notified + badge flips. */
  async postChangelog(ctx: UserContext, courseId: string, summary: string, major: boolean) {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.PUBLISHED) throw new BadRequestException('Change log entries are for published courses');
    const entry = await this.changelog.save(
      this.changelog.create({ course_id: courseId, kind: major ? 'major' : 'minor', summary: summary.trim().slice(0, 1000), created_by: ctx.id }),
    );
    if (major) {
      course.last_major_update_at = entry.created_at;
      await this.courses.save(course);
      await this.bus.publish<CourseUpdatedPayload>('CourseUpdated', {
        course_id: course.id,
        course_title: course.title,
        owner_user_id: course.created_by,
        summary: entry.summary,
        changelog_id: entry.id,
      });
    }
    return this.changelogView(entry);
  }

  /** Auto-written by authoring actions on a PUBLISHED course (lesson added, video replaced…). */
  async autoChangelog(courseId: string, userId: string, summary: string) {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course || course.status !== CourseStatus.PUBLISHED) return;
    // Collapse bursts: one auto entry per summary per 10 minutes.
    const recent = await this.changelog
      .createQueryBuilder('c')
      .where('c.course_id = :courseId AND c.kind = :kind AND c.summary = :summary', { courseId, kind: 'minor', summary })
      .andWhere("c.created_at > now() - interval '10 minutes'")
      .getOne();
    if (recent) return;
    await this.changelog.save(this.changelog.create({ course_id: courseId, kind: 'minor', summary: summary.slice(0, 1000), created_by: userId }));
  }

  async listChangelog(courseId: string) {
    const rows = await this.changelog.find({ where: { course_id: courseId }, order: { created_at: 'DESC' }, take: 50 });
    return rows.map((r) => this.changelogView(r));
  }

  private changelogView(r: CourseChangeLog) {
    return { id: r.id, kind: r.kind, summary: r.summary, created_at: r.created_at };
  }

  // ---- Tutor knowledge base --------------------------------------------------

  /** Educator uploads notes / transcript text the tutor may answer from. */
  async addKnowledge(ctx: UserContext, courseId: string, title: string, text: string) {
    await this.ownedCourse(ctx, courseId);
    const cleanTitle = title.trim().slice(0, 200) || 'Notes';
    if (text.length > MAX_KNOWLEDGE_CHARS) throw new BadRequestException(`Text is too long (max ${MAX_KNOWLEDGE_CHARS.toLocaleString()} characters per upload)`);
    const chunks = chunkText(text);
    if (!chunks.length) throw new BadRequestException('Text is empty');
    await this.knowledge.delete({ course_id: courseId, source: 'notes', title: cleanTitle });
    await this.knowledge.save(chunks.map((c, i) => this.knowledge.create({ course_id: courseId, source: 'notes', title: cleanTitle, chunk_index: i, text: c })));
    return { title: cleanTitle, chunks: chunks.length };
  }

  async listKnowledge(ctx: UserContext, courseId: string) {
    await this.ownedCourse(ctx, courseId);
    const rows = await this.knowledge
      .createQueryBuilder('k')
      .select('k.source', 'source')
      .addSelect('k.title', 'title')
      .addSelect('COUNT(*)', 'chunks')
      .addSelect('SUM(LENGTH(k.text))', 'chars')
      .where('k.course_id = :courseId', { courseId })
      .groupBy('k.source')
      .addGroupBy('k.title')
      .orderBy('k.source', 'ASC')
      .getRawMany<{ source: string; title: string; chunks: string; chars: string }>();
    return rows.map((r) => ({ source: r.source, title: r.title, chunks: Number(r.chunks), chars: Number(r.chars) }));
  }

  async deleteKnowledge(ctx: UserContext, courseId: string, title: string) {
    await this.ownedCourse(ctx, courseId);
    const res = await this.knowledge.delete({ course_id: courseId, source: 'notes', title });
    return { deleted: res.affected ?? 0 };
  }

  /**
   * (Re)build the automatic part of the corpus from the course itself:
   * description + every section/lesson title and summary. Runs on publish and
   * on demand; educator notes are left untouched.
   */
  async reindexCourse(courseId: string) {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) return { chunks: 0 };
    await this.knowledge.delete({ course_id: courseId, source: 'description' });
    await this.knowledge.delete({ course_id: courseId, source: 'lessons' });
    const rows: CourseKnowledge[] = [];
    chunkText(`${course.title}. ${course.description}`).forEach((c, i) =>
      rows.push(this.knowledge.create({ course_id: courseId, source: 'description', title: 'Course overview', chunk_index: i, text: c })),
    );
    const sections = await this.sections.find({ where: { course_id: courseId }, order: { order_index: 'ASC' } });
    for (const section of sections) {
      const lessons = await this.lessons.find({ where: { section_id: section.id }, order: { order_index: 'ASC' } });
      lessons.forEach((l, i) => {
        const text = `${section.title} — ${l.title}. ${l.summary ?? ''}`.trim();
        rows.push(this.knowledge.create({ course_id: courseId, source: 'lessons', title: `Lesson: ${l.title}`, chunk_index: i, text }));
      });
    }
    if (rows.length) await this.knowledge.save(rows);
    return { chunks: rows.length };
  }

  async reindexOwned(ctx: UserContext, courseId: string) {
    await this.ownedCourse(ctx, courseId);
    return this.reindexCourse(courseId);
  }

  // ---- Tutor chat (RAG) --------------------------------------------------------

  /**
   * Entitled learners (and the course owner, for testing) ask the tutor.
   * Retrieval: Postgres full-text rank over the course corpus ('simple' config
   * so Amharic/Ge'ez text works too), ILIKE fallback, then the LLM answers ONLY
   * from those chunks — with citations and an explicit "not in the material".
   */
  async ask(ctx: UserContext, courseId: string, question: string) {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');
    const q = question.trim();
    if (q.length < 2) throw new BadRequestException('Ask a question');
    await this.assertCanChat(ctx, course);

    const chunks = await this.retrieve(courseId, q);
    const history = await this.chat.find({ where: { course_id: courseId, learner_id: ctx.id }, order: { created_at: 'DESC' }, take: 6 });
    const input = {
      course_title: course.title,
      question: q,
      chunks,
      history: history.reverse().map((m) => ({ role: m.role, content: m.content })),
    };
    let answer;
    try {
      answer = await this.ai.answerWithContext(input);
    } catch (err) {
      this.logger.warn(`tutor LLM call failed, using offline tutor: ${(err as Error).message}`);
      answer = await new MockAiAssessor().answerWithContext(input);
    }
    await this.chat.save([
      this.chat.create({ course_id: courseId, learner_id: ctx.id, role: 'user', content: q.slice(0, 4000), sources: [], not_covered: false }),
      this.chat.create({ course_id: courseId, learner_id: ctx.id, role: 'assistant', content: answer.answer.slice(0, 8000), sources: answer.sources, not_covered: answer.not_covered }),
    ]);
    return { answer: answer.answer, sources: answer.sources, not_covered: answer.not_covered, ai_live: this.ai.isLive };
  }

  async chatHistory(ctx: UserContext, courseId: string) {
    const rows = await this.chat.find({ where: { course_id: courseId, learner_id: ctx.id }, order: { created_at: 'ASC' }, take: 100 });
    return rows.map((m) => ({ id: m.id, role: m.role, content: m.content, sources: m.sources, not_covered: m.not_covered, created_at: m.created_at }));
  }

  /** Educator insight: what learners keep asking, and what the material failed to answer. */
  async chatInsights(ctx: UserContext, courseId: string) {
    await this.ownedCourse(ctx, courseId);
    const questions = await this.chat.find({ where: { course_id: courseId, role: 'user' }, order: { created_at: 'DESC' }, take: 300 });
    const unanswered = await this.chat.count({ where: { course_id: courseId, role: 'assistant', not_covered: true } });
    const total = await this.chat.count({ where: { course_id: courseId, role: 'assistant' } });
    return {
      questions_total: total,
      not_covered_total: unanswered,
      learners: new Set(questions.map((q) => q.learner_id)).size,
      recent_questions: questions.slice(0, 40).map((q) => ({ content: q.content, created_at: q.created_at })),
    };
  }

  private async retrieve(courseId: string, question: string): Promise<TutorChunk[]> {
    const ranked = await this.knowledge
      .createQueryBuilder('k')
      .where('k.course_id = :courseId', { courseId })
      .andWhere("to_tsvector('simple', k.text) @@ plainto_tsquery('simple', :q)", { q: question })
      .orderBy("ts_rank(to_tsvector('simple', k.text), plainto_tsquery('simple', :q))", 'DESC')
      .limit(TOP_K)
      .getMany();
    if (ranked.length) return ranked.map((k) => ({ title: k.title, text: k.text }));

    // Fallback: keyword ILIKE on the three longest words (handles morphology the simple parser misses).
    const words = question
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3)
      .sort((a, b) => b.length - a.length)
      .slice(0, 3);
    if (!words.length) return [];
    const qb = this.knowledge.createQueryBuilder('k').where('k.course_id = :courseId', { courseId });
    words.forEach((w, i) => qb.orWhere(`k.text ILIKE :w${i}`, { [`w${i}`]: `%${w}%` }));
    const rows = await qb.andWhere('k.course_id = :courseId', { courseId }).limit(TOP_K).getMany();
    return rows.map((k) => ({ title: k.title, text: k.text }));
  }

  private async assertCanChat(ctx: UserContext, course: Course) {
    if (ctx.id === course.created_by || ctx.role === Role.PLATFORM_ADMIN || ctx.role === Role.QUALITY_OFFICER) return;
    const e = await this.internal.get<{ entitlement_status: string }>(`/api/v1/internal/entitlements?learner_id=${ctx.id}&course_id=${course.id}`);
    if (e.entitlement_status !== EntitlementStatus.ACTIVE) throw new ForbiddenException('Enroll in the course to use the tutor');
  }

  private async ownedCourse(ctx: UserContext, courseId: string): Promise<Course> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');
    if (ctx.role === Role.PLATFORM_ADMIN) return course;
    if (course.created_by === ctx.id || course.owner_id === ctx.id) return course;
    if (ctx.role === Role.INSTITUTION_ADMIN && course.institution_id) {
      try {
        const inst = await this.internal.get<{ id: string }>(`/api/v1/internal/institutions/by-owner/${ctx.id}`);
        if (inst.id === course.institution_id) return course;
      } catch {
        /* fall through */
      }
    }
    throw new ForbiddenException('Not your course');
  }
}
