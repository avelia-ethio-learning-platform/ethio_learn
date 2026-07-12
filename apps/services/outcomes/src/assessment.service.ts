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
import { AiAssessor, createAiAssessor } from '@ethiopialearn/ai';
import { AssessmentResultPayload, AssessmentType, EntitlementStatus, Role } from '@ethiopialearn/contracts';
import { S3StorageProvider } from '@ethiopialearn/storage';
import { Assessment, AssessmentAttempt } from './entities';

const PROJECT_MAX_BYTES = 50 * 1024 * 1024; // 50MB (spec §10.1)

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
    if (dto.type === AssessmentType.QUIZ) {
      const questions = dto.config?.questions;
      if (!Array.isArray(questions) || questions.length === 0) {
        throw new BadRequestException('Quiz requires config.questions[] with prompt, options, correct_index');
      }
    }
    return this.assessments.save(
      this.assessments.create({
        course_id: dto.course_id,
        type: dto.type,
        is_required: dto.is_required ?? true,
        config: dto.config ?? {},
        pass_score: dto.pass_score ?? 60,
      }),
    );
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
    return rows.map((a) => ({
      id: a.id,
      course_id: a.course_id,
      type: a.type,
      is_required: a.is_required,
      pass_score: a.pass_score,
      question_count: a.type === AssessmentType.QUIZ ? (a.config.questions?.length ?? 0) : undefined,
    }));
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
      const questions = (assessment.config.questions ?? []).map((q: any, i: number) => ({
        index: i,
        prompt: q.prompt,
        options: q.options,
      }));
      return { attempt_id: attempt.id, type: assessment.type, questions };
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

  async submitAttempt(ctx: UserContext, attemptId: string, body: { answers?: number[]; answer?: string; file_key?: string }) {
    const attempt = await this.attempts.findOne({ where: { id: attemptId } });
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.learner_id !== ctx.id) throw new ForbiddenException('Not your attempt');
    if (attempt.submitted_at) throw new BadRequestException('Attempt already submitted');
    const assessment = await this.assessmentOrThrow(attempt.assessment_id);

    if (assessment.type === AssessmentType.QUIZ) {
      const questions = assessment.config.questions ?? [];
      if (!Array.isArray(body.answers) || body.answers.length !== questions.length) {
        throw new BadRequestException(`Provide answers[] with ${questions.length} entries`);
      }
      const correct = questions.filter((q: any, i: number) => q.correct_index === body.answers![i]).length;
      attempt.score = Math.round((correct / questions.length) * 100);
      attempt.passed = attempt.score >= assessment.pass_score;
      attempt.detail = { ...attempt.detail, answers: body.answers };
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
    };
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
