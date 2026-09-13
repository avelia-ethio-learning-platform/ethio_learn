import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, InternalHttpClient, Roles, RolesGuard, UserContext, userFromRequest } from '@ethiopialearn/common';
import { EntitlementStatus, Role } from '@ethiopialearn/contracts';
import { S3StorageProvider } from '@ethiopialearn/storage';
import { CourseService } from './course.service';
import { CourseExtrasService } from './course-extras.service';
import { CreateCourseDto, LessonInputDto, SectionInputDto, UpdateCourseDto, UpdateLessonDto, UploadRequestDto } from './dto';

class GenerateStructureDto {
  @IsString()
  @MaxLength(120)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(40000)
  source_text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  prompt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  section_count?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  lessons_per_section?: number;

  @IsOptional()
  @IsIn(['beginner', 'intermediate', 'advanced'])
  level?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  learning_style?: string;
}

class AppealDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  note: string;
}

class ApplyStructureDto {
  @ValidateNested({ each: true })
  @Type(() => SectionInputDto)
  sections: SectionInputDto[];
}

class ChangelogDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  summary: string;

  @IsOptional()
  major?: boolean;
}

class KnowledgeDto {
  @IsString()
  @MaxLength(200)
  title: string;

  @IsString()
  @MinLength(20)
  @MaxLength(200000)
  text: string;
}

class ChatDto {
  @IsString()
  @MinLength(2)
  @MaxLength(1500)
  question: string;
}

class InstitutionDecisionDto {
  @IsIn(['approve', 'reject'])
  action: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

@Controller()
export class CourseController {
  /** Per-learner stream-URL issuance window: deters account sharing / bulk scraping of signed URLs. */
  private readonly streamIssuance = new Map<string, number[]>();

  constructor(
    private readonly service: CourseService,
    private readonly extras: CourseExtrasService,
    private readonly storage: S3StorageProvider,
    private readonly internal: InternalHttpClient,
  ) {}

  // ---- Public catalog ----

  @Get('search')
  search(
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('pricing_type') pricingType?: string,
    @Query('sort') sort?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '12',
  ) {
    return this.service.search({ q, category, pricing_type: pricingType, sort, page: parseInt(page, 10), limit: parseInt(limit, 10) });
  }

  /** [PUBLIC] Top educators leaderboard (ranked by total rating points). */
  @Get('educators/top')
  topEducators(@Query('limit') limit = '12') {
    return this.service.topEducators(parseInt(limit, 10) || 12);
  }

  /** [PUBLIC] Educator profile: bio + published courses + rating aggregates. */
  @Get('educators/:id/profile')
  educatorProfile(@Param('id') id: string) {
    return this.service.educatorProfile(id);
  }

  @Get('courses/:id')
  publicDetail(@Param('id') id: string, @Req() req: any) {
    return this.service.publicDetail(id, userFromRequest(req));
  }

  // ---- Authoring (educator / institution_admin) ----

  @Get('courses')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  listOwn(@CurrentUser() ctx: UserContext) {
    return this.service.listOwn(ctx);
  }

  @Post('courses')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  create(@CurrentUser() ctx: UserContext, @Body() dto: CreateCourseDto) {
    return this.service.create(ctx, dto);
  }

  @Put('courses/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  update(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: UpdateCourseDto) {
    return this.service.update(ctx, id, dto);
  }

  @Post('courses/:id/submit')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  submit(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.submit(ctx, id);
  }

  @Post('courses/:id/withdraw')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  withdraw(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.withdraw(ctx, id);
  }

  @Post('courses/:id/unpublish')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  unpublish(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.unpublishOwn(ctx, id);
  }

  @Post('courses/:id/republish')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  republish(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.republishOwn(ctx, id);
  }

  @Post('courses/:id/appeal')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  appeal(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: AppealDto) {
    return this.service.appeal(ctx, id, dto.note);
  }

  @Post('courses/:id/duplicate')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  duplicate(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.duplicate(ctx, id);
  }

  @Post('courses/:id/archive')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  archiveOwn(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.archiveOwn(ctx, id);
  }

  @Post('courses/:id/restore')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  restoreOwn(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.restoreOwn(ctx, id);
  }

  // ---- Institution internal review + management (institution_admin) ----

  @Get('institution/review-queue')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTITUTION_ADMIN)
  institutionQueue(@CurrentUser() ctx: UserContext) {
    return this.service.institutionReviewQueue(ctx);
  }

