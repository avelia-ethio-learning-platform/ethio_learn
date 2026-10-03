import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { envInt, EventBusService, InternalHttpClient, internalPath, UserContext } from '@ethiopialearn/common';
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
import { PaymentPurpose } from '@ethiopialearn/contracts';
import { Payment, Payout, PayoutHold, PLATFORM_PAYEE_ID, RefundRequest } from './entities';

const PLATFORM_FEE_RATE = 0.2; // 80/20 split, computed at payout time (spec §0.4)
const STANDARD_HOLD_DAYS = 7; // spec §10.3
const NEW_EDUCATOR_HOLD_DAYS = 14; // spec §10.3
// TODO(spec-open-question §14): exact KYC threshold undecided — configurable.
const KYC_PAYOUT_THRESHOLD_ETB = () => envInt('KYC_PAYOUT_THRESHOLD_ETB', 10000);
const PAYEE_PAGE = 100;
/** Per payee per run; anything beyond waits for the next run. */
const PAYMENTS_PER_PAYOUT = 1000;
/** A run holds with `fraud_flag_open`; a flag raised later re-holds scheduled payouts with `fraud:<signal>`. */
const isFraudHold = (reason: string | null): reason is string => reason === 'fraud_flag_open' || !!reason?.startsWith('fraud:');

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
    private readonly dataSource: DataSource,
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
        if (remaining === 0) await this.releaseFraudHolds(p.payee_id);
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

  /**
   * One payout per payee per run, never two for one payment (P1-14), even when
   * runs overlap (cron, command and admin trigger) or one crashes:
   * - payees are paged with a keyset cursor;
   * - per payee, the HTTP and refund lookups happen first, then one
   *   transaction claims the payments (`payout_id IS NULL` in the UPDATE is
   *   the guarantee) and inserts the payout built from the claimed rows only;
   *   a transaction-scoped advisory lock (the Neon URL is pooled) makes a
   *   concurrent run skip the payee rather than do the work twice;
   * - disbursing is conditional on `scheduled`, after commit. A payout a
   *   crashed run left scheduled is disbursed by the next run.
   */
  async runPayouts(): Promise<{ created: number; held: number }> {
    let created = 0;
    let held = 0;
    for (const payout of await this.payouts.find({ where: { status: PayoutStatus.SCHEDULED } })) {
      if (await this.disburse(payout)) created += 1;
    }

    for (let cursor = PLATFORM_PAYEE_ID; ; ) {
      const page: { payee_id: string }[] = await this.dataSource.query(
        `SELECT payee_id FROM ${this.payments.metadata.tablePath} WHERE status = 'confirmed' AND payout_id IS NULL AND purpose <> 'wallet_topup' AND payee_id <> $1 AND amount_etb > 0 AND payee_id > $2 GROUP BY payee_id ORDER BY payee_id LIMIT ${PAYEE_PAGE}`,
        [PLATFORM_PAYEE_ID, cursor],
      );
      for (const { payee_id: payeeId } of page) {
        const payout = await this.payPayee(payeeId);
        if (payout?.status === PayoutStatus.SCHEDULED && (await this.disburse(payout))) created += 1;
        else if (payout?.status === PayoutStatus.HELD) held += 1;
      }
      if (page.length < PAYEE_PAGE) break;
      cursor = page[page.length - 1].payee_id;
    }
    this.logger.log(`payout run complete: ${created} disbursed, ${held} held`);
    return { created, held };
  }

  /** Claims the payee's cleared payments into a new payout. Null when there's nothing to pay or another run has the payee. */
  private async payPayee(payeeId: string): Promise<Payout | null> {
    // Wallet top-ups are platform liabilities, not course revenue — never paid out.
    const candidates = (
      await this.payments.find({
        where: { payee_id: payeeId, status: PaymentStatus.CONFIRMED, payout_id: IsNull(), purpose: Not(PaymentPurpose.WALLET_TOPUP) },
        order: { created_at: 'ASC' },
        take: PAYMENTS_PER_PAYOUT,
      })
    ).filter((p) => Number(p.amount_etb) > 0);
    if (!candidates.length) return null;

    // Standard 7-day settlement hold; 14 days for new educators (spec §10.3).
    const holdDays = await this.holdDays(payeeId, candidates[0].payee_type);
    const cleared = candidates.filter((p) => Date.now() - (p.webhook_received_at ?? p.created_at).getTime() >= holdDays * 86_400_000);
    if (!cleared.length) return null;
    // Pending refund on the payment → hold (spec §10.3).
    const refunding = new Set(
      (await this.refunds.find({ where: { payment_id: In(cleared.map((p) => p.id)), status: RefundStatus.PENDING } })).map((r) => r.payment_id),
    );
    const ids = cleared.filter((p) => !refunding.has(p.id)).map((p) => p.id);
    if (!ids.length) return null;
    const fraudHolds = await this.holds.count({ where: { payee_id: payeeId } });

    const payoutId = uuidv4();
    return this.dataSource.transaction(async (m) => {
      const [{ locked }]: { locked: boolean }[] = await m.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`, [`payout:${payeeId}`]);
      if (!locked) {
        this.logger.log(`payout for ${payeeId} skipped: another run is creating it`);
        return null;
      }
      const payments = m.getRepository(Payment);
      await payments.update({ id: In(ids), payout_id: IsNull(), status: PaymentStatus.CONFIRMED }, { payout_id: payoutId });
      const claimed = await payments.find({ where: { payout_id: payoutId } });
      if (!claimed.length) return null;

      const gross = claimed.reduce((sum, p) => sum + Number(p.amount_etb), 0);
      const fee = gross * PLATFORM_FEE_RATE;
      const net = gross - fee;
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
      const payout = m.getRepository(Payout).create({
        id: payoutId,
        payee_id: payeeId,
        payee_type: claimed[0].payee_type,
        gross_amount_etb: gross.toFixed(2),
        platform_fee_etb: fee.toFixed(2),
        net_amount_etb: net.toFixed(2),
        status,
        hold_reason: holdReason,
        scheduled_for: new Date(),
      });
      await m.getRepository(Payout).insert(payout);
      return payout;
    });
  }

  /**
   * Once a payee has no open fraud flag, only payouts held *for fraud* move on,
   * and the KYC rule applies again: a large one stays held as `kyc_required`
   * until an admin releases it. KYC holds are never touched here. Each change
   * is conditional on the reason read, so a concurrent admin release wins.
   */
  private async releaseFraudHolds(payeeId: string) {
    const held = await this.payouts.find({ where: { payee_id: payeeId, status: PayoutStatus.HELD } });
    for (const payout of held) {
      if (!isFraudHold(payout.hold_reason)) continue;
      const next =
        Number(payout.net_amount_etb) > KYC_PAYOUT_THRESHOLD_ETB()
          ? { hold_reason: 'kyc_required' }
          : { status: PayoutStatus.SCHEDULED, hold_reason: null };
      await this.payouts.update({ id: payout.id, status: PayoutStatus.HELD, hold_reason: payout.hold_reason }, next);
    }
  }

  /** Admin releases a held payout (fraud resolved / KYC passed). Twice or concurrently, it is disbursed once. */
  async release(payoutId: string) {
    const released = await this.payouts.update({ id: payoutId, status: PayoutStatus.HELD }, { status: PayoutStatus.SCHEDULED, hold_reason: null });
    if (released.affected !== 1) return { released: false };
    const payout = await this.payouts.findOne({ where: { id: payoutId } });
    if (payout) await this.disburse(payout);
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
    const rows = (await this.payments.find({ where: { payee_id: payeeId, status: PaymentStatus.CONFIRMED, payout_id: IsNull() } })).filter(
      (p) => p.purpose !== PaymentPurpose.WALLET_TOPUP,
    );
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
        const inst = await this.internal.get<{ id: string }>(internalPath`/api/v1/internal/institutions/by-owner/${ctx.id}`);
        return inst.id;
      } catch {
        return ctx.id;
      }
    }
    return ctx.id;
  }

  private async holdDays(payeeId: string, payeeType: OwnerType): Promise<number> {
    // TODO(spec-open-question): §10.3 says "first 3 courses" — approximated by
    // trust tier `new` (tier `new` covers exactly that cohort in §10.5).
    if (payeeType !== OwnerType.EDUCATOR) return STANDARD_HOLD_DAYS;
    try {
      // Quality & Trust owns educator_trust_tiers — read the authoritative tier.
      const res = await this.internal.get<{ tier: TrustTier }>(internalPath`/api/v1/internal/educators/${payeeId}/trust-tier`);
      return res.tier === TrustTier.NEW ? NEW_EDUCATOR_HOLD_DAYS : STANDARD_HOLD_DAYS;
    } catch {
      return NEW_EDUCATOR_HOLD_DAYS; // unknown educator → conservative
    }
  }

  /**
   * Pays a scheduled payout once: the status change is conditional, and only
   * the caller that made it publishes. `payout.id` is the idempotency key a
   * real transfer API call will use.
   */
  private async disburse(payout: Payout): Promise<boolean> {
    // TODO(spec-open-question §14): primary path is the Chapa split-payout API
    // once sub-merchant availability is confirmed; manual bank transfer is the
    // institutional fallback. MVP marks the disbursement completed and emits
    // the events the rest of the system depends on.
    const paidAt = new Date();
    const paid = await this.payouts.update({ id: payout.id, status: PayoutStatus.SCHEDULED }, { status: PayoutStatus.PAID, paid_at: paidAt });
    if (paid.affected !== 1) return false;
    payout.status = PayoutStatus.PAID;
    payout.paid_at = paidAt;

    let payeeEmail = '';
    try {
      const path = payout.payee_type === OwnerType.INSTITUTION ? 'institutions' : 'educators';
      const payee = await this.internal.get<{ email: string }>(internalPath`/api/v1/internal/${path}/${payout.payee_id}`);
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
    return true;
  }
}
