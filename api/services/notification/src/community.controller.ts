import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CurrentUser, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { CommunityService } from './community.service';

class AddCommentDto {
  @IsString()
  @MaxLength(4000)
  body: string;

  @IsOptional()
  @IsUUID()
  parent_id?: string;
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
  list(@Param('id') courseId: string) {
    return this.service.listComments(courseId);
  }

  @Post('courses/:id/comments')
  @UseGuards(RolesGuard)
  @Roles()
  add(@CurrentUser() ctx: UserContext, @Param('id') courseId: string, @Body() dto: AddCommentDto) {
    return this.service.addComment(ctx, courseId, dto.body, dto.parent_id);
  }

  @Delete('comments/:id')
  @UseGuards(RolesGuard)
  @Roles()
  remove(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
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
  messages(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.threadMessages(ctx, id);
  }

  @Post('messages/threads/:id')
  @UseGuards(RolesGuard)
  @Roles()
  send(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: SendMessageDto) {
    return this.service.sendMessage(ctx, id, dto.body);
  }
}
