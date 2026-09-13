import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { GrowthService } from './growth.service';
import { PaymentService } from './payment.service';
import { SponsorshipService } from './sponsorship.service';

class CreateCouponDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  code?: string;

  @IsIn(['percent', 'amount'])
  kind: 'percent' | 'amount';

  @IsNumber()
  @Min(0.01)
  value: number;

  @IsOptional()
  @IsUUID()
  course_id?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  max_uses?: number;

  @IsOptional()
  @IsString()
  expires_at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

class TopUpDto {
  @IsNumber()
  @Min(50)
  @Max(50000)
  amount_etb: number;
}

class AdjustDto {
  @IsUUID()
  user_id: string;

  @IsNumber()
  amount_etb: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

class InviteDto {
  @IsArray()
  @ArrayMaxSize(20)
  @IsEmail({}, { each: true })
  emails: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @IsOptional()
  @IsIn(['learner', 'educator', 'institution_admin'])
  role_hint?: string;
}

class ClaimDto {
  @IsString()
  @MaxLength(16)
  code: string;
}

class GiftDto {
  @IsUUID()
  course_id: string;

  @IsEmail()
  recipient_email: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  coupon_code?: string;

  @IsOptional()
  @IsBoolean()
  use_wallet?: boolean;
}

class PayRequestDto {
  @IsUUID()
  course_id: string;

  @IsEmail()
  payer_email: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}

class PayDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  coupon_code?: string;

  @IsOptional()
  @IsBoolean()
  use_wallet?: boolean;
}

class BulkQuoteDto {
  @IsUUID()
  course_id: string;

  @IsInt()
  @Min(2)
  @Max(5000)
  @Type(() => Number)
  seats: number;
}

class BulkCreateDto extends BulkQuoteDto {
  @IsString()
  @MaxLength(120)
  organization_name: string;

  @IsOptional()
  @IsBoolean()
  use_wallet?: boolean;
}

class AssignDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsEmail({}, { each: true })
  emails: string[];
}

/** Coupons, wallet, referrals, gifts, pay requests and bulk purchases. */
@Controller()
@UseGuards(RolesGuard)
export class GrowthController {
  constructor(
    private readonly growth: GrowthService,
    private readonly payments: PaymentService,
    private readonly sponsorships: SponsorshipService,
  ) {}

  // ---- Coupons ----

  @Post('coupons')
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  createCoupon(@CurrentUser() ctx: UserContext, @Body() dto: CreateCouponDto) {
    return this.growth.createCoupon(ctx, dto);
  }

  @Get('coupons')
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  listCoupons(@CurrentUser() ctx: UserContext) {
    return this.growth.listCoupons(ctx);
  }

  @Post('coupons/:id/deactivate')
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  deactivate(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.growth.deactivateCoupon(ctx, id);
  }

  /** Learner previews a code at checkout: "SAVE20 → 20% off, pay 400 ETB". */
  @Get('coupons/validate')
  @Roles()
  validate(@Query('code') code: string, @Query('course_id') courseId: string) {
    return this.growth.previewCoupon(code ?? '', courseId ?? '');
  }

  // ---- Wallet ----

  @Get('wallet')
  @Roles()
  wallet(@CurrentUser() ctx: UserContext) {
    return this.growth.wallet(ctx.id);
  }

  @Post('wallet/topup')
  @Roles()
  topUp(@CurrentUser() ctx: UserContext, @Body() dto: TopUpDto) {
    return this.payments.topUpWallet(ctx, dto.amount_etb);
  }

  @Post('admin/wallet/adjust')
  @Roles(Role.PLATFORM_ADMIN)
  adjust(@CurrentUser() ctx: UserContext, @Body() dto: AdjustDto) {
    return this.growth.adminAdjust(ctx.id, dto.user_id, dto.amount_etb, dto.note ?? '');
  }

  // ---- Referrals ----

  @Get('referrals/me')
  @Roles()
  myReferral(@CurrentUser() ctx: UserContext) {
    return this.growth.myReferral(ctx);
  }

  @Post('referrals/invite')
  @Roles()
  invite(@CurrentUser() ctx: UserContext, @Body() dto: InviteDto) {
    return this.growth.invite(ctx, dto.emails, dto.message ?? '', dto.role_hint ?? 'learner');
  }

  @Post('referrals/claim')
  @Roles()
  claim(@CurrentUser() ctx: UserContext, @Body() dto: ClaimDto) {
    return this.growth.claim(ctx, dto.code);
  }

  // ---- Gifts & pay requests ----

  @Post('gifts')
  @Roles()
  gift(@CurrentUser() ctx: UserContext, @Body() dto: GiftDto) {
    return this.sponsorships.createGift(ctx, dto);
  }

  @Post('pay-requests')
  @Roles(Role.LEARNER)
  payRequest(@CurrentUser() ctx: UserContext, @Body() dto: PayRequestDto) {
    return this.sponsorships.createPayRequest(ctx, dto);
  }

  /** [PUBLIC] landing data for the "someone asked you to pay" page. */
  @Get('pay-requests/:token')
  payRequestPublic(@Param('token') token: string) {
    return this.sponsorships.payRequestPublic(token);
  }

  @Post('pay-requests/:token/pay')
  @Roles()
  pay(@CurrentUser() ctx: UserContext, @Param('token') token: string, @Body() dto: PayDto) {
    return this.sponsorships.payRequest(ctx, token, dto);
  }

  @Get('sponsorships/mine')
  @Roles()
  mine(@CurrentUser() ctx: UserContext) {
    return this.sponsorships.mine(ctx);
  }

  @Post('sponsorships/claim')
  @Roles()
  claimSeats(@CurrentUser() ctx: UserContext) {
    return this.sponsorships.claimMine(ctx);
  }

  // ---- Bulk / corporate ----

  @Post('bulk-purchases/quote')
  @Roles()
  quote(@Body() dto: BulkQuoteDto) {
    return this.sponsorships.quoteBulk(dto.course_id, dto.seats);
  }

  @Post('bulk-purchases')
  @Roles()
  createBulk(@CurrentUser() ctx: UserContext, @Body() dto: BulkCreateDto) {
    return this.sponsorships.createBulk(ctx, dto);
  }

  @Get('bulk-purchases/mine')
  @Roles()
  listBulk(@CurrentUser() ctx: UserContext) {
    return this.sponsorships.listBulk(ctx);
  }

  @Post('bulk-purchases/:id/assign')
  @Roles()
  assign(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: AssignDto) {
    return this.sponsorships.assignSeats(ctx, id, dto.emails);
  }

  // ---- Analytics ----

  @Get('payouts/analytics')
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  async payeeAnalytics(@CurrentUser() ctx: UserContext) {
    return this.payments.payeeAnalytics(await this.growth.ownerIdsFor(ctx));
  }

  @Get('admin/analytics/financial')
  @Roles(Role.PLATFORM_ADMIN)
  adminAnalytics() {
    return this.payments.adminAnalytics();
  }
}
