import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { InternalHttpClient, UserContext } from '@ethiopialearn/common';
import { AiAssessor, createAiAssessor, MockAiAssessor, TutorChunk } from '@ethiopialearn/ai';
import { CourseStatus, EntitlementStatus, Role } from '@ethiopialearn/contracts';
import { Course, CourseChangeLog, CourseChatMessage, CourseKnowledge, Lesson, Section } from './entities';

const CHUNK_CHARS = 800;
const MAX_KNOWLEDGE_CHARS = 200_000; // per upload
const TOP_K = 6;
const KNOWLEDGE_EXCERPT_CHARS = 400;

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
    private readonly internal: InternalHttpClient,
  ) {}

  // ---- Change log ----------------------------------------------------------

  /**
   * Educator posts a note to the change log. Always MINOR (no learner email):
   * a major announcement goes out only when a reviewed revision is applied,
   * so learners are never told about changes that are not live.
   */
  async postChangelog(ctx: UserContext, courseId: string, summary: string) {
    const course = await this.ownedCourse(ctx, courseId);
    if (course.status !== CourseStatus.PUBLISHED) throw new BadRequestException('Change log entries are for published courses');
    const entry = await this.changelog.save(
      this.changelog.create({ course_id: courseId, kind: 'minor', summary: summary.trim().slice(0, 1000), created_by: ctx.id }),
    );
    return this.changelogView(entry);
  }

  async listChangelog(courseId: string) {
    const rows = await this.changelog.find({ where: { course_id: courseId }, order: { created_at: 'DESC' }, take: 50 });
    return rows.map((r) => this.changelogView(r));
  }

  private changelogView(r: CourseChangeLog) {
    return { id: r.id, kind: r.kind, summary: r.summary, created_at: r.created_at };
  }

  // ---- Tutor knowledge base --------------------------------------------------

  /**
   * Store notes / transcript text the tutor may answer from. Authorization and
   * the revision gate live in CourseService.addKnowledge. 'pending' notes (on an
   * approved course) replace only an earlier pending upload of the same title:
   * the live version keeps serving learners until the revision is applied.
   */
  async addKnowledge(course: Course, title: string, text: string, state: 'live' | 'pending') {
    const cleanTitle = title.trim().slice(0, 200) || 'Notes';
    if (text.length > MAX_KNOWLEDGE_CHARS) throw new BadRequestException(`Text is too long (max ${MAX_KNOWLEDGE_CHARS.toLocaleString()} characters per upload)`);
    const chunks = chunkText(text);
    if (!chunks.length) throw new BadRequestException('Text is empty');
    await this.knowledge.delete({ course_id: course.id, source: 'notes', title: cleanTitle, state });
    await this.knowledge.save(
      chunks.map((c, i) => this.knowledge.create({ course_id: course.id, source: 'notes', title: cleanTitle, chunk_index: i, text: c, state })),
    );
    return { title: cleanTitle, chunks: chunks.length, state };
  }

  /** Notes staged on an approved course, one entry per document (working copy + review diff). */
  async pendingKnowledge(courseId: string): Promise<Array<{ title: string; chars: number; excerpt: string }>> {
    const rows = await this.knowledge.find({
      where: { course_id: courseId, state: 'pending' },
      order: { title: 'ASC', chunk_index: 'ASC' },
    });
    const docs = new Map<string, string[]>();
    for (const r of rows) docs.set(r.title, [...(docs.get(r.title) ?? []), r.text]);
    return [...docs.entries()].map(([title, texts]) => ({
      title,
      chars: texts.reduce((n, t) => n + t.length, 0),
      excerpt: texts.join(' ').slice(0, KNOWLEDGE_EXCERPT_CHARS),
    }));
  }

  async listKnowledge(ctx: UserContext, courseId: string) {
    await this.ownedCourse(ctx, courseId);
    const rows = await this.knowledge
      .createQueryBuilder('k')
      .select('k.source', 'source')
      .addSelect('k.title', 'title')
      .addSelect('COUNT(*)', 'chunks')
      .addSelect('SUM(LENGTH(k.text))', 'chars')
      .addSelect('k.state', 'state')
      .where('k.course_id = :courseId', { courseId })
      .groupBy('k.source')
      .addGroupBy('k.title')
      .addGroupBy('k.state')
      .orderBy('k.source', 'ASC')
      .getRawMany<{ source: string; title: string; chunks: string; chars: string; state: 'live' | 'pending' }>();
    return rows.map((r) => ({ source: r.source, title: r.title, chunks: Number(r.chunks), chars: Number(r.chars), state: r.state }));
  }

  /**
   * Remove a tutor note by title. Authorization and the edit gate live in
   * CourseService.deleteKnowledge. On an approved course (`staged`) a title
   * can exist twice — the approved live note and a pending re-upload — and
   * only one of them is ever removed: `state` picks it, and without `state`
   * the pending upload goes first, so undoing a staged re-upload never takes
   * the approved note away from learners. A live note is removed at once: it
   * is tutor reference material, not learner-visible course content.
   * On a draft every note is live, so the title alone identifies it.
   */
  async deleteKnowledge(courseId: string, title: string, staged: boolean, state?: 'live' | 'pending') {
    const note = { course_id: courseId, source: 'notes', title };
    if (!staged) return { deleted: (await this.knowledge.delete(note)).affected ?? 0, state: 'live' as const };
    for (const s of state ? [state] : (['pending', 'live'] as const)) {
      const res = await this.knowledge.delete({ ...note, state: s });
      if (res.affected || state) return { deleted: res.affected ?? 0, state: s };
    }
    return { deleted: 0, state: null };
  }

  /**
   * (Re)build the automatic part of the corpus from the LIVE course:
   * description + every live section/lesson title and summary. Staged edits
   * ('added' rows, pending fields) are left out until their revision is
   * applied, which reindexes again. Runs on publish and on demand; educator
   * notes are left untouched.
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
      if (section.pending_state === 'added') continue;
      const lessons = (await this.lessons.find({ where: { section_id: section.id }, order: { order_index: 'ASC' } })).filter(
        (l) => l.pending_state !== 'added',
      );
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

  /** Only 'live' knowledge: notes staged on an approved course wait for review. */
  private async retrieve(courseId: string, question: string): Promise<TutorChunk[]> {
    const ranked = await this.knowledge
      .createQueryBuilder('k')
      .where('k.course_id = :courseId', { courseId })
      .andWhere("k.state = 'live'")
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
    // The keyword alternatives are bracketed so the OR can never widen the
    // search beyond this course's live rows.
    const rows = await this.knowledge
      .createQueryBuilder('k')
      .where('k.course_id = :courseId', { courseId })
      .andWhere("k.state = 'live'")
      .andWhere(new Brackets((b) => words.forEach((w, i) => b.orWhere(`k.text ILIKE :w${i}`, { [`w${i}`]: `%${w}%` }))))
      .limit(TOP_K)
      .getMany();
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
