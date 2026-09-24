import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { UploadService } from './upload.service';
import { CompleteMultipartUploadDto, CreateMultipartUploadDto, CreateUploadDto, SignPartsDto } from './upload.dto';

/**
 * Direct-to-storage uploads (videos, thumbnails, photos). Kept under
 * /uploads, not /courses: the web service worker caches GET /courses/*
 * responses, and upload status must always be fresh.
 */
@Controller('uploads')
@UseGuards(RolesGuard)
@Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
export class UploadController {
  constructor(private readonly uploads: UploadService) {}

  /**
   * Single presigned PUT (thumbnails, photos, videos up to 16 MB) with the
   * exact size and Content-Type signed in. A video's optional lesson_id is
   * checked now and keys the file under the course author, as multipart does.
   */
  @Post()
  createSmall(@CurrentUser() ctx: UserContext, @Body() dto: CreateUploadDto) {
    return this.uploads.createSmall(ctx, dto);
  }

  /** Starts a resumable video upload; attaching to lesson_id is checked now, before any bytes move. */
  @Post('multipart')
  createMultipart(@CurrentUser() ctx: UserContext, @Body() dto: CreateMultipartUploadDto) {
    return this.uploads.createMultipart(ctx, dto);
  }

  /** The caller's unfinished uploads, optionally for one lesson. */
  @Get('multipart')
  listOpen(@CurrentUser() ctx: UserContext, @Query('lesson_id') lessonId?: string) {
    return this.uploads.listOpen(ctx, lessonId || undefined);
  }

  @Get('multipart/:id')
  status(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.uploads.status(ctx, id);
  }

  /** Presigned part URLs, up to 100 per call. */
  @Post('multipart/:id/parts')
  signParts(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: SignPartsDto) {
    return this.uploads.signParts(ctx, id, dto);
  }

  /** Verifies every part server-side, completes the upload and attaches it to the lesson. Idempotent. */
  @Post('multipart/:id/complete')
  complete(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: CompleteMultipartUploadDto) {
    return this.uploads.complete(ctx, id, dto);
  }

  @Delete('multipart/:id')
  abort(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.uploads.abort(ctx, id);
  }
}
