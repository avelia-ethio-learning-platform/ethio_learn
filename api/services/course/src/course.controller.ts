import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, InternalHttpClient, Roles, RolesGuard, UserContext, userFromRequest } from '@ethiopialearn/common';
import { CourseStatus, EntitlementStatus, Role } from '@ethiopialearn/contracts';
import { S3StorageProvider } from '@ethiopialearn/storage';
import { CourseService, mergedLesson } from './course.service';
import { CourseExtrasService } from './course-extras.service';
import { RevisionService } from './revision.service';
import { CreateCourseDto, LessonInputDto, SectionInputDto, UpdateCourseDto, UpdateLessonDto, UpdateSectionDto } from './dto';

class GenerateStructureDto {
  @IsString()
  @MaxLength(120)
  title: string;

  // The web client condenses documents to a ~24k-char digest; this cap is the
  // server-side bound that keeps the body well under the JSON size limit.
  @IsOptional()
  @IsString()
  @MaxLength(30000, { message: 'source_text is too long (max 30,000 characters) — paste a shorter excerpt or the outline only.' })
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
  @IsArray()
  @ArrayMinSize(1, { message: 'The outline has no sections — add at least one section before applying it.' })
  @ArrayMaxSize(12, { message: 'An outline can have at most 12 sections — merge some sections and try again.' })
  @ValidateNested({ each: true })
  @Type(() => SectionInputDto)
  sections: SectionInputDto[];
}

/** Standalone change-log posts are minor; a `major` flag is stripped by the whitelist (it belongs to revision submit). */
class ChangelogDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  summary: string;
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

/**
 * The router has already decoded the path once; decode again for clients
 * that double-encode, but keep a title with a literal '%' (e.g. "100% notes")
 * as it is instead of failing with a 500 on the malformed escape.
 */
function decodeTitle(title: string): string {
  try {
    return decodeURIComponent(title);
  } catch {
    return title;
  }
}

@Controller()
export class CourseController {
  /** Per-learner stream-URL issuance window: deters account sharing / bulk scraping of signed URLs. */
  private readonly streamIssuance = new Map<string, number[]>();

  constructor(
    private readonly service: CourseService,
    private readonly revisions: RevisionService,
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

  /** The working copy the authoring page edits: live values overlaid with staged changes. */
  @Get('courses/:id/working')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  working(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.working(ctx, id);
  }

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
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
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
  async institutionQueue(@CurrentUser() ctx: UserContext) {
    const institutionId = await this.service.myInstitutionId(ctx);
    const [courses, revisions] = await Promise.all([
      this.service.institutionReviewQueue(institutionId),
      this.revisions.institutionQueueRows(institutionId),
    ]);
    return [...courses, ...revisions];
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
  async institutionDecide(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: InstitutionDecisionDto) {
    const course = await this.service.institutionCourseOrThrow(ctx, id);
    // A first-time submission is decided on the course itself; a live course's
    // staged update is decided on its open revision.
    if (course.status === CourseStatus.INSTITUTION_REVIEW) return this.service.institutionDecide(ctx, id, dto.action, dto.notes);
    if (await this.revisions.hasOpenInstitutionRevision(id)) return this.revisions.institutionDecideRevision(ctx, id, dto.action, dto.notes);
    throw new NotFoundException('Nothing from this course is awaiting institution review');
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
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  generateStructure(@CurrentUser() ctx: UserContext, @Body() dto: GenerateStructureDto) {
    return this.service.generateStructure(ctx, dto);
  }

  @Put('lessons/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  updateLesson(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: UpdateLessonDto) {
    return this.service.updateLesson(ctx, id, dto);
  }

  @Delete('lessons/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  deleteLesson(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.deleteLesson(ctx, id);
  }

  @Put('sections/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  updateSection(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: UpdateSectionDto) {
    return this.service.updateSection(ctx, id, dto);
  }

  @Delete('sections/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  deleteSection(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.deleteSection(ctx, id);
  }

  @Post('courses/:id/sections')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
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
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  addLesson(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: LessonInputDto) {
    return this.service.addLesson(ctx, id, dto);
  }

  // ---- Playback (spec §0 rule 5: signed URL only, after entitlement check) ----

  /**
   * Learners always get the approved (live) video. The owner and reviewers
   * (QO, platform admin, the course's institution admin) may pass
   * ?version=pending to preview a staged replacement before approval.
   */
  @Get('lessons/:id/stream-url')
  @UseGuards(RolesGuard)
  @Roles()
  async streamUrl(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Query('version') version?: string) {
    const { lesson, section, course } = await this.service.lessonWithCourse(id);
    const privileged = await this.service.isStaffFor(ctx, course);
    // A lesson added inside an unapproved revision does not exist for learners.
    if (!privileged && (lesson.pending_state === 'added' || section.pending_state === 'added')) {
      throw new NotFoundException('Lesson not available');
    }
    const key = privileged && version === 'pending' ? mergedLesson(lesson).video_s3_key : lesson.video_s3_key;
    if (!key) throw new ForbiddenException('Lesson has no video yet');

    // Free preview follows the LIVE flag only: a staged free-preview flip must
    // not open paid content before it is reviewed.
    let allowed = privileged || section.is_free_preview;

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
    // being watched from several devices at once trips this fast. Platform
    // staff are exempt: a reviewer scrubs through many lessons in a row.
    const platformStaff = ctx.role === Role.QUALITY_OFFICER || ctx.role === Role.PLATFORM_ADMIN;
    if (!platformStaff) {
      const cap = Number(process.env.STREAM_URLS_PER_MIN ?? 8);
      const now = Date.now();
      const recent = (this.streamIssuance.get(ctx.id) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= cap) throw new ForbiddenException('Too many video requests — please wait a minute and try again');
      recent.push(now);
      this.streamIssuance.set(ctx.id, recent);
      if (this.streamIssuance.size > 5000) this.streamIssuance.clear();
    }

    const signed = await this.storage.getSignedStreamUrl(key, 900);
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
    return this.extras.postChangelog(ctx, id, dto.summary);
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
    return this.service.addKnowledge(ctx, id, dto.title, dto.text);
  }

  @Post('courses/:id/knowledge/reindex')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  reindex(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.extras.reindexOwned(ctx, id);
  }

  /**
   * ?state=live|pending names which copy of a title to remove on an approved
   * course (a live note and its staged re-upload share the title). Without
   * it the pending copy goes first; the two are never removed together.
   */
  @Delete('courses/:id/knowledge/:title')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  deleteKnowledge(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Param('title') title: string, @Query('state') state?: string) {
    if (state !== undefined && state !== 'live' && state !== 'pending') {
      throw new BadRequestException("state must be 'live' or 'pending' (or left out to remove the pending copy first)");
    }
    return this.service.deleteKnowledge(ctx, id, decodeTitle(title), state);
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
