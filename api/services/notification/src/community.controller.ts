import { Body, Controller, Delete, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CurrentUser, limitQuery, Roles, RolesGuard, UserContext, UuidParam } from '@ethiopialearn/common';
import { CommunityService, MESSAGES_PAGE } from './community.service';

class AddCommentDto {
  @IsString()
  @MaxLength(4000)
  body: string;

  @IsOptional()
  @IsUUID()
  parent_id?: string;
}

/** Always `{ items, has_more }`. `paged=1` is still accepted: clients built for the old bare-array default send it. */
class CommentsQuery {
  @IsOptional()
  @IsIn(['1'])
  paged?: string;

  /** The oldest top-level comment id the client holds. */
  @IsOptional()
  @IsUUID()
  before?: string;
}

class MessagesQuery extends limitQuery({ defaultLimit: MESSAGES_PAGE, maxLimit: MESSAGES_PAGE }) {
  /** The oldest message id the client holds. */
  @IsOptional()
  @IsUUID()
  before?: string;
}

class OpenThreadDto {
  @IsUUID()
  recipient_id: string;
}

class SendMessageDto {
  @IsString()
  @MaxLength(4000)
  body: string;
}

@Controller()
export class CommunityController {
  constructor(private readonly service: CommunityService) {}

  // ---- Course discussion ----

  /** [PUBLIC] read the discussion under a course. */
  @Get('courses/:id/comments')
  list(@UuidParam('id') courseId: string, @Query() query: CommentsQuery) {
    return this.service.listComments(courseId, query.before);
  }

  @Post('courses/:id/comments')
  @UseGuards(RolesGuard)
  @Roles()
  add(@CurrentUser() ctx: UserContext, @UuidParam('id') courseId: string, @Body() dto: AddCommentDto) {
    return this.service.addComment(ctx, courseId, dto.body, dto.parent_id);
  }

  @Delete('comments/:id')
  @UseGuards(RolesGuard)
  @Roles()
  remove(@CurrentUser() ctx: UserContext, @UuidParam('id') id: string) {
    return this.service.deleteComment(ctx, id);
  }

  // ---- Direct messages ----

  @Get('messages/threads')
  @UseGuards(RolesGuard)
  @Roles()
  threads(@CurrentUser() ctx: UserContext) {
    return this.service.myThreads(ctx);
  }

  @Post('messages/threads')
  @UseGuards(RolesGuard)
  @Roles()
  open(@CurrentUser() ctx: UserContext, @Body() dto: OpenThreadDto) {
    return this.service.openThread(ctx, dto.recipient_id);
  }

  @Get('messages/unread-count')
  @UseGuards(RolesGuard)
  @Roles()
  unread(@CurrentUser() ctx: UserContext) {
    return this.service.unreadCount(ctx);
  }

  @Get('messages/threads/:id')
  @UseGuards(RolesGuard)
  @Roles()
  messages(@CurrentUser() ctx: UserContext, @UuidParam('id') id: string, @Query() query: MessagesQuery) {
    return this.service.threadMessages(ctx, id, query.before, query.limit);
  }

  @Post('messages/threads/:id')
  @UseGuards(RolesGuard)
  @Roles()
  send(@CurrentUser() ctx: UserContext, @UuidParam('id') id: string, @Body() dto: SendMessageDto) {
    return this.service.sendMessage(ctx, id, dto.body);
  }
}
