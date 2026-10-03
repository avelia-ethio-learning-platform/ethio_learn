import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { CurrentUser, InternalGuard, Roles, RolesGuard, UserContext, UuidParam } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { AnalyticsQuery } from './analytics-query.dto';
import { EnrollmentService } from './enrollment.service';

class EnrollDto {
  @IsUUID()
  course_id: string;
}

export class VideoProgressDto {
  @IsNumber()
  @Min(0)
  position_seconds: number;

  /** Client-reported length; a day is far beyond any lesson video. */
  @IsNumber()
  @Min(0)
  @Max(86_400)
  duration_seconds: number;
}

/** Optional final heartbeat sent with /complete (covers `ended` racing the last 10 s heartbeat). */
export class CompleteLessonDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  position_seconds?: number;
}

@Controller()
export class EnrollmentController {
  constructor(private readonly service: EnrollmentService) {}

  @Post('enrollments')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  enroll(@CurrentUser() ctx: UserContext, @Body() dto: EnrollDto) {
    return this.service.enrollFree(ctx, dto.course_id);
  }

  @Get('enrollments')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  list(@CurrentUser() ctx: UserContext) {
    return this.service.listForLearner(ctx);
  }

  /** NOTE: declared before enrollments/:id so "status" isn't captured as an id. */
  @Get('enrollments/status')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  status(@CurrentUser() ctx: UserContext, @Query('course_id') courseId: string) {
    if (!courseId) throw new BadRequestException('course_id is required');
    return this.service.status(ctx, courseId);
  }

  /** Educator / institution / admin funnel per course (ownership checked per id). Declared before :id. */
  @Get('enrollments/analytics')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  analytics(@CurrentUser() ctx: UserContext, @Query() query: AnalyticsQuery) {
    return this.service.analytics(ctx, query.course_ids);
  }

  @Get('admin/enrollments/analytics')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  adminAnalytics() {
    return this.service.adminAnalytics();
  }

  @Get('enrollments/:id')
  @UseGuards(RolesGuard)
  @Roles()
  detail(@CurrentUser() ctx: UserContext, @UuidParam('id') id: string) {
    return this.service.detail(ctx, id);
  }

  @Get('enrollments/:id/progress')
  @UseGuards(RolesGuard)
  @Roles()
  progress(@CurrentUser() ctx: UserContext, @UuidParam('id') id: string) {
    return this.service.progressDetail(ctx, id);
  }

  @Post('progress/lessons/:lessonId/complete')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  complete(@CurrentUser() ctx: UserContext, @UuidParam('lessonId') lessonId: string, @Body() dto: CompleteLessonDto) {
    return this.service.completeLesson(ctx, lessonId, dto.position_seconds);
  }

  @Post('progress/lessons/:lessonId/video')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  saveVideo(@CurrentUser() ctx: UserContext, @UuidParam('lessonId') lessonId: string, @Body() dto: VideoProgressDto) {
    return this.service.saveVideoProgress(ctx, lessonId, dto.position_seconds, dto.duration_seconds);
  }

  @Post('enrollments/:id/changelog-seen')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  changelogSeen(@CurrentUser() ctx: UserContext, @UuidParam('id') id: string) {
    return this.service.markChangelogSeen(ctx, id);
  }

  @Get('enrollments/:id/video-progress')
  @UseGuards(RolesGuard)
  @Roles()
  videoProgress(@CurrentUser() ctx: UserContext, @UuidParam('id') id: string) {
    return this.service.videoProgressDetail(ctx, id);
  }
}

@Controller('internal')
@UseGuards(InternalGuard)
export class EnrollmentInternalController {
  constructor(private readonly service: EnrollmentService) {}

  @Get('entitlements')
  entitlement(@Query('learner_id') learnerId: string, @Query('course_id') courseId: string) {
    if (!learnerId || !courseId) throw new BadRequestException('learner_id and course_id are required');
    return this.service.entitlement(learnerId, courseId);
  }

  @Get('enrollments/:id')
  byId(@UuidParam('id') id: string) {
    return this.service.internalById(id);
  }

  /** Active learners of a course (audience for course-update notifications). */
  @Get('courses/:id/learners')
  learners(@UuidParam('id') courseId: string) {
    return this.service.learnersForCourse(courseId);
  }
}