  @Get('institution/courses')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTITUTION_ADMIN)
  institutionCourses(@CurrentUser() ctx: UserContext) {
    return this.service.institutionCourses(ctx);
  }

  @Post('institution/courses/:id/decision')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTITUTION_ADMIN)
  institutionDecide(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: InstitutionDecisionDto) {
    return this.service.institutionDecide(ctx, id, dto.action, dto.notes);
  }

  @Post('institution/courses/:id/unlist')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTITUTION_ADMIN)
  institutionUnlist(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.institutionTransition(ctx, id, 'unlist');
  }

  @Post('institution/courses/:id/restore')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTITUTION_ADMIN)
  institutionRestore(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.institutionTransition(ctx, id, 'restore');
  }

  /** AI-assisted outline from a prompt / pasted document (draft, not saved). */
  @Post('courses/generate-structure')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  generateStructure(@CurrentUser() ctx: UserContext, @Body() dto: GenerateStructureDto) {
    return this.service.generateStructure(ctx, dto);
  }

  @Put('lessons/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  updateLesson(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: UpdateLessonDto) {
    return this.service.updateLesson(ctx, id, dto);
  }

  @Delete('lessons/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  deleteLesson(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.deleteLesson(ctx, id);
  }

  @Delete('sections/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  deleteSection(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.deleteSection(ctx, id);
  }

  @Post('courses/:id/sections')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  addSection(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: SectionInputDto) {
    return this.service.addSection(ctx, id, dto);
  }

  /** Apply a full AI-generated outline (sections + lessons + summaries) in one call. */
  @Post('courses/:id/apply-structure')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  applyStructure(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: ApplyStructureDto) {
    return this.service.applyStructure(ctx, id, dto.sections);
  }

  @Post('sections/:id/lessons')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  addLesson(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: LessonInputDto) {
    return this.service.addLesson(ctx, id, dto);
  }

  /**
   * Signed PUT URL for direct-to-S3 uploads (video/thumbnail). Not a public
   * spec endpoint but required infrastructure for §7.2 ("thumbnail uploaded to
   * S3 before submission").
   */
  @Post('uploads')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  async requestUpload(@CurrentUser() ctx: UserContext, @Body() dto: UploadRequestDto) {
    const safeName = dto.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${dto.kind}s/${ctx.id}/${randomUUID()}-${safeName}`;
    const upload = await this.storage.getSignedUploadUrl(key, dto.content_type);
    return { upload_url: upload.url, key };
  }

  // ---- Playback (spec §0 rule 5: signed URL only, after entitlement check) ----

  @Get('lessons/:id/stream-url')
  @UseGuards(RolesGuard)
  @Roles()
  async streamUrl(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    const { lesson, section, course } = await this.service.lessonWithCourse(id);
    if (!lesson.video_s3_key) throw new ForbiddenException('Lesson has no video yet');

    const isOwner = course.owner_id === ctx.id || course.created_by === ctx.id;
    const isStaff = ctx.role === Role.QUALITY_OFFICER || ctx.role === Role.PLATFORM_ADMIN;
    let allowed = isOwner || isStaff || section.is_free_preview;

    if (!allowed) {
      // Server-side entitlement verification with Enrollment & Progress.
      try {
        const res = await this.internal.get<{ entitlement_status: string }>(
          `/api/v1/internal/entitlements?learner_id=${ctx.id}&course_id=${course.id}`,
        );
        allowed = res.entitlement_status === EntitlementStatus.ACTIVE;
      } catch {
        // Enrollment service may be sleeping on free tier — deny gracefully.
        throw new ForbiddenException('Could not verify enrollment. Please try again in a moment.');
      }
    }
    if (!allowed) throw new ForbiddenException('No active entitlement for this course');

    // Leak mitigation: at most STREAM_URLS_PER_MIN signed URLs per learner per
    // minute. A real viewer needs one per lesson; a scraper or a shared account
    // being watched from several devices at once trips this fast.
    const cap = Number(process.env.STREAM_URLS_PER_MIN ?? 8);
    const now = Date.now();
    const recent = (this.streamIssuance.get(ctx.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= cap) throw new ForbiddenException('Too many video requests — please wait a minute and try again');
    recent.push(now);
    this.streamIssuance.set(ctx.id, recent);
    if (this.streamIssuance.size > 5000) this.streamIssuance.clear();

    const signed = await this.storage.getSignedStreamUrl(lesson.video_s3_key, 900);
    // The player overlays this over the video: a screen recording carries the viewer's identity.
    return { ...signed, watermark: `${ctx.email || ctx.id} · ${new Date().toISOString().slice(0, 10)}` };
  }

  // ---- Change log (learners see it; owners write it) ----

  @Get('courses/:id/changelog')
  changelog(@Param('id') id: string) {
    return this.extras.listChangelog(id);
  }

  @Post('courses/:id/changelog')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  postChangelog(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: ChangelogDto) {
    return this.extras.postChangelog(ctx, id, dto.summary, !!dto.major);
  }

  // ---- Tutor knowledge base (owner) ----

  @Get('courses/:id/knowledge')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  listKnowledge(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.extras.listKnowledge(ctx, id);
  }

  @Post('courses/:id/knowledge')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  addKnowledge(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: KnowledgeDto) {
    return this.extras.addKnowledge(ctx, id, dto.title, dto.text);
  }

  @Post('courses/:id/knowledge/reindex')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  reindex(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.extras.reindexOwned(ctx, id);
  }

  @Delete('courses/:id/knowledge/:title')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  deleteKnowledge(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Param('title') title: string) {
    return this.extras.deleteKnowledge(ctx, id, decodeURIComponent(title));
  }

  // ---- Tutor chat (entitled learners) ----

  @Post('courses/:id/chat')
  @UseGuards(RolesGuard)
  @Roles()
  ask(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: ChatDto) {
    return this.extras.ask(ctx, id, dto.question);
  }

  @Get('courses/:id/chat')
  @UseGuards(RolesGuard)
  @Roles()
  chatHistory(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.extras.chatHistory(ctx, id);
  }

  @Get('courses/:id/chat/insights')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  chatInsights(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.extras.chatInsights(ctx, id);
  }

  // ---- Admin lifecycle overrides ----

  @Get('admin/courses')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  adminSearch(@Query('q') q = '') {
    return this.service.adminSearch(q);
  }

  @Post('admin/courses/:id/unlist')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  unlist(@Param('id') id: string) {
    return this.service.adminTransition(id, 'unlist');
  }

  @Post('admin/courses/:id/restore')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  restore(@Param('id') id: string) {
    return this.service.adminTransition(id, 'restore');
  }

  @Post('admin/courses/:id/archive')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  archive(@Param('id') id: string) {
    return this.service.adminTransition(id, 'archive');
  }
}
