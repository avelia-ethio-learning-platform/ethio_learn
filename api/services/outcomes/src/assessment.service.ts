import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import { AiAssessor, MockAiAssessor, createAiAssessor } from '@ethiopialearn/ai';
import { AssessmentResultPayload, AssessmentType, EntitlementStatus, Role } from '@ethiopialearn/contracts';
import { S3StorageProvider } from '@ethiopialearn/storage';
import { Assessment, AssessmentAttempt } from './entities';

const PROJECT_MAX_BYTES = 50 * 1024 * 1024; // 50MB (spec §10.1)

/** Proctoring: violations of one type tolerated before the exam is force-ended. */
export const PROCTOR_WARNING_LIMIT = 3;
const PROCTOR_EVENT_TYPES = ['no_face', 'multiple_faces', 'tab_switch', 'copy_paste', 'other'] as const;
/** ~97KB binary — screenshots are captured client-side as small JPEG thumbnails. */
const SCREENSHOT_BASE64_MAX = 130_000;

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

@Injectable()
export class AssessmentService {
  private readonly logger = new Logger(AssessmentService.name);
  private readonly ai: AiAssessor = createAiAssessor();

  constructor(
    @InjectRepository(Assessment) private readonly assessments: Repository<Assessment>,
    @InjectRepository(AssessmentAttempt) private readonly attempts: Repository<AssessmentAttempt>,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
    private readonly storage: S3StorageProvider,
  ) {}

