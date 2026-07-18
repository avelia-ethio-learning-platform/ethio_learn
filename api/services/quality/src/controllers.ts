import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, InternalGuard, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { FraudSubjectType, QaDecisionAction, Role, TrustTier } from '@ethiopialearn/contracts';
import { QualityService } from './quality.service';

class QaDecisionDto {
  @IsEnum(QaDecisionAction)
  action: QaDecisionAction;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

class ReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

class FraudSignalDto {
  @IsEnum(FraudSubjectType)
  subject_type: FraudSubjectType;

  @IsUUID()
  subject_id: string;

  @IsString()
  @MaxLength(80)
  signal_type: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  detail?: string;

  @IsOptional()
  @IsUUID()
  payee_id?: string;
}

@Controller()
export class QualityController {
  constructor(private readonly service: QualityService) {}

  // ---- QO workflow ----

  @Get('qa/queue')
  @UseGuards(RolesGuard)
  @Roles(Role.QUALITY_OFFICER, Role.PLATFORM_ADMIN)
  queue() {
    return this.service.queue();
  }

  @Get('qa/courses/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.QUALITY_OFFICER, Role.PLATFORM_ADMIN)
  reviewDetail(@Param('id') courseId: string) {
    return this.service.reviewDetail(courseId);
  }

  @Post('qa/courses/:id/decision')
  @UseGuards(RolesGuard)
  @Roles(Role.QUALITY_OFFICER, Role.PLATFORM_ADMIN)
  decide(@CurrentUser() ctx: UserContext, @Param('id') courseId: string, @Body() dto: QaDecisionDto) {
    return this.service.decide(ctx, courseId, dto.action, dto.notes);
  }

  // ---- Ratings & reviews ----

  @Post('courses/:id/reviews')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  addReview(@CurrentUser() ctx: UserContext, @Param('id') courseId: string, @Body() dto: ReviewDto) {
    return this.service.addReview(ctx, courseId, dto.rating, dto.comment);
  }

  /** [PUBLIC] */
  @Get('courses/:id/reviews')
  listReviews(@Param('id') courseId: string) {
    return this.service.listReviews(courseId);
  }

  /** [PUBLIC] trust badge shown on catalog/detail pages */
  @Get('educators/:id/trust-tier')
  trustTier(@Param('id') educatorId: string) {
    return this.service.trustTier(educatorId);
  }

  // ---- Fraud (spec §4.3) ----

  @Post('fraud/signals')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN, Role.QUALITY_OFFICER)
  raiseSignal(@Body() dto: FraudSignalDto) {
    return this.service.raiseFraudSignal({
      subject_type: dto.subject_type,
      subject_id: dto.subject_id,
      signal_type: dto.signal_type,
      detail: dto.detail ?? '',
      payee_id: dto.payee_id ?? null,
    });
  }

  @Get('fraud/flags')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  flags(@Query('status') status?: string) {
    return this.service.listFlags(status);
  }

  @Post('fraud/flags/:id/resolve')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  resolve(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.service.resolveFlag(ctx.id, id);
  }
}

@Controller('internal')
@UseGuards(InternalGuard)
export class QualityInternalController {
  constructor(private readonly service: QualityService) {}

  /** Authoritative trust tier (Quality & Trust owns educator_trust_tiers). */
  @Get('educators/:id/trust-tier')
  async trustTier(@Param('id') educatorId: string): Promise<{ tier: TrustTier }> {
    const res = await this.service.trustTier(educatorId);
    return { tier: res.tier };
  }
}
