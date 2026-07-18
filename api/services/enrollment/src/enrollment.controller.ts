import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsNumber, IsUUID, Min } from 'class-validator';
import { CurrentUser, InternalGuard, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { EnrollmentService } from './enrollment.service';

class EnrollDto {
  @IsUUID()
  course_id: string;
}

class VideoProgressDto {
  @IsNumber()
  @Min(0)
  position_seconds: number;

  @IsNumber()
  @Min(0)
  duration_seconds: number;
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

  @Get('enrollments/:id')
  @UseGuards(RolesGuard)
  @Roles()
  detail(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.detail(ctx, id);
  }

  @Get('enrollments/:id/progress')
  @UseGuards(RolesGuard)
  @Roles()
  progress(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.progressDetail(ctx, id);
  }

  @Post('progress/lessons/:lessonId/complete')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  complete(@CurrentUser() ctx: UserContext, @Param('lessonId') lessonId: string) {
    return this.service.completeLesson(ctx, lessonId);
  }

  @Post('progress/lessons/:lessonId/video')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  saveVideo(@CurrentUser() ctx: UserContext, @Param('lessonId') lessonId: string, @Body() dto: VideoProgressDto) {
    return this.service.saveVideoProgress(ctx, lessonId, dto.position_seconds, dto.duration_seconds);
  }

  @Get('enrollments/:id/video-progress')
  @UseGuards(RolesGuard)
  @Roles()
  videoProgress(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
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
  byId(@Param('id') id: string) {
    return this.service.internalById(id);
  }
}