  async create(ctx: UserContext, dto: { course_id: string; type: AssessmentType; is_required?: boolean; config?: any; pass_score?: number }) {
    const course = await this.internal.get<{ owner_id: string; title: string }>(`/api/v1/internal/courses/${dto.course_id}`);
    if (ctx.role !== Role.PLATFORM_ADMIN && course.owner_id !== ctx.id && ctx.role !== Role.INSTITUTION_ADMIN) {
      throw new ForbiddenException('Not your course');
    }
    let config = dto.config ?? {};
    if (dto.type === AssessmentType.QUIZ) {
      const questions = this.validateQuizQuestions(config?.questions);
      const timeLimit = Number(config?.time_limit_minutes);
      config = {
        ...config,
        questions,
        proctored: !!config?.proctored,
        time_limit_minutes: Number.isFinite(timeLimit) && timeLimit >= 1 ? Math.min(Math.round(timeLimit), 240) : null,
      };
    }
    return this.assessments.save(
      this.assessments.create({
        course_id: dto.course_id,
        type: dto.type,
        is_required: dto.is_required ?? true,
        config,
        pass_score: dto.pass_score ?? 60,
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
    const course = await this.internal.get<{ owner_id: string }>(`/api/v1/internal/courses/${courseId}`);
    if (ctx.role !== Role.PLATFORM_ADMIN && course.owner_id !== ctx.id && ctx.role !== Role.INSTITUTION_ADMIN) {
      throw new ForbiddenException('Not your course');
    }
    const questions = await this.ai.generateQuiz(topic, count, difficulty);
    return { questions, ai_live: this.ai.isLive };
  }

  /** Learner-safe listing: quiz answers stripped. */
  async listForCourse(courseId: string) {
    const rows = await this.assessments.find({ where: { course_id: courseId } });
    return rows.map((a) => {
      const questions: any[] = a.config.questions ?? [];
      return {
        id: a.id,
        course_id: a.course_id,
        type: a.type,
        is_required: a.is_required,
        pass_score: a.pass_score,
        question_count: a.type === AssessmentType.QUIZ ? questions.length : undefined,
        written_count: a.type === AssessmentType.QUIZ ? questions.filter((q) => q?.kind === 'written').length : undefined,
        proctored: a.type === AssessmentType.QUIZ ? !!a.config.proctored : undefined,
        time_limit_minutes: a.type === AssessmentType.QUIZ ? (a.config.time_limit_minutes ?? null) : undefined,
      };
    });
  }

  async startAttempt(ctx: UserContext, assessmentId: string) {
    const assessment = await this.assessmentOrThrow(assessmentId);
    const entitlement = await this.entitlement(ctx.id, assessment.course_id);

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
      // Learner-safe view: correct_index and marking guidance stripped.
      const questions = (assessment.config.questions ?? []).map((q: any, i: number) => ({
        index: i,
        kind: q.kind === 'written' ? 'written' : 'mcq',
        prompt: q.prompt,
        options: q.kind === 'written' ? undefined : q.options,
        points: Number(q.points) > 0 ? Number(q.points) : 1,
      }));
      return {
        attempt_id: attempt.id,
        type: assessment.type,
        questions,
        pass_score: assessment.pass_score,
        proctored: !!assessment.config.proctored,
        time_limit_minutes: assessment.config.time_limit_minutes ?? null,
        warning_limit: PROCTOR_WARNING_LIMIT,
        started_at: attempt.created_at,
      };
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
      file_key?: string;
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
      await this.gradeQuiz(assessment, attempt, body);
    } else if (assessment.type === AssessmentType.AI_VIVA) {
      if (!body.answer?.trim()) throw new BadRequestException('answer is required');
      const evaluation = await this.ai.evaluateVivaAnswer(attempt.detail.question ?? '', body.answer);
      attempt.score = evaluation.score;
      attempt.passed = evaluation.score >= assessment.pass_score;
      attempt.detail = { ...attempt.detail, answer: body.answer, feedback: evaluation.feedback };
    } else {
      // project — recorded, graded manually by the educator
      attempt.detail = { ...attempt.detail, file_key: body.file_key ?? attempt.detail.file_key };
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
    const questions: any[] = assessment.config.questions ?? [];

    // Normalize either the new responses[] shape or the legacy answers[] (MCQ indices).
    const responses: QuizResponse[] = questions.map((_, i) => ({ selected_index: null, text: null }));
    if (Array.isArray(body.responses)) {
      for (const r of body.responses) {
        const i = Number(r?.index);
        if (!Number.isInteger(i) || i < 0 || i >= questions.length) continue;
        responses[i] = {
          selected_index: Number.isInteger(r?.selected_index) ? Number(r!.selected_index) : null,
          text: typeof r?.text === 'string' ? r.text.slice(0, 10000) : null,
        };
      }
    } else if (Array.isArray(body.answers)) {
      if (body.answers.length !== questions.length && !body.terminated) {
        throw new BadRequestException(`Provide answers[] with ${questions.length} entries`);
      }
      body.answers.forEach((a, i) => {
        if (i < questions.length) responses[i] = { selected_index: Number.isInteger(a) ? a : null, text: null };
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
        const course = await this.internal.get<{ owner_id: string; created_by: string }>(
          `/api/v1/internal/courses/${assessment.course_id}`,
        );
        const isCourseStaff = [course.owner_id, course.created_by].includes(ctx.id) || ctx.role === Role.INSTITUTION_ADMIN;
        if (!isCourseStaff) throw new ForbiddenException('Not your attempt or course');
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
    const course = await this.internal.get<{ owner_id: string; created_by: string }>(`/api/v1/internal/courses/${courseId}`);
    const allowed =
      [Role.PLATFORM_ADMIN, Role.QUALITY_OFFICER].includes(ctx.role as Role) ||
      [course.owner_id, course.created_by].includes(ctx.id) ||
      ctx.role === Role.INSTITUTION_ADMIN;
    if (!allowed) throw new ForbiddenException('Not your course');

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
    const course = await this.internal.get<{ owner_id: string }>(`/api/v1/internal/courses/${assessment.course_id}`);
    if (ctx.role !== Role.PLATFORM_ADMIN && course.owner_id !== ctx.id) throw new ForbiddenException('Not your course');

    attempt.passed = passed;
    attempt.score = passed ? 100 : 0;
    await this.attempts.save(attempt);
    const learner = await this.internal.get<{ email: string }>(`/api/v1/internal/users/${attempt.learner_id}`);
    await this.publishResult(assessment, attempt, learner.email);
    return { attempt_id: attempt.id, passed };
  }

  /** Educator: list submitted project attempts awaiting review for a course. */
  async pendingProjects(ctx: UserContext, courseId: string) {
    const course = await this.internal.get<{ owner_id: string }>(`/api/v1/internal/courses/${courseId}`);
    if (ctx.role !== Role.PLATFORM_ADMIN && course.owner_id !== ctx.id) throw new ForbiddenException('Not your course');
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
