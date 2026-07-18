import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { envInt, EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import {
  FraudFlagPayload,
  OwnerType,
  PaymentStatus,
  PayoutPayload,
  PayoutStatus,
  RefundStatus,
  Role,
  TrustTier,
} from '@ethiopialearn/contracts';
import { Payment, Payout, PayoutHold, RefundRequest } from './entities';

const PLATFORM_FEE_RATE = 0.2; // 80/20 split, computed at payout time (spec §0.4)
const STANDARD_HOLD_DAYS = 7; // spec §10.3
const NEW_EDUCATOR_HOLD_DAYS = 14; // spec §10.3
// TODO(spec-open-question §14): exact KYC threshold undecided — configurable.
const KYC_PAYOUT_THRESHOLD_ETB = () => envInt('KYC_PAYOUT_THRESHOLD_ETB', 10000);

@Injectable()
export class PayoutService implements OnModuleInit {
  private readonly logger = new Logger(PayoutService.name);

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(Payout) private readonly payouts: Repository<Payout>,
    @InjectRepository(PayoutHold) private readonly holds: Repository<PayoutHold>,
    @InjectRepository(RefundRequest) private readonly refunds: Repository<RefundRequest>,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
  ) {}

  onModuleInit() {
    // Fraud flags hold payouts until resolved (spec §10.3).
    this.bus.subscribe<FraudFlagPayload>('FraudFlagRaised', async (p) => {
      if (!p.payee_id) return;
      const existing = await this.holds.findOne({ where: { flag_id: p.flag_id } });
      if (!existing) {
        await this.holds.save(this.holds.create({ payee_id: p.payee_id, flag_id: p.flag_id, reason: p.signal_type }));
      }
      await this.payouts.update(
        { payee_id: p.payee_id, status: PayoutStatus.SCHEDULED },
        { status: PayoutStatus.HELD, hold_reason: `fraud:${p.signal_type}` },
      );
      this.logger.warn(`payout hold applied for payee ${p.payee_id} (${p.signal_type})`);
    });
    this.bus.subscribe<FraudFlagPayload>('FraudFlagResolved', async (p) => {
      await this.holds.delete({ flag_id: p.flag_id });
      if (p.payee_id) {
        const remaining = await this.holds.count({ where: { payee_id: p.payee_id } });
        if (remaining === 0) {
          await this.payouts.update(
            { payee_id: p.payee_id, status: PayoutStatus.HELD },
            { status: PayoutStatus.SCHEDULED, hold_reason: null },
          );
        }
      }
    });
    // Internal command channel: cron/service trigger via the direct exchange.
    this.bus.subscribeCommands(async (message) => {
      if (message.command === 'run_payouts') await this.runPayouts();
    });
  }

  /** Nightly payout run (spec §12.3). */
  @Cron('0 2 * * *')
  async nightly() {
    await this.runPayouts();
  }

  async runPayouts(): Promise<{ created: number; held: number }> {
    const eligible = await this.payments.find({
      where: { status: PaymentStatus.CONFIRMED, payout_id: IsNull() },
    });

    // Group settled, hold-cleared payments per payee.
    const byPayee = new Map<string, Payment[]>();
    for (const payment of eligible) {
      if (!(await this.paymentClearedHolds(payment))) continue;
      const list = byPayee.get(payment.payee_id) ?? [];
      list.push(payment);
      byPayee.set(payment.payee_id, list);
    }

    let created = 0;
    let held = 0;
    for (const [payeeId, payeePayments] of byPayee) {
      const fraudHolds = await this.holds.count({ where: { payee_id: payeeId } });
      const gross = payeePayments.reduce((sum, p) => sum + Number(p.amount_etb), 0);
      if (gross <= 0) continue;
      const fee = gross * PLATFORM_FEE_RATE;
      const net = gross - fee;
      const payeeType = payeePayments[0].payee_type;

      let status = PayoutStatus.SCHEDULED;
      let holdReason: string | null = null;
      if (fraudHolds > 0) {
        status = PayoutStatus.HELD;
        holdReason = 'fraud_flag_open';
      } else if (net > KYC_PAYOUT_THRESHOLD_ETB()) {
        // KYC only gates large payouts — never publishing (spec §10.3).
        status = PayoutStatus.HELD;
        holdReason = 'kyc_required';
      }

      const payout = await this.payouts.save(
        this.payouts.create({
          payee_id: payeeId,
          payee_type: payeeType,
          gross_amount_etb: gross.toFixed(2),
          platform_fee_etb: fee.toFixed(2),
          net_amount_etb: net.toFixed(2),
          status,
          hold_reason: holdReason,
          scheduled_for: new Date(),
        }),
      );
      for (const payment of payeePayments) {
        payment.payout_id = payout.id;
        await this.payments.save(payment);
      }

      if (status === PayoutStatus.SCHEDULED) {
        await this.disburse(payout);
        created += 1;
      } else {
        held += 1;
      }
    }
    this.logger.log(`payout run complete: ${created} disbursed, ${held} held`);
    return { created, held };
  }

  /** Admin releases a held payout (fraud resolved / KYC passed). */
  async release(payoutId: string) {
    const payout = await this.payouts.findOne({ where: { id: payoutId } });
    if (!payout || payout.status !== PayoutStatus.HELD) return { released: false };
    payout.status = PayoutStatus.SCHEDULED;
    payout.hold_reason = null;
    await this.payouts.save(payout);
    await this.disburse(payout);
    return { released: true };
  }

  async listForPayee(payeeId: string) {
    return this.payouts.find({ where: { payee_id: payeeId }, order: { created_at: 'DESC' } });
  }

  async listAll() {
    return this.payouts.find({ order: { created_at: 'DESC' }, take: 200 });
  }

  /** Pending (not-yet-paid-out) earnings for the calling educator/institution. */
  async balance(ctx: UserContext) {
    const payeeId = await this.resolvePayeeId(ctx);
    const rows = await this.payments.find({ where: { payee_id: payeeId, status: PaymentStatus.CONFIRMED, payout_id: IsNull() } });
    const gross = rows.reduce((sum, p) => sum + Number(p.amount_etb), 0);
    return {
      payee_id: payeeId,
      pending_gross_etb: Number(gross.toFixed(2)),
      pending_net_etb: Number((gross * (1 - PLATFORM_FEE_RATE)).toFixed(2)),
      platform_fee_rate: PLATFORM_FEE_RATE,
      payment_count: rows.length,
    };
  }

  async resolvePayeeId(ctx: UserContext): Promise<string> {
    if (ctx.role === Role.INSTITUTION_ADMIN) {
      try {
        const inst = await this.internal.get<{ id: string }>(`/api/v1/internal/institutions/by-owner/${ctx.id}`);
        return inst.id;
      } catch {
        return ctx.id;
      }
    }
    return ctx.id;
  }

  private async paymentClearedHolds(payment: Payment): Promise<boolean> {
    // Pending refund on the payment → hold (spec §10.3).
    const pendingRefund = await this.refunds.findOne({
      where: { payment_id: payment.id, status: RefundStatus.PENDING },
    });
    if (pendingRefund) return false;

    // Standard 7-day settlement hold; 14 days for new educators.
    // TODO(spec-open-question): §10.3 says "first 3 courses" — approximated by
    // trust tier `new` (tier `new` covers exactly that cohort in §10.5).
    let holdDays = STANDARD_HOLD_DAYS;
    if (payment.payee_type === OwnerType.EDUCATOR) {
      try {
        // Quality & Trust owns educator_trust_tiers — read the authoritative tier.
        const res = await this.internal.get<{ tier: TrustTier }>(
          `/api/v1/internal/educators/${payment.payee_id}/trust-tier`,
        );
        if (res.tier === TrustTier.NEW) holdDays = NEW_EDUCATOR_HOLD_DAYS;
      } catch {
        holdDays = NEW_EDUCATOR_HOLD_DAYS; // unknown educator → conservative
      }
    }
    const settledAt = payment.webhook_received_at ?? payment.created_at;
    return Date.now() - settledAt.getTime() >= holdDays * 86_400_000;
  }

  private async disburse(payout: Payout) {
    // TODO(spec-open-question §14): primary path is the Chapa split-payout API
    // once sub-merchant availability is confirmed; manual bank transfer is the
    // institutional fallback. MVP marks the disbursement completed and emits
    // the events the rest of the system depends on.
    payout.status = PayoutStatus.PAID;
    payout.paid_at = new Date();
    await this.payouts.save(payout);

    let payeeEmail = '';
    try {
      const path = payout.payee_type === OwnerType.INSTITUTION ? 'institutions' : 'educators';
      const payee = await this.internal.get<{ email: string }>(`/api/v1/internal/${path}/${payout.payee_id}`);
      payeeEmail = payee.email;
    } catch {
      /* best effort */
    }
    const payload: PayoutPayload = {
      payout_id: payout.id,
      payee_id: payout.payee_id,
      payee_type: payout.payee_type,
      payee_email: payeeEmail,
      gross_amount_etb: Number(payout.gross_amount_etb),
      platform_fee_etb: Number(payout.platform_fee_etb),
      net_amount_etb: Number(payout.net_amount_etb),
    };
    await this.bus.publish('PayoutScheduled', payload);
    await this.bus.publish('PayoutCompleted', payload);
  }
}
