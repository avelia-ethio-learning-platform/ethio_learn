import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { randomInt, randomUUID } from 'crypto';
import { EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import { aiFallbackNote, AiAssessor, MockAiAssessor, createAiAssessor } from '@ethiopialearn/ai';
import {
  AssessmentResultPayload,
  AssessmentType,
  CourseRevisionClosedPayload,
  CourseStatus,
  EntitlementStatus,
  EventEnvelope,
  Role,
} from '@ethiopialearn/contracts';
import { S3StorageProvider } from '@ethiopialearn/storage';
import { Assessment, AssessmentAttempt, AssessmentState } from './entities';

const PROJECT_MAX_BYTES = 50 * 1024 * 1024; // 50MB (spec §10.1)
/** Quiz attempts per learner unless the educator sets max_attempts. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Seconds of grace past the time limit before a submission is refused as late. */
const TIME_LIMIT_GRACE_SECONDS = 90;

/** Proctoring: violations of one type tolerated before the exam is force-ended. */
export const PROCTOR_WARNING_LIMIT = 3;
const PROCTOR_EVENT_TYPES = ['no_face', 'multiple_faces', 'tab_switch', 'copy_paste', 'other'] as const;
/** ~97KB binary — screenshots are captured client-side as small JPEG thumbnails. */
const SCREENSHOT_BASE64_MAX = 130_000;

/** Statuses of a course that already passed quality review: new assessments on it wait for the next review. */
const APPROVED_COURSE_STATUSES: string[] = [CourseStatus.PUBLISHED, CourseStatus.UNLISTED];
/** Waits between tries of the revision-close handler — the event bus acks a message even when its handler throws. */
const REVISION_CLOSE_RETRY_DELAYS_MS = [1_000, 3_000];
/** Assessment ids are uuids; one malformed id would make Postgres reject the whole `id IN (...)` statement. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Date for a valid ISO string, else null. */
function validDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Fisher–Yates with crypto randomness — the paper order must not be guessable. */
function shuffled<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface QuizQuestionCfg {
  kind: 'mcq' | 'written';
  prompt: string;
  options?: string[];
  correct_index?: number;
  /** Educator marking guidance fed to the AI grader (never shown to learners). */
  guidance?: string;
  points: number;
}

interface QuizResponse {
  selected_index: number | null;
  text: string | null;
}

interface EntitlementInfo {
  entitlement_status: string;
  enrollment_id: string | null;
}

/** The internal course read (course service GET /internal/courses/:id) fields used here. */
interface CourseRef {
  title: string;
  owner_id: string;
  owner_type?: string;
  status?: string;
  created_by?: string;
  institution_id?: string | null;
}

@Injectable()
export class AssessmentService implements OnModuleInit {
  private readonly logger = new Logger(AssessmentService.name);
  private readonly ai: AiAssessor = createAiAssessor();

  constructor(
    @InjectRepository(Assessment) private readonly assessments: Repository<Assessment>,
    @InjectRepository(AssessmentAttempt) private readonly attempts: Repository<AssessmentAttempt>,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
    private readonly storage: S3StorageProvider,
  ) {}

  onModuleInit() {
    this.bus.subscribe<CourseRevisionClosedPayload>('CourseRevisionClosed', (p, envelope) => this.onRevisionClosed(p, envelope));
  }

  async create(ctx: UserContext, dto: { course_id: string; type: AssessmentType; is_required?: boolean; config?: any; pass_score?: number }) {
    const course = await this.courseRef(dto.course_id);
    if (!(await this.canManageCourse(ctx, course))) throw new ForbiddenException('Not your course');
    let config = dto.config ?? {};
    if (dto.type === AssessmentType.QUIZ) {
      const questions = this.validateQuizQuestions(config?.questions);
      const timeLimit = Number(config?.time_limit_minutes);
      const maxAttempts = Number(config?.max_attempts);
      const poolSize = Number(config?.pool_size);
      const cooldown = Number(config?.cooldown_minutes);
      config = {
        ...config,
        questions,
        proctored: !!config?.proctored,
        time_limit_minutes: Number.isFinite(timeLimit) && timeLimit >= 1 ? Math.min(Math.round(timeLimit), 240) : null,
        // Anti-cheat knobs (all server-enforced):
        shuffle: config?.shuffle === undefined ? true : !!config.shuffle, // randomize question + option order per attempt
        pool_size: Number.isFinite(poolSize) && poolSize >= 1 ? Math.min(Math.round(poolSize), questions.length) : null, // serve N of the bank
        max_attempts: Number.isFinite(maxAttempts) && maxAttempts >= 1 ? Math.min(Math.round(maxAttempts), 20) : DEFAULT_MAX_ATTEMPTS,
        cooldown_minutes: Number.isFinite(cooldown) && cooldown >= 0 ? Math.min(Math.round(cooldown), 10_080) : 0,
      };
    }
    // Learners of an approved course keep the version the quality officer saw:
    // a new (possibly required) assessment would otherwise change certificate
    // criteria unreviewed. It goes live when the course's revision is applied.
    const state: AssessmentState = APPROVED_COURSE_STATUSES.includes(course.status ?? '') ? 'pending' : 'live';
    return this.assessments.save(
      this.assessments.create({
        course_id: dto.course_id,
        type: dto.type,
        is_required: dto.is_required ?? true,
        config,
        pass_score: dto.pass_score ?? 60,
        state,
      }),
    );
  }

  /** Normalize + validate mixed MCQ/written quiz questions. */
  private validateQuizQuestions(raw: unknown): QuizQuestionCfg[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new BadRequestException('Quiz requires config.questions[] (kind mcq: prompt/options/correct_index · kind written: prompt, optional guidance)');
    }
    return raw.map((q: any, i: number) => {
      const prompt = String(q?.prompt ?? '').trim();
      if (!prompt) throw new BadRequestException(`Question ${i + 1}: prompt is required`);
      const points = Number(q?.points) > 0 ? Math.min(Number(q.points), 100) : 1;
      if (q?.kind === 'written') {
        return { kind: 'written' as const, prompt, guidance: String(q?.guidance ?? '').trim() || undefined, points };
      }
      const options = Array.isArray(q?.options) ? q.options.map((o: any) => String(o)) : [];
      if (options.length < 2) throw new BadRequestException(`Question ${i + 1}: MCQ needs at least 2 options`);
      const correct = Number(q?.correct_index);
      if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
        throw new BadRequestException(`Question ${i + 1}: correct_index out of range`);
      }
      return { kind: 'mcq' as const, prompt, options, correct_index: correct, points };
    });
  }

  /** AI-generate draft quiz questions from a topic (not saved — educator edits then saves). */
  async generateQuiz(ctx: UserContext, courseId: string, topic: string, count: number, difficulty?: string) {
    const course = await this.courseRef(courseId);
    if (!(await this.canManageCourse(ctx, course))) throw new ForbiddenException('Not your course');
    try {
      const questions = await this.ai.generateQuiz(topic, count, difficulty);
      return { questions, ai_live: this.ai.isLive };
    } catch (err) {
      this.logger.warn(`AI quiz generation failed, falling back to mock: ${(err as Error).message}`);
      const questions = await new MockAiAssessor().generateQuiz(topic, count);
      return { questions, ai_live: false, note: aiFallbackNote(err) };
    }
  }

  /**
   * Learner-safe listing: quiz answers stripped, live assessments only.
   * Course staff (and quality officers) asking with include_pending also get
   * the assessments waiting for review; anyone else gets the learner view.
   */
  async listForCourse(ctx: UserContext, courseId: string, includePending = false) {
    if (!courseId) throw new BadRequestException('course_id is required');
    const rows = await this.assessments.find({ where: { course_id: courseId } });
    let visible = rows.filter((a) => a.state !== 'pending');
    if (includePending && visible.length < rows.length && (await this.canSeePending(ctx, courseId))) visible = rows;
    return visible.map((a) => {
      const questions: any[] = a.config.questions ?? [];
      return {
        id: a.id,
        course_id: a.course_id,
        type: a.type,
        state: a.state ?? 'live',
        is_required: a.is_required,
        pass_score: a.pass_score,
        question_count: a.type === AssessmentType.QUIZ ? questions.length : undefined,
        written_count: a.type === AssessmentType.QUIZ ? questions.filter((q) => q?.kind === 'written').length : undefined,
        proctored: a.type === AssessmentType.QUIZ ? !!a.config.proctored : undefined,
        time_limit_minutes: a.type === AssessmentType.QUIZ ? (a.config.time_limit_minutes ?? null) : undefined,
        max_attempts: a.type === AssessmentType.QUIZ ? (a.config.max_attempts ?? DEFAULT_MAX_ATTEMPTS) : undefined,
        pool_size: a.type === AssessmentType.QUIZ ? (a.config.pool_size ?? null) : undefined,
      };
    });
  }

  /**
   * Assessments waiting for review, WITH answer keys and marking guidance —
   * the quality officer checks them in the course revision diff. Internal
   * (service-to-service) only; never expose this to learners.
   */
  async pendingForReview(courseId: string) {
    const rows = await this.assessments.find({ where: { course_id: courseId, state: 'pending' }, order: { created_at: 'ASC' } });
    return rows.map((a) => {
      const questions: any[] = a.type === AssessmentType.QUIZ ? (a.config.questions ?? []) : [];
      return {
        id: a.id,
        type: a.type,
        is_required: a.is_required,
        pass_score: a.pass_score,
        question_count: questions.length,
        created_at: a.created_at,
        questions: questions.map((q) => ({
          prompt: q.prompt,
          kind: q.kind === 'written' ? 'written' : 'mcq',
          options: q.kind === 'written' ? undefined : q.options,
          correct_index: q.kind === 'written' ? undefined : q.correct_index,
          guidance: q.kind === 'written' ? q.guidance : undefined,
        })),
        instructions: a.type === AssessmentType.PROJECT ? (a.config.instructions ?? '') : undefined,
        topic_context: a.type === AssessmentType.AI_VIVA ? (a.config.topic_context ?? null) : undefined,
      };
    });
  }

  /**
   * A course revision closed.
   * - applied / rejected: exactly the pending assessments frozen at submit
   *   (`assessment_ids`, the ones the quality officer was shown) go live or are
   *   deleted. Assessments added later stay pending for the next revision, and
   *   an empty list touches nothing, so an assessment nobody reviewed (e.g.
   *   outcomes was unreachable when the diff was built) never reaches learners.
   * - discarded: pending assessments created up to the discard are deleted; one
   *   the educator adds right after discarding survives a late-delivered event.
   * Events published before `assessment_ids` / `closed_at` existed fall back to
   * the submit time (applied/rejected) or the event's publish time (discarded).
   */
  async onRevisionClosed(p: CourseRevisionClosedPayload, envelope?: EventEnvelope<CourseRevisionClosedPayload>): Promise<void> {
    if (p.outcome === 'discarded') {
      const closedAt = validDate(p.closed_at) ?? validDate(envelope?.metadata?.timestamp);
      if (!closedAt) {
        // Deleting without a cutoff could take assessments added after the
        // discard; leaving them pending is safe (the educator can discard again).
        this.logger.warn(`CourseRevisionClosed ${p.revision_id} (discarded) has no valid closed_at — pending assessments left as they are`);
        return;
      }
      await this.withRetry(`discard pending assessments of course ${p.course_id}`, () =>
        this.assessments.delete({ course_id: p.course_id, state: 'pending', created_at: LessThanOrEqual(closedAt) }),
      );
      return;
    }
    if (p.outcome !== 'applied' && p.outcome !== 'rejected') {
      this.logger.warn(`CourseRevisionClosed ${p.revision_id} has unknown outcome '${String(p.outcome)}' — pending assessments left as they are`);
      return;
    }
    const reviewed = Array.isArray(p.assessment_ids) ? this.frozenAssessments(p, p.assessment_ids) : this.reviewedBeforeSubmit(p);
    if (!reviewed) return;
    if (p.outcome === 'applied') {
      await this.withRetry(`activate pending assessments of course ${p.course_id}`, () =>
        this.assessments.update(reviewed, { state: 'live' }),
      );
    } else {
      await this.withRetry(`delete rejected assessments of course ${p.course_id}`, () => this.assessments.delete(reviewed));
    }
  }

  /** The reviewed ids, still pending and on this course (a live or foreign id is never touched); null = nothing to do. */
  private frozenAssessments(p: CourseRevisionClosedPayload, assessmentIds: unknown[]) {
    const ids = [...new Set(assessmentIds.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)))];
    const malformed = assessmentIds.filter((id) => typeof id !== 'string' || !UUID_RE.test(id));
    if (malformed.length) {
      this.logger.warn(`CourseRevisionClosed ${p.revision_id} (${p.outcome}) carries ${malformed.length} malformed assessment id(s) — skipped`);
    }
    if (!ids.length) return null;
    return { id: In(ids), course_id: p.course_id, state: 'pending' as const };
  }

  /**
   * Legacy events (no assessment_ids): only assessments created before the
   * revision was submitted can have been in front of the reviewer. null =
   * nothing to do.
   */
  private reviewedBeforeSubmit(p: CourseRevisionClosedPayload) {
    const submittedAt = validDate(p.submitted_at);
    if (!submittedAt) {
      // Without the submit time we cannot tell reviewed from unreviewed rows;
      // leaving them pending is safe (they show up in the next revision).
      this.logger.warn(`CourseRevisionClosed ${p.revision_id} (${p.outcome}) has no valid submitted_at — pending assessments left as they are`);
      return null;
    }
    return { course_id: p.course_id, state: 'pending' as const, created_at: LessThanOrEqual(submittedAt) };
  }

  async startAttempt(ctx: UserContext, assessmentId: string) {
    const assessment = await this.assessmentOrThrow(assessmentId);
    if (assessment.state === 'pending') throw new NotFoundException('Assessment not available yet');
    const entitlement = await this.entitlement(ctx.id, assessment.course_id);

    if (assessment.type === AssessmentType.QUIZ) {
      // Anti-cheat: an unfinished attempt is resumed, never replaced — restarting
      // to fish for an easier question set is not possible. Expired open attempts
      // are auto-submitted as late before a new one can start.
      const open = await this.attempts.findOne({
        where: { assessment_id: assessment.id, learner_id: ctx.id, submitted_at: IsNull() },
        order: { created_at: 'DESC' },
      });
      if (open) {
        if (this.timeLimitExpired(assessment, open)) {
          open.submitted_at = new Date();
          open.terminated = true;
          open.passed = false;
          open.score = open.score ?? 0;
          open.detail = { ...open.detail, termination_reason: 'Time limit expired before submission' };
          await this.attempts.save(open);
        } else {
          return this.quizAttemptView(assessment, open);
        }
      }
      const finished = await this.attempts.find({
        where: { assessment_id: assessment.id, learner_id: ctx.id },
        order: { created_at: 'DESC' },
      });
      if (finished.some((a) => a.passed === true)) throw new BadRequestException('You have already passed this quiz');
      const maxAttempts = Number(assessment.config.max_attempts ?? DEFAULT_MAX_ATTEMPTS);
      if (finished.length >= maxAttempts) throw new ForbiddenException(`You have used all ${maxAttempts} attempts for this quiz`);
      const cooldown = Number(assessment.config.cooldown_minutes ?? 0);
      const last = finished[0];
      if (cooldown > 0 && last?.submitted_at && Date.now() - last.submitted_at.getTime() < cooldown * 60_000) {
        const wait = Math.ceil((cooldown * 60_000 - (Date.now() - last.submitted_at.getTime())) / 60_000);
        throw new ForbiddenException(`Please wait ${wait} more minute(s) before trying again`);
      }
    }

    const attempt = await this.attempts.save(
      this.attempts.create({
        assessment_id: assessment.id,
        learner_id: ctx.id,
        enrollment_id: entitlement.enrollment_id!,
        score: null,
        passed: null,
        detail: {},
        submitted_at: null,
      }),
    );

    if (assessment.type === AssessmentType.QUIZ) {
      // Per-attempt paper: pick pool_size questions from the bank and shuffle
      // question + option order. The served order is stored on the attempt so
      // grading can map the learner's positional answers back to the bank —
      // two learners sitting side by side never see the same paper.
      const bank: any[] = assessment.config.questions ?? [];
      let order = bank.map((_, i) => i);
      if (assessment.config.shuffle !== false) order = shuffled(order);
      const poolSize = Number(assessment.config.pool_size);
      if (Number.isFinite(poolSize) && poolSize >= 1 && poolSize < order.length) order = order.slice(0, poolSize);
      const optionOrders = order.map((qi) => {
        const q = bank[qi];
        if (q.kind === 'written' || !Array.isArray(q.options)) return null;
        const idx = q.options.map((_: unknown, i: number) => i);
        return assessment.config.shuffle !== false ? shuffled(idx) : idx;
      });
      attempt.detail = { ...attempt.detail, order, option_orders: optionOrders };
      await this.attempts.save(attempt);
      return this.quizAttemptView(assessment, attempt);
    }

    if (assessment.type === AssessmentType.AI_VIVA) {
      const course = await this.internal.get<{ title: string }>(`/api/v1/internal/courses/${assessment.course_id}`);
      const question = await this.ai.generateVivaQuestion(course.title, assessment.config.topic_context ?? course.title);
      attempt.detail = { question };
      await this.attempts.save(attempt);
      return { attempt_id: attempt.id, type: assessment.type, question };
    }

    // project: hand back a signed upload URL (max 50MB, spec §10.1)
    const key = `projects/${ctx.id}/${randomUUID()}`;
    const upload = await this.storage.getSignedUploadUrl(key, 'application/octet-stream');
    attempt.detail = { file_key: key };
    await this.attempts.save(attempt);
    return {
      attempt_id: attempt.id,
      type: assessment.type,
      instructions: assessment.config.instructions ?? '',
      upload_url: upload.url,
      file_key: key,
      max_bytes: PROJECT_MAX_BYTES,
    };
  }

  async submitAttempt(
    ctx: UserContext,
    attemptId: string,
    body: {
      answers?: number[];
      responses?: { index?: number; selected_index?: number | null; text?: string | null }[];
      answer?: string;
      terminated?: boolean;
      termination_reason?: string;
    },
  ) {
    const attempt = await this.attempts.findOne({ where: { id: attemptId } });
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.learner_id !== ctx.id) throw new ForbiddenException('Not your attempt');
    if (attempt.submitted_at) throw new BadRequestException('Attempt already submitted');
    const assessment = await this.assessmentOrThrow(attempt.assessment_id);

    if (assessment.type === AssessmentType.QUIZ) {
      // Server-side clock: the client timer is advisory. Past the grace window
      // the paper is recorded as late — graded for the record, but not passed.
      if (this.timeLimitExpired(assessment, attempt)) {
        body = { ...body, terminated: true, termination_reason: 'Submitted after the time limit' };
      }
      await this.gradeQuiz(assessment, attempt, body);
    } else if (assessment.type === AssessmentType.AI_VIVA) {
      if (!body.answer?.trim()) throw new BadRequestException('answer is required');
      const evaluation = await this.ai.evaluateVivaAnswer(attempt.detail.question ?? '', body.answer);
      attempt.score = evaluation.score;
      attempt.passed = evaluation.score >= assessment.pass_score;
      attempt.detail = { ...attempt.detail, answer: body.answer, feedback: evaluation.feedback };
    } else {
      // project — recorded, graded manually by the educator. The file is always
      // the key startAttempt issued (kept in attempt.detail): a client-supplied
      // key could point the educator's download at someone else's object.
      attempt.score = null;
      attempt.passed = null;
    }

    attempt.submitted_at = new Date();
    await this.attempts.save(attempt);

    if (attempt.passed !== null) {
      await this.publishResult(assessment, attempt, ctx.email);
    }
    return {
      attempt_id: attempt.id,
      score: attempt.score,
      passed: attempt.passed,
      feedback: attempt.detail.feedback,
      pending_review: assessment.type === AssessmentType.PROJECT,
      breakdown: attempt.detail.breakdown,
      flagged: attempt.flagged,
      terminated: attempt.terminated,
      termination_reason: attempt.detail.termination_reason,
    };
  }

  /** Grade a mixed MCQ + written quiz. Written answers are scored by the AI grader. */
  private async gradeQuiz(
    assessment: Assessment,
    attempt: AssessmentAttempt,
    body: { answers?: number[]; responses?: { index?: number; selected_index?: number | null; text?: string | null }[]; terminated?: boolean; termination_reason?: string },
  ) {
    const bank: any[] = assessment.config.questions ?? [];
    // The paper this attempt was served (subset + order); legacy attempts have the full bank in order.
    const order: number[] = Array.isArray(attempt.detail?.order) ? attempt.detail.order : bank.map((_, i) => i);
    const optionOrders: (number[] | null)[] = Array.isArray(attempt.detail?.option_orders) ? attempt.detail.option_orders : order.map(() => null);
    const questions = order.map((qi) => bank[qi]).filter(Boolean);

    // Normalize either the new responses[] shape or the legacy answers[] (MCQ
    // indices). `index` and `selected_index` are POSITIONS on the served paper;
    // selected options are mapped back to the bank's option order here.
    const responses: QuizResponse[] = questions.map(() => ({ selected_index: null, text: null }));
    const mapOption = (pos: number, sel: number | null) => {
      if (sel === null) return null;
      const oo = optionOrders[pos];
      return oo && Number.isInteger(oo[sel]) ? oo[sel] : sel;
    };
    if (Array.isArray(body.responses)) {
      for (const r of body.responses) {
        const i = Number(r?.index);
        if (!Number.isInteger(i) || i < 0 || i >= questions.length) continue;
        responses[i] = {
          selected_index: mapOption(i, Number.isInteger(r?.selected_index) ? Number(r!.selected_index) : null),
          text: typeof r?.text === 'string' ? r.text.slice(0, 10000) : null,
        };
      }
    } else if (Array.isArray(body.answers)) {
      if (body.answers.length !== questions.length && !body.terminated) {
        throw new BadRequestException(`Provide answers[] with ${questions.length} entries`);
      }
      body.answers.forEach((a, i) => {
        if (i < questions.length) responses[i] = { selected_index: mapOption(i, Number.isInteger(a) ? a : null), text: null };
      });
    } else if (!body.terminated) {
      throw new BadRequestException('Provide responses[] ({index, selected_index | text})');
    }

    // Written answers need the course title for grading context (one lookup, best-effort).
    let courseTitle = '';
    if (questions.some((q) => q?.kind === 'written')) {
      try {
        courseTitle = (await this.internal.get<{ title: string }>(`/api/v1/internal/courses/${assessment.course_id}`)).title;
      } catch {
        /* grading proceeds without it */
      }
    }

    let earned = 0;
    let total = 0;
    const breakdown: any[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const points = Number(q?.points) > 0 ? Number(q.points) : 1;
      total += points;
      if (q?.kind === 'written') {
        const text = responses[i].text?.trim() ?? '';
        if (!text) {
          breakdown.push({ index: i, kind: 'written', points, earned: 0, ai_score: 0, ai_feedback: 'No answer provided.' });
          continue;
        }
        let grade;
        try {
          grade = await this.ai.gradeWrittenAnswer(q.prompt, text, q.guidance, courseTitle);
        } catch (err) {
          this.logger.warn(`AI written grading failed, using offline grader: ${(err as Error).message}`);
          grade = await new MockAiAssessor().gradeWrittenAnswer(q.prompt, text, q.guidance);
        }
        const got = Math.round(points * (grade.score / 100) * 100) / 100;
        earned += got;
        breakdown.push({ index: i, kind: 'written', points, earned: got, ai_score: grade.score, ai_feedback: grade.feedback });
      } else {
        const correct = responses[i].selected_index === q.correct_index;
        if (correct) earned += points;
        breakdown.push({ index: i, kind: 'mcq', points, earned: correct ? points : 0, correct, selected_index: responses[i].selected_index });
      }
    }

    attempt.score = total > 0 ? Math.round((earned / total) * 100) : 0;

    // Server-side termination enforcement: the client auto-exits at the limit,
    // but the recorded violation log is authoritative.
    const terminated = !!body.terminated || this.maxViolationCount(attempt.proctor_log) >= PROCTOR_WARNING_LIMIT;
    attempt.terminated = terminated;
    attempt.passed = terminated ? false : attempt.score >= assessment.pass_score;
    attempt.detail = {
      ...attempt.detail,
      responses,
      breakdown,
      ...(terminated
        ? { termination_reason: body.termination_reason?.slice(0, 300) ?? 'Exam ended after repeated proctoring violations' }
        : {}),
    };
  }

  private maxViolationCount(log: { type: string }[]): number {
    const counts: Record<string, number> = {};
    for (const e of log ?? []) counts[e.type] = (counts[e.type] ?? 0) + 1;
    return Math.max(0, ...Object.values(counts));
  }

  // ---- Proctoring (spec: single-face + focus + tab/copy guards, 3-strike auto-exit) ----

  /** Learner client reports a proctoring violation (with a webcam snapshot) during an exam. */
  async recordProctorEvent(
    ctx: UserContext,
    attemptId: string,
    dto: { type: string; description: string; screenshot_base64?: string },
  ) {
    const attempt = await this.attempts.findOne({ where: { id: attemptId } });
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.learner_id !== ctx.id) throw new ForbiddenException('Not your attempt');
    if (attempt.submitted_at) throw new BadRequestException('Attempt already submitted');

    const type = (PROCTOR_EVENT_TYPES as readonly string[]).includes(dto.type) ? dto.type : 'other';

    let screenshotKey: string | null = null;
    if (dto.screenshot_base64) {
      const b64 = dto.screenshot_base64.replace(/^data:image\/\w+;base64,/, '');
      if (b64.length <= SCREENSHOT_BASE64_MAX) {
        try {
          const buf = Buffer.from(b64, 'base64');
          screenshotKey = `proctor/${attempt.id}/${Date.now()}.jpg`;
          await this.storage.putObject(screenshotKey, buf, 'image/jpeg');
        } catch (err) {
          this.logger.warn(`proctor screenshot upload failed: ${(err as Error).message}`);
          screenshotKey = null;
        }
      }
    }

    attempt.proctor_log = [
      ...(attempt.proctor_log ?? []),
      { type, description: dto.description.slice(0, 300), at: new Date().toISOString(), screenshot_key: screenshotKey },
    ];
    attempt.flagged = true;
    const count = attempt.proctor_log.filter((e) => e.type === type).length;
    if (count >= PROCTOR_WARNING_LIMIT) attempt.terminated = true;
    await this.attempts.save(attempt);

    return {
      recorded: true,
      type,
      count,
      remaining: Math.max(0, PROCTOR_WARNING_LIMIT - count),
      terminate: count >= PROCTOR_WARNING_LIMIT,
    };
  }

  /** Full proctoring report: violations with signed screenshot URLs + score breakdown. */
  async proctorReport(ctx: UserContext, attemptId: string) {
    const attempt = await this.attempts.findOne({ where: { id: attemptId } });
    if (!attempt) throw new NotFoundException('Attempt not found');
    const assessment = await this.assessmentOrThrow(attempt.assessment_id);

    if (attempt.learner_id !== ctx.id) {
      // Not the learner — must be course staff (owner/creator) or platform staff.
      if (![Role.PLATFORM_ADMIN, Role.QUALITY_OFFICER].includes(ctx.role as Role)) {
        const course = await this.courseRef(assessment.course_id);
        if (!(await this.canManageCourse(ctx, course))) throw new ForbiddenException('Not your attempt or course');
      }
    }

    const events = [];
    for (const e of attempt.proctor_log ?? []) {
      let url: string | null = null;
      if (e.screenshot_key) {
        try {
          url = (await this.storage.getSignedStreamUrl(e.screenshot_key, 900)).url;
        } catch {
          /* screenshot missing — report the event anyway */
        }
      }
      events.push({ type: e.type, description: e.description, at: e.at, screenshot_url: url });
    }
    return {
      attempt_id: attempt.id,
      flagged: attempt.flagged,
      terminated: attempt.terminated,
      termination_reason: attempt.detail?.termination_reason ?? null,
      score: attempt.score,
      passed: attempt.passed,
      submitted_at: attempt.submitted_at,
      warning_limit: PROCTOR_WARNING_LIMIT,
      events,
      breakdown: attempt.detail?.breakdown ?? null,
    };
  }

  /** Educator: all submitted attempts across a course's assessments (exam results view). */
  async courseAttempts(ctx: UserContext, courseId: string) {
    if (ctx.role !== Role.QUALITY_OFFICER && !(await this.canManageCourse(ctx, await this.courseRef(courseId)))) {
      throw new ForbiddenException('Not your course');
    }

    const courseAssessments = await this.assessments.find({ where: { course_id: courseId } });
    if (!courseAssessments.length) return [];
    const byId = new Map(courseAssessments.map((a) => [a.id, a]));
    const rows = await this.attempts
      .createQueryBuilder('a')
      .where('a.assessment_id IN (:...ids)', { ids: courseAssessments.map((a) => a.id) })
      .andWhere('(a.submitted_at IS NOT NULL OR a.flagged = true)')
      .orderBy('a.created_at', 'DESC')
      .getMany();

    // Resolve learner names once per learner (event-carried names aren't stored on attempts).
    const names = new Map<string, { name: string; email: string }>();
    for (const learnerId of new Set(rows.map((r) => r.learner_id))) {
      try {
        const u = await this.internal.get<{ name: string; email: string }>(`/api/v1/internal/users/${learnerId}`);
        names.set(learnerId, { name: u.name, email: u.email });
      } catch {
        names.set(learnerId, { name: 'Unknown learner', email: '' });
      }
    }

    return rows.map((r) => {
      const a = byId.get(r.assessment_id);
      return {
        attempt_id: r.id,
        assessment_id: r.assessment_id,
        assessment_type: a?.type,
        proctored: a?.type === AssessmentType.QUIZ ? !!a?.config?.proctored : false,
        learner_id: r.learner_id,
        learner_name: names.get(r.learner_id)?.name ?? 'Unknown',
        learner_email: names.get(r.learner_id)?.email ?? '',
        score: r.score,
        passed: r.passed,
        flagged: r.flagged,
        terminated: r.terminated,
        violation_count: (r.proctor_log ?? []).length,
        started_at: r.created_at,
        submitted_at: r.submitted_at,
      };
    });
  }

  /** Educator manually grades a project submission (spec §10.1). */
  async reviewAttempt(ctx: UserContext, attemptId: string, passed: boolean) {
    const attempt = await this.attempts.findOne({ where: { id: attemptId } });
    if (!attempt) throw new NotFoundException('Attempt not found');
    const assessment = await this.assessmentOrThrow(attempt.assessment_id);
    if (assessment.type !== AssessmentType.PROJECT) throw new BadRequestException('Only project submissions are manually reviewed');
    if (!(await this.canManageCourse(ctx, await this.courseRef(assessment.course_id)))) throw new ForbiddenException('Not your course');

    attempt.passed = passed;
    attempt.score = passed ? 100 : 0;
    await this.attempts.save(attempt);
    const learner = await this.internal.get<{ email: string }>(`/api/v1/internal/users/${attempt.learner_id}`);
    await this.publishResult(assessment, attempt, learner.email);
    return { attempt_id: attempt.id, passed };
  }

  /** Educator: list submitted project attempts awaiting review for a course. */
  async pendingProjects(ctx: UserContext, courseId: string) {
    if (!(await this.canManageCourse(ctx, await this.courseRef(courseId)))) throw new ForbiddenException('Not your course');
    const projectAssessments = await this.assessments.find({ where: { course_id: courseId, type: AssessmentType.PROJECT } });
    const out = [];
    for (const assessment of projectAssessments) {
      const rows = await this.attempts
        .createQueryBuilder('a')
        .where('a.assessment_id = :id', { id: assessment.id })
        .andWhere('a.submitted_at IS NOT NULL')
        .andWhere('a.passed IS NULL')
        .getMany();
      for (const attempt of rows) {
        const download = attempt.detail.file_key
          ? await this.storage.getSignedStreamUrl(attempt.detail.file_key, 900)
          : null;
        out.push({ attempt_id: attempt.id, learner_id: attempt.learner_id, submitted_at: attempt.submitted_at, download_url: download?.url ?? null });
      }
    }
    return out;
  }

  async myAttempts(ctx: UserContext, courseId?: string) {
    const rows = await this.attempts.find({ where: { learner_id: ctx.id }, order: { created_at: 'DESC' } });
    const out = [];
    for (const attempt of rows) {
      const assessment = await this.assessments.findOne({ where: { id: attempt.assessment_id } });
      if (courseId && assessment?.course_id !== courseId) continue;
      out.push({
        attempt_id: attempt.id,
        assessment_id: attempt.assessment_id,
        course_id: assessment?.course_id,
        type: assessment?.type,
        score: attempt.score,
        passed: attempt.passed,
        submitted_at: attempt.submitted_at,
        feedback: attempt.detail.feedback,
        flagged: attempt.flagged,
        terminated: attempt.terminated,
      });
    }
    return out;
  }

  /**
   * AI study coach: turn a submitted quiz attempt into a personalized review
   * plan grounded in the course outline. The learner sees "here's what to
   * revisit before you retry", pointing at real lessons. Falls back to the
   * offline coach if the AI is unavailable.
   */
  async studyPlan(ctx: UserContext, attemptId: string) {
    const attempt = await this.attempts.findOne({ where: { id: attemptId } });
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.learner_id !== ctx.id) throw new ForbiddenException('Not your attempt');
    if (!attempt.submitted_at) throw new BadRequestException('Finish the quiz first');
    const assessment = await this.assessmentOrThrow(attempt.assessment_id);
    if (assessment.type !== AssessmentType.QUIZ) throw new BadRequestException('Study plans are for quizzes');

    // The questions this learner got wrong, mapped back to the served paper.
    const breakdown: any[] = attempt.detail?.breakdown ?? [];
    const bank: any[] = assessment.config.questions ?? [];
    const order: number[] = Array.isArray(attempt.detail?.order) ? attempt.detail.order : bank.map((_, i) => i);
    const missed = breakdown
      .filter((b) => b.earned < b.points)
      .map((b) => {
        const q = bank[order[b.index]] ?? {};
        return { prompt: String(q.prompt ?? `Question ${b.index + 1}`).slice(0, 300), topic: q.topic ? String(q.topic) : undefined };
      });

    let courseTitle = 'this course';
    let outline: string[] = [];
    try {
      const course = await this.internal.get<{ title: string }>(`/api/v1/internal/courses/${assessment.course_id}`);
      courseTitle = course.title;
      outline = (await this.internal.get<{ outline: string[] }>(`/api/v1/internal/courses/${assessment.course_id}/outline`)).outline;
    } catch (err) {
      this.logger.warn(`study plan: outline lookup failed: ${(err as Error).message}`);
    }

    let plan;
    let aiLive = this.ai.isLive;
    try {
      plan = await this.ai.buildStudyPlan(courseTitle, attempt.score ?? 0, missed, outline);
    } catch (err) {
      this.logger.warn(`AI study plan failed, using offline coach: ${(err as Error).message}`);
      plan = await new MockAiAssessor().buildStudyPlan(courseTitle, attempt.score ?? 0, missed, outline);
      aiLive = false;
    }
    return { attempt_id: attempt.id, score: attempt.score, passed: attempt.passed, missed_count: missed.length, ai_live: aiLive, ...plan };
  }

  private async publishResult(assessment: Assessment, attempt: AssessmentAttempt, learnerEmail: string) {
    let learnerName = '';
    let courseTitle = '';
    let educatorId = '';
    let educatorName = '';
    try {
      const learner = await this.internal.get<{ name: string }>(`/api/v1/internal/users/${attempt.learner_id}`);
      learnerName = learner.name;
      const course = await this.internal.get<{ title: string; owner_id: string; owner_type: string }>(
        `/api/v1/internal/courses/${assessment.course_id}`,
      );
      courseTitle = course.title;
      educatorId = course.owner_id;
      const path = course.owner_type === 'institution' ? 'institutions' : 'educators';
      const owner = await this.internal.get<{ name: string }>(`/api/v1/internal/${path}/${course.owner_id}`);
      educatorName = owner.name;
    } catch (err) {
      this.logger.warn(`enrichment failed for assessment result: ${(err as Error).message}`);
    }
    const payload: AssessmentResultPayload = {
      assessment_id: assessment.id,
      attempt_id: attempt.id,
      assessment_type: assessment.type,
      enrollment_id: attempt.enrollment_id,
      learner_id: attempt.learner_id,
      learner_email: learnerEmail,
      learner_name: learnerName,
      course_id: assessment.course_id,
      course_title: courseTitle,
      educator_id: educatorId,
      educator_name: educatorName,
      score: attempt.score ?? 0,
      passed: !!attempt.passed,
    };
    await this.bus.publish(attempt.passed ? 'AssessmentPassed' : 'AssessmentFailed', payload);
  }

  /** Learner-safe paper for an attempt: served order, shuffled options, no answer key or guidance. */
  private quizAttemptView(assessment: Assessment, attempt: AssessmentAttempt) {
    const bank: any[] = assessment.config.questions ?? [];
    const order: number[] = Array.isArray(attempt.detail?.order) ? attempt.detail.order : bank.map((_, i) => i);
    const optionOrders: (number[] | null)[] = Array.isArray(attempt.detail?.option_orders) ? attempt.detail.option_orders : order.map(() => null);
    const questions = order.map((qi, pos) => {
      const q = bank[qi];
      const oo = optionOrders[pos];
      return {
        index: pos,
        kind: q.kind === 'written' ? 'written' : 'mcq',
        prompt: q.prompt,
        options: q.kind === 'written' ? undefined : oo ? oo.map((oi) => q.options[oi]) : q.options,
        points: Number(q.points) > 0 ? Number(q.points) : 1,
      };
    });
    const limit = assessment.config.time_limit_minutes ?? null;
    const deadline = limit ? new Date(attempt.created_at.getTime() + limit * 60_000) : null;
    return {
      attempt_id: attempt.id,
      type: assessment.type,
      questions,
      pass_score: assessment.pass_score,
      proctored: !!assessment.config.proctored,
      time_limit_minutes: limit,
      /** Server deadline — the client timer must count down to THIS, not to now+limit. */
      deadline_at: deadline,
      seconds_left: deadline ? Math.max(0, Math.floor((deadline.getTime() - Date.now()) / 1000)) : null,
      warning_limit: PROCTOR_WARNING_LIMIT,
      started_at: attempt.created_at,
      resumed: !!attempt.detail?.order && Date.now() - attempt.created_at.getTime() > 5_000,
    };
  }

  private timeLimitExpired(assessment: Assessment, attempt: AssessmentAttempt): boolean {
    const limit = Number(assessment.config.time_limit_minutes);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    return Date.now() > attempt.created_at.getTime() + limit * 60_000 + TIME_LIMIT_GRACE_SECONDS * 1000;
  }

  private courseRef(courseId: string): Promise<CourseRef> {
    return this.internal.get<CourseRef>(`/api/v1/internal/courses/${courseId}`);
  }

  /**
   * Who may manage a course's assessments: a platform admin, the course's
   * owner or instructor (created_by), or the admin of the institution that
   * owns it. Being an institution admin alone is not enough — any other
   * institution's admin must be refused.
   */
  private async canManageCourse(ctx: UserContext, course: CourseRef): Promise<boolean> {
    if (ctx.role === Role.PLATFORM_ADMIN) return true;
    if (course.owner_id === ctx.id || course.created_by === ctx.id) return true;
    if (ctx.role !== Role.INSTITUTION_ADMIN) return false;
    try {
      const institution = await this.internal.get<{ id: string }>(`/api/v1/internal/institutions/by-owner/${ctx.id}`);
      // Institution-owned courses carry the institution id as owner_id (owner_type 'institution').
      return institution.id === course.institution_id || institution.id === course.owner_id;
    } catch {
      return false; // no institution for this admin (404) — nothing to manage
    }
  }

  /** Pending assessments are visible to quality officers (they review them) and to course staff. */
  private async canSeePending(ctx: UserContext, courseId: string): Promise<boolean> {
    if (ctx.role === Role.QUALITY_OFFICER || ctx.role === Role.PLATFORM_ADMIN) return true;
    try {
      return await this.canManageCourse(ctx, await this.courseRef(courseId));
    } catch (err) {
      // The course service may be waking up; serve the learner view rather than fail the whole list.
      this.logger.warn(`include_pending check for course ${courseId} failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async withRetry(label: string, work: () => Promise<unknown>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await work();
        return;
      } catch (err) {
        const delay = REVISION_CLOSE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw err;
        this.logger.warn(`${label} failed (${(err as Error).message}); retrying in ${delay} ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async assessmentOrThrow(id: string): Promise<Assessment> {
    const assessment = await this.assessments.findOne({ where: { id } });
    if (!assessment) throw new NotFoundException('Assessment not found');
    return assessment;
  }

  private async entitlement(learnerId: string, courseId: string): Promise<EntitlementInfo> {
    const info = await this.internal.get<EntitlementInfo>(
      `/api/v1/internal/entitlements?learner_id=${learnerId}&course_id=${courseId}`,
    );
    if (info.entitlement_status !== EntitlementStatus.ACTIVE || !info.enrollment_id) {
      throw new ForbiddenException('No active entitlement for this course');
    }
    return info;
  }
}
