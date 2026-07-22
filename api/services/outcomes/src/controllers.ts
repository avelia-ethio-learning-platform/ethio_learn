import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { AssessmentType, Role } from '@ethiopialearn/contracts';
import { AssessmentService } from './assessment.service';
import { CertificateService } from './certificate.service';

class CreateAssessmentDto {
  @IsUUID()
  course_id: string;

  @IsEnum(AssessmentType)
  type: AssessmentType;

  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @IsOptional()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pass_score?: number;
}

class SubmitAttemptDto {
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  answers?: number[];

  /** Mixed-quiz shape: [{index, selected_index}] for MCQ, [{index, text}] for written. */
  @IsOptional()
  @IsArray()
  responses?: { index?: number; selected_index?: number | null; text?: string | null }[];

  @IsOptional()
  @IsString()
  answer?: string;

  @IsOptional()
  @IsString()
  file_key?: string;

  @IsOptional()
  @IsBoolean()
  terminated?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  termination_reason?: string;
}

class ProctorEventDto {
  @IsString()
  @MaxLength(40)
  type: string;

  @IsString()
  @MaxLength(500)
  description: string;

  /** Small JPEG thumbnail (data URI or bare base64), captured at the violation moment. */
  @IsOptional()
  @IsString()
  screenshot_base64?: string;
}

class ReviewAttemptDto {
  @IsBoolean()
  passed: boolean;
}

class GenerateQuizDto {
  @IsUUID()
  course_id: string;

  @IsString()
  @MaxLength(200)
  topic: string;

  @IsInt()
  @Min(1)
  @Max(20)
  count: number;

  @IsOptional()
  @IsString()
  difficulty?: string;
}

@Controller()
export class OutcomesController {
  constructor(
    private readonly assessmentService: AssessmentService,
    private readonly certificateService: CertificateService,
  ) {}

  // ---- Assessments ----

  @Post('assessments')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  create(@CurrentUser() ctx: UserContext, @Body() dto: CreateAssessmentDto) {
    return this.assessmentService.create(ctx, dto);
  }

  @Post('assessments/generate')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  generateQuiz(@CurrentUser() ctx: UserContext, @Body() dto: GenerateQuizDto) {
    return this.assessmentService.generateQuiz(ctx, dto.course_id, dto.topic, dto.count, dto.difficulty);
  }

  @Get('assessments')
  @UseGuards(RolesGuard)
  @Roles()
  list(@Query('course_id') courseId: string) {
    return this.assessmentService.listForCourse(courseId);
  }

  @Post('assessments/:id/attempts')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  startAttempt(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.assessmentService.startAttempt(ctx, id);
  }

  @Get('attempts/mine')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  myAttempts(@CurrentUser() ctx: UserContext, @Query('course_id') courseId?: string) {
    return this.assessmentService.myAttempts(ctx, courseId);
  }

  @Put('attempts/:id/submit')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  submit(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: SubmitAttemptDto) {
    return this.assessmentService.submitAttempt(ctx, id, dto);
  }

  @Put('attempts/:id/review')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  review(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: ReviewAttemptDto) {
    return this.assessmentService.reviewAttempt(ctx, id, dto.passed);
  }

  // ---- Proctoring ----

  @Post('attempts/:id/proctor-events')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  proctorEvent(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: ProctorEventDto) {
    return this.assessmentService.recordProctorEvent(ctx, id, dto);
  }

  /** Flag report with screenshots — learner (own attempt) or course/platform staff. */
  @Get('attempts/:id/proctor-report')
  @UseGuards(RolesGuard)
  @Roles()
  proctorReport(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.assessmentService.proctorReport(ctx, id);
  }

  /** Educator exam-results view: every submitted/flagged attempt on the course. */
  @Get('courses/:id/attempts')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN, Role.QUALITY_OFFICER)
  courseAttempts(@CurrentUser() ctx: UserContext, @Param('id') courseId: string) {
    return this.assessmentService.courseAttempts(ctx, courseId);
  }

  @Get('courses/:id/pending-projects')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  pendingProjects(@CurrentUser() ctx: UserContext, @Param('id') courseId: string) {
    return this.assessmentService.pendingProjects(ctx, courseId);
  }

  // ---- Certificates ----

  @Get('me/certificates')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  myCertificates(@CurrentUser() ctx: UserContext) {
    return this.certificateService.listForLearner(ctx.id);
  }

  @Get('me/certificates/:id/download')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  download(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.certificateService.downloadUrl(ctx.id, id);
  }

  /** [PUBLIC] spec §4.3: GET /certificates/:uid */
  @Get('certificates/:uid')
  certificate(@Param('uid') uid: string) {
    return this.certificateService.verify(uid);
  }

  /** [PUBLIC] spec §9.4: GET /verify/:certificate_uid */
  @Get('verify/:uid')
  verify(@Param('uid') uid: string) {
    return this.certificateService.verify(uid);
  }
}
