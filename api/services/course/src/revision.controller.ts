import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { RevisionService } from './revision.service';

class SubmitRevisionDto {
  /** Change-log text learners see once the update is live. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  summary?: string;

  /** Major = enrolled learners are notified when the update goes live. */
  @IsOptional()
  @IsBoolean()
  major?: boolean;
}

/** Staged changes to a live course: review diff, submit, withdraw, discard. */
@Controller()
export class RevisionController {
  constructor(private readonly revisions: RevisionService) {}

  /** Owner, QO, platform admin or the course's institution admin (checked in the service). */
  @Get('courses/:id/revisions/current/diff')
  @UseGuards(RolesGuard)
  @Roles()
  currentDiff(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.revisions.currentDiff(ctx, id);
  }

  @Post('courses/:id/revisions/submit')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  submit(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: SubmitRevisionDto) {
    return this.revisions.submit(ctx, id, dto);
  }

  @Post('courses/:id/revisions/withdraw')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  withdraw(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.revisions.withdraw(ctx, id);
  }

  @Post('courses/:id/revisions/discard')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  discard(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.revisions.discard(ctx, id);
  }
}
