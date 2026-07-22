import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';
import { PayoutService } from './payout.service';

class InitiateDto {
  @IsUUID()
  course_id: string;
}

class MockCompleteDto {
  @IsString()
  tx_ref: string;

  @IsIn(['success', 'failed'])
  outcome: 'success' | 'failed';
}

class ReconcileDto {
  @IsString()
  @MaxLength(64)
  tx_ref: string;
}

class BankTransferDto {
  @IsUUID()
  learner_id: string;

  @IsUUID()
  course_id: string;
}

class RefundRequestDto {
  @IsUUID()
  payment_id: string;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason: string;
}

class RefundDecisionDto {
  @IsIn(['approve', 'deny'])
  action: 'approve' | 'deny';
}

@Controller()
export class FinancialController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly refundService: RefundService,
    private readonly payoutService: PayoutService,
  ) {}

  // ---- Payments (spec §9.3) ----

  @Post('payments/initiate')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  initiate(@CurrentUser() ctx: UserContext, @Body() dto: InitiateDto) {
    return this.paymentService.initiate(ctx, dto.course_id);
  }

  /**
   * [PUBLIC — HMAC verified] Always returns 200: Chapa retries on non-200 and
   * a forged webhook should not learn anything from the status code.
   */
  @Post('payments/webhook/chapa')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('chapa-signature') chapaSignature?: string,
    @Headers('x-chapa-signature') xChapaSignature?: string,
  ) {
    const raw = req.rawBody;
    if (!raw) return { received: true };
    await this.paymentService.handleWebhook(raw, chapaSignature ?? xChapaSignature);
    return { received: true };
  }

  /** DEV-ONLY mock checkout completion (403 unless CHAPA_MODE=mock). */
  @Post('payments/mock/complete')
  @HttpCode(200)
  mockComplete(@Body() dto: MockCompleteDto) {
    return this.paymentService.mockComplete(dto.tx_ref, dto.outcome);
  }

  /**
   * Webhook fallback: the learner asks the SERVER to check a pending payment
   * with Chapa's verify API. The browser proves nothing — confirmation only
   * happens after our own server-side verification (same rules as the webhook).
   */
  @Post('payments/reconcile')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  reconcile(@CurrentUser() ctx: UserContext, @Body() dto: ReconcileDto) {
    return this.paymentService.reconcile(ctx, dto.tx_ref);
  }

  @Get('payments/mine')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  myPayments(@CurrentUser() ctx: UserContext) {
    return this.paymentService.listMine(ctx);
  }

  @Get('payments/:id')
  @UseGuards(RolesGuard)
  @Roles()
  payment(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.paymentService.detail(ctx, id);
  }

  // ---- Refunds (spec §10.4) ----

  @Post('refunds')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  requestRefund(@CurrentUser() ctx: UserContext, @Body() dto: RefundRequestDto) {
    return this.refundService.request(ctx, dto.payment_id, dto.reason);
  }

  @Get('refunds/mine')
  @UseGuards(RolesGuard)
  @Roles(Role.LEARNER)
  myRefunds(@CurrentUser() ctx: UserContext) {
    return this.refundService.listMine(ctx);
  }

  @Get('refunds/pending')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  pendingRefunds(@CurrentUser() ctx: UserContext) {
    return this.refundService.listPending(ctx);
  }

  @Post('refunds/:id/decide')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  decideRefund(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: RefundDecisionDto) {
    return this.refundService.decide(ctx.id, id, dto.action === 'approve');
  }

  // ---- Payouts (spec §12.3) ----

  @Get('payouts/balance')
  @UseGuards(RolesGuard)
  @Roles(Role.EDUCATOR, Role.INSTITUTION_ADMIN)
  balance(@CurrentUser() ctx: UserContext) {
    return this.payoutService.balance(ctx);
  }

  @Get('payouts')
  @UseGuards(RolesGuard)
  @Roles()
  async payouts(@CurrentUser() ctx: UserContext, @Query('payee_id') payeeId?: string) {
    if (ctx.role === Role.PLATFORM_ADMIN) {
      return payeeId ? this.payoutService.listForPayee(payeeId) : this.payoutService.listAll();
    }
    const own = await this.payoutService.resolvePayeeId(ctx);
    return this.payoutService.listForPayee(own);
  }

  @Post('payouts/run')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  runPayouts() {
    return this.payoutService.runPayouts();
  }

  @Post('payouts/:id/release')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  release(@Param('id') id: string) {
    return this.payoutService.release(id);
  }

  // ---- Admin: manual bank transfer fallback (spec §0.4) ----

  @Post('admin/payments/bank-transfer')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  bankTransfer(@CurrentUser() ctx: UserContext, @Body() dto: BankTransferDto) {
    return this.paymentService.recordBankTransfer(ctx.id, dto);
  }

  @Get('admin/payments')
  @UseGuards(RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  adminPayments(@Query('page') page = '1', @Query('limit') limit = '20') {
    return this.paymentService.adminList(parseInt(page, 10), parseInt(limit, 10));
  }
}
