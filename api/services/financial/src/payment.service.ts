import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Between, In, IsNull, Not, Repository } from 'typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { env, EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import {
  OwnerType,
  PaymentAbandonedPayload,
  PaymentConfirmedPayload,
  PaymentMethod,
  PaymentPurpose,
  PaymentStatus,
  PricingType,
  Role,
} from '@ethiopialearn/contracts';
import { CHAPA_PROVIDER, ChapaProvider, ChapaVerification, chapaMode } from './chapa.provider';
import { Payment, PLATFORM_PAYEE_ID } from './entities';
import { GrowthService } from './growth.service';

export interface CourseInfo {
  id: string;
  title: string;
  owner_id: string;
  owner_type: OwnerType;
  pricing_type: PricingType;
  price_etb: number | null;
  status: string;
}

/** Everything needed to open a checkout for any purpose (course, gift, bulk, top-up…). */
export interface SessionInput {
  payer: UserContext;
  purpose: PaymentPurpose;
  /** null for wallet top-ups */
  courseId: string | null;
  courseTitle: string;
  listPriceEtb: number;
  payee: { id: string; type: OwnerType };
  couponCode?: string | null;
  useWallet?: boolean;
  meta?: Record<string, any> | null;
  /** where Chapa sends the browser back (path on WEB_URL) */
  returnPath?: string;
}

export interface SessionResult {
  payment_id: string;
  tx_ref: string;
  /** null when the payment settled instantly (wallet / 100% coupon) */
  checkout_url: string | null;
  confirmed: boolean;
  amount_etb: number;
  discount_etb: number;
}

type PurposeHandler = (payment: Payment) => Promise<void>;

/** Purpose-based volume tiers for bulk purchases (seats → % off). Env-overridable. */
export function bulkDiscountPercent(seats: number): number {
  const tiers = env('BULK_DISCOUNT_TIERS', '5:10,10:20,50:30')
    .split(',')
    .map((t) => t.split(':').map(Number))
    .filter(([n, p]) => Number.isFinite(n) && Number.isFinite(p))
    .sort((a, b) => a[0] - b[0]);
  let pct = 0;
  for (const [min, p] of tiers) if (seats >= min) pct = p;
  return pct;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly purposeHandlers = new Map<PaymentPurpose, PurposeHandler[]>();

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @Inject(CHAPA_PROVIDER) private readonly chapa: ChapaProvider,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
    private readonly growth: GrowthService,
  ) {}

  /** Other services register what a CONFIRMED payment of a purpose should trigger. */
  onPurposeConfirmed(purpose: PaymentPurpose, handler: PurposeHandler) {
    const list = this.purposeHandlers.get(purpose) ?? [];
    list.push(handler);
    this.purposeHandlers.set(purpose, list);
  }

  async courseInfo(courseId: string): Promise<CourseInfo> {
    return this.internal.get<CourseInfo>(`/api/v1/internal/courses/${courseId}`);
  }

  /**
   * Spec §6 steps 1-2 for a learner buying a course for themselves. Free
   * courses never touch Chapa — they enroll via POST /enrollments.
   */
  async initiate(ctx: UserContext, courseId: string, opts: { coupon_code?: string | null; use_wallet?: boolean } = {}): Promise<SessionResult> {
    const course = await this.courseInfo(courseId);
    if (course.status !== 'published') throw new NotFoundException('Course not available');
    if (course.pricing_type === PricingType.FREE || !course.price_etb) {
      throw new BadRequestException('This course is free — enroll directly via POST /enrollments');
    }
    if (await this.ownsCourse(ctx.id, courseId)) throw new BadRequestException('You already own this course');

    return this.createSession({
      payer: ctx,
      purpose: PaymentPurpose.COURSE,
      courseId,
      courseTitle: course.title,
      listPriceEtb: course.price_etb,
      payee: { id: course.owner_id, type: course.owner_type },
      couponCode: opts.coupon_code,
      useWallet: opts.use_wallet,
    });
  }

  /** Learner loads prepaid credits. Settles through Chapa only (no wallet-to-wallet). */
  async topUpWallet(ctx: UserContext, amountEtb: number): Promise<SessionResult> {
    const amount = Number(amountEtb.toFixed(2));
    if (amount < 50 || amount > 50_000) throw new BadRequestException('Top-up must be between 50 and 50,000 ETB');
    return this.createSession({
      payer: ctx,
      purpose: PaymentPurpose.WALLET_TOPUP,
      courseId: null,
      courseTitle: 'Wallet top-up',
      listPriceEtb: amount,
      payee: { id: PLATFORM_PAYEE_ID, type: OwnerType.EDUCATOR },
      returnPath: '/dashboard?topup=1',
    });
  }

  /**
   * The single checkout path. Applies the coupon, then settles instantly
   * (100% coupon or wallet) or opens a Chapa hosted checkout. The ledger row
   * is created FIRST either way — every attempt is recorded.
   */
  async createSession(input: SessionInput): Promise<SessionResult> {
    const quote = input.courseId
      ? await this.growth.quote(input.courseId, input.listPriceEtb, input.couponCode)
      : { coupon: null, list_price_etb: input.listPriceEtb, discount_etb: 0, amount_due_etb: input.listPriceEtb };
    const due = quote.amount_due_etb;

    // tx_ref is OURS: SDK-style TX-XXXX reference, generated server-side.
    // Clients can never supply one (webhook idempotency hangs off it).
    const txRef = await this.chapa.generateTxRef();
    const payment = await this.payments.save(
      this.payments.create({
        learner_id: input.payer.id,
        course_id: input.courseId ?? PLATFORM_PAYEE_ID,
        amount_etb: due.toFixed(2),
        method: PaymentMethod.CHAPA,
        status: PaymentStatus.PENDING,
        chapa_tx_ref: txRef,
        payee_id: input.payee.id,
        payee_type: input.payee.type,
        course_title: input.courseTitle,
        purpose: input.purpose,
        meta: input.meta ?? null,
        list_price_etb: quote.list_price_etb.toFixed(2),
        discount_etb: quote.discount_etb.toFixed(2),
        coupon_code: quote.coupon?.code ?? null,
      }),
    );

    const result = (checkoutUrl: string | null, confirmed: boolean): SessionResult => ({
      payment_id: payment.id,
      tx_ref: txRef,
      checkout_url: checkoutUrl,
      confirmed,
      amount_etb: due,
      discount_etb: quote.discount_etb,
    });

    // 100% off → nothing to charge. Keep the row for the audit trail.
    if (due <= 0) {
      payment.method = PaymentMethod.COUPON;
      await this.settleInstantly(payment, 'coupon');
      return result(null, true);
    }

    if (input.useWallet) {
      if (input.purpose === PaymentPurpose.WALLET_TOPUP) throw new BadRequestException('Cannot top up a wallet from a wallet');
      // debit() throws a readable error when the balance is too low.
      await this.growth.debit(input.payer.id, due, 'purchase', payment.id, `Paid for "${input.courseTitle}"`);
      payment.method = PaymentMethod.WALLET;
      await this.settleInstantly(payment, 'wallet');
      return result(null, true);
    }

    const checkoutUrl = await this.openChapaCheckout(payment, input);
    payment.chapa_checkout_url = checkoutUrl;
    await this.payments.save(payment);
    return result(checkoutUrl, false);
  }

  private async settleInstantly(payment: Payment, via: string) {
    payment.status = PaymentStatus.CONFIRMED;
    payment.webhook_received_at = new Date();
    await this.payments.save(payment);
    await this.onConfirmed(payment);
    this.logger.log(`payment ${payment.id} (${payment.purpose}) settled instantly via ${via}`);
  }

  private async openChapaCheckout(payment: Payment, input: SessionInput): Promise<string> {
    const gatewayUrl = env('GATEWAY_PUBLIC_URL', 'http://localhost:4000');
    const webUrl = env('WEB_URL', 'http://localhost:3000');
    const learner = await this.learnerInfo(input.payer.id);
    const [firstName, ...rest] = (learner.name || 'EthiopiaLearn Learner').trim().split(/\s+/);

    // Local-dev URL handling: Chapa's SDK validation rejects `localhost` URLs
    // (no TLD), and Chapa's servers can't call a localhost callback anyway.
    const isLocal = (u: string) => /\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(u);
    const returnPath = input.returnPath ?? `/payment/return?course_id=${input.courseId}&tx_ref=${payment.chapa_tx_ref}&purpose=${input.purpose}`;
    const sep = returnPath.includes('?') ? '&' : '?';
    const returnUrl = `${webUrl.replace('//localhost', '//127.0.0.1')}${returnPath}${returnPath.includes('tx_ref=') ? '' : `${sep}tx_ref=${payment.chapa_tx_ref}`}`;
    const callbackUrl = isLocal(gatewayUrl) ? undefined : `${gatewayUrl}/api/v1/payments/webhook/chapa`;

    const customerEmail = input.payer.email || learner.email;
    const initOpts = {
      first_name: firstName,
      last_name: rest.join(' ') || firstName,
      email: customerEmail,
      currency: 'ETB' as const,
      amount: Number(payment.amount_etb).toFixed(2),
      tx_ref: payment.chapa_tx_ref,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      return_url: returnUrl,
      customization: { title: 'EthiopiaLearn'.slice(0, 16), description: input.courseTitle.slice(0, 100) },
    };
    // Chapa validates the customer email DOMAIN and rejects non-mainstream
    // domains (e.g. the *.et demo accounts). Retry once with a configured,
    // gateway-accepted fallback rather than blocking the purchase.
    try {
      return (await this.chapa.initialize(initOpts)).checkout_url;
    } catch (err) {
      const fallback = env('CHAPA_FALLBACK_EMAIL', '');
      if (fallback && fallback !== customerEmail && /validation\.email|valid email/i.test((err as Error).message)) {
        this.logger.warn(`Chapa rejected customer email "${customerEmail}"; retrying with fallback "${fallback}"`);
        return (await this.chapa.initialize({ ...initOpts, email: fallback })).checkout_url;
      }
      throw err;
    }
  }

  /**
   * Spec §6 steps 4-7. NEVER trust an unverified webhook: HMAC-SHA256 over the
   * raw body must match before anything is processed. Always returns 200 to
   * the caller (Chapa retries on non-200) — the return value here only tells
   * the controller what to log.
   */
  async handleWebhook(rawBody: Buffer, signatureHeader: string | undefined): Promise<{ processed: boolean; reason: string }> {
    if (!this.verifyHmac(rawBody, signatureHeader)) {
      this.logger.warn('webhook rejected: HMAC verification failed');
      return { processed: false, reason: 'invalid signature' };
    }

    let body: { tx_ref?: string; status?: string };
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { processed: false, reason: 'invalid JSON' };
    }
    if (!body.tx_ref) return { processed: false, reason: 'missing tx_ref' };

    const payment = await this.payments.findOne({ where: { chapa_tx_ref: body.tx_ref } });
    if (!payment) return { processed: false, reason: 'unknown tx_ref' };

    // Step 7: duplicate guard — idempotent no-op on already-confirmed tx_ref.
    if (payment.status === PaymentStatus.CONFIRMED) {
      return { processed: true, reason: 'duplicate — already confirmed' };
    }

    if (body.status === 'success') {
      // Step 5: the webhook's claim grants nothing — ask Chapa directly.
      const verification = await this.chapa.verify(payment.chapa_tx_ref);
      return this.applyVerification(payment, verification, 'webhook');
    }
    // A signed webhook reporting failure marks the attempt failed (grants nothing).
    return this.applyVerification(payment, { status: 'failed', amount: null, currency: null }, 'webhook');
  }

  /**
   * Learner-triggered fallback for a payment stuck pending (webhook delayed or
   * undeliverable). The browser's word grants NOTHING: the server asks Chapa's
   * verify API directly and applies exactly the same rules as the webhook path.
   */
  async reconcile(ctx: UserContext, txRef: string) {
    const payment = await this.payments.findOne({ where: { chapa_tx_ref: txRef, learner_id: ctx.id } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status === PaymentStatus.PENDING && chapaMode() === 'live') {
      const verification = await this.chapa.verify(payment.chapa_tx_ref);
      await this.applyVerification(payment, verification, 'reconcile');
    }
    return this.publicView(payment);
  }

  /**
   * Safety net for missed webhooks and abandoned return pages. Every 2 minutes,
   * ask Chapa about recent pending payments and apply the standard rules.
   */
  @Cron('*/2 * * * *')
  async sweepPendingPayments(): Promise<void> {
    if (chapaMode() !== 'live') return;
    const now = Date.now();
    const rows = await this.payments.find({
      where: {
        status: PaymentStatus.PENDING,
        method: PaymentMethod.CHAPA,
        created_at: Between(new Date(now - 24 * 3600_000), new Date(now - 60_000)),
      },
      order: { created_at: 'DESC' },
      take: 25,
    });
    for (const payment of rows) {
      try {
        const verification = await this.chapa.verify(payment.chapa_tx_ref);
        await this.applyVerification(payment, verification, 'sweep');
      } catch (err) {
        this.logger.warn(`sweep: could not verify ${payment.chapa_tx_ref}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Abandoned checkout nudge: a course checkout opened 1–48h ago that never
   * completed gets ONE "finish your purchase" reminder (in-app + email via the
   * notification service). Runs hourly; nudged_at guarantees a single send.
   */
  @Cron('15 * * * *')
  async nudgeAbandonedCheckouts(): Promise<void> {
    const now = Date.now();
    const rows = await this.payments.find({
      where: {
        status: PaymentStatus.PENDING,
        method: PaymentMethod.CHAPA,
        purpose: PaymentPurpose.COURSE,
        nudged_at: IsNull(),
        created_at: Between(new Date(now - 48 * 3600_000), new Date(now - 3600_000)),
      },
      order: { created_at: 'ASC' },
      take: 50,
    });
    for (const payment of rows) {
      // Skip if the learner already owns the course through another payment.
      if (await this.ownsCourse(payment.learner_id, payment.course_id)) {
        payment.nudged_at = new Date();
        await this.payments.save(payment);
        continue;
      }
      const learner = await this.learnerInfo(payment.learner_id);
      payment.nudged_at = new Date();
      await this.payments.save(payment);
      await this.bus.publish<PaymentAbandonedPayload>('PaymentAbandoned', {
        payment_id: payment.id,
        learner_id: payment.learner_id,
        learner_email: learner.email,
        learner_name: learner.name,
        course_id: payment.course_id,
        course_title: payment.course_title,
        amount_etb: Number(payment.amount_etb),
        resume_url: `${env('WEB_URL', 'http://localhost:3000')}/courses/${payment.course_id}`,
      });
    }
    if (rows.length) this.logger.log(`abandoned-checkout nudges sent: ${rows.length}`);
  }

  /**
   * The single place a payment becomes confirmed/failed. Idempotent; cross-
   * checks the gateway-verified amount and currency against our ledger row
   * before anything downstream happens.
   */
  private async applyVerification(
    payment: Payment,
    verification: ChapaVerification,
    source: 'webhook' | 'reconcile' | 'sweep',
  ): Promise<{ processed: boolean; reason: string }> {
    if (payment.status === PaymentStatus.CONFIRMED) {
      return { processed: true, reason: 'duplicate — already confirmed' };
    }

    if (verification.status === 'success') {
      // Tamper guard: the verified amount must match what we quoted.
      if (verification.amount != null && Math.abs(verification.amount - Number(payment.amount_etb)) > 0.009) {
        this.logger.error(
          `amount mismatch on ${payment.chapa_tx_ref}: gateway verified ${verification.amount}, ledger says ${payment.amount_etb} — NOT confirming`,
        );
        return { processed: false, reason: 'amount mismatch' };
      }
      if (verification.currency && verification.currency !== 'ETB') {
        this.logger.error(`currency mismatch on ${payment.chapa_tx_ref}: ${verification.currency} — NOT confirming`);
        return { processed: false, reason: 'currency mismatch' };
      }
      payment.status = PaymentStatus.CONFIRMED;
      payment.webhook_received_at = new Date();
      await this.payments.save(payment);
      await this.onConfirmed(payment);
      this.logger.log(`payment ${payment.id} (${payment.chapa_tx_ref}, ${payment.purpose}) confirmed via ${source}`);
      return { processed: true, reason: 'confirmed' };
    }

    if (verification.status === 'failed') {
      payment.status = PaymentStatus.FAILED;
      payment.webhook_received_at = new Date();
      await this.payments.save(payment);
      if ((payment.purpose ?? PaymentPurpose.COURSE) === PaymentPurpose.COURSE) await this.emitFailed(payment, 'failed');
      this.logger.log(`payment ${payment.id} (${payment.chapa_tx_ref}) marked failed via ${source}`);
      return { processed: true, reason: 'failed' };
    }

    this.logger.warn(`verify says ${payment.chapa_tx_ref} is still pending at the gateway (${source})`);
    return { processed: false, reason: 'still pending at gateway' };
  }

  /** What a confirmed payment triggers, by purpose. Each step is best-effort so one failure never blocks the rest. */
  private async onConfirmed(payment: Payment) {
    // Rows written before the purpose column existed are course purchases.
    const purpose = payment.purpose ?? PaymentPurpose.COURSE;
    await this.safe('coupon use', () => this.growth.recordCouponUse(payment.coupon_code ?? null));

    if (purpose === PaymentPurpose.COURSE) {
      await this.emitConfirmed(payment); // THE event that grants entitlement
    } else if (purpose === PaymentPurpose.WALLET_TOPUP) {
      await this.safe('wallet top-up credit', () =>
        this.growth.credit(payment.learner_id, Number(payment.amount_etb), 'topup', payment.id, 'Wallet top-up via Chapa').then(() => undefined),
      );
    }
    for (const handler of this.purposeHandlers.get(purpose) ?? []) {
      await this.safe(`${purpose} handler`, () => handler(payment));
    }
    if (purpose !== PaymentPurpose.WALLET_TOPUP) {
      await this.safe('cashback / referral reward', () => this.growth.onCoursePurchaseConfirmed(payment));
    }
  }

  private async safe(label: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`post-confirmation step failed (${label}): ${(err as Error).message}`);
    }
  }

  /**
   * DEV-ONLY (CHAPA_MODE=mock): the mock checkout page calls this; we deliver
   * a properly HMAC-signed webhook to ourselves so the real path runs.
   */
  async mockComplete(txRef: string, outcome: 'success' | 'failed') {
    if (chapaMode() !== 'mock') throw new ForbiddenException('Mock checkout disabled');
    const raw = Buffer.from(JSON.stringify({ tx_ref: txRef, status: outcome, event: 'charge.complete' }));
    const signature = createHmac('sha256', env('CHAPA_WEBHOOK_SECRET', 'dev-webhook-secret')).update(raw).digest('hex');
    return this.handleWebhook(raw, signature);
  }

  /** Manual bank-transfer fallback — platform admin marks it settled (spec §0.4). */
  async recordBankTransfer(adminId: string, dto: { learner_id: string; course_id: string }) {
    const course = await this.courseInfo(dto.course_id);
    if (!course.price_etb) throw new BadRequestException('Course has no price');
    const payment = await this.payments.save(
      this.payments.create({
        learner_id: dto.learner_id,
        course_id: dto.course_id,
        amount_etb: course.price_etb.toFixed(2),
        list_price_etb: course.price_etb.toFixed(2),
        method: PaymentMethod.BANK_TRANSFER,
        status: PaymentStatus.CONFIRMED,
        chapa_tx_ref: `bank-${uuidv4()}`,
        webhook_received_at: new Date(),
        payee_id: course.owner_id,
        payee_type: course.owner_type,
        course_title: course.title,
        purpose: PaymentPurpose.COURSE,
      }),
    );
    this.logger.log(`bank transfer recorded by admin ${adminId} for ${dto.course_id}`);
    await this.onConfirmed(payment);
    return payment;
  }

  async detail(ctx: UserContext, paymentId: string) {
    const payment = await this.payments.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.learner_id !== ctx.id && ctx.role !== Role.PLATFORM_ADMIN) throw new ForbiddenException();
    return this.publicView(payment);
  }

  async listMine(ctx: UserContext) {
    const rows = await this.payments.find({ where: { learner_id: ctx.id }, order: { created_at: 'DESC' } });
    return rows.map((p) => this.publicView(p));
  }

  /** Admin ledger: every payment enriched with who paid and the full timeline. */
  async adminList(page: number, limit: number) {
    const take = Math.min(limit || 20, 100);
    const [items, total] = await this.payments.findAndCount({
      order: { created_at: 'DESC' },
      take,
      skip: (Math.max(page || 1, 1) - 1) * take,
    });
    const learnerIds = [...new Set(items.map((p) => p.learner_id))];
    const learners = new Map<string, { email: string; name: string }>();
    await Promise.all(
      learnerIds.map(async (id) => {
        learners.set(id, await this.learnerInfo(id));
      }),
    );
    return {
      total,
      items: items.map((p) => ({
        ...this.publicView(p),
        learner_id: p.learner_id,
        learner_name: learners.get(p.learner_id)?.name || '(unknown)',
        learner_email: learners.get(p.learner_id)?.email || '',
        payee_id: p.payee_id,
        payee_type: p.payee_type,
        webhook_received_at: p.webhook_received_at,
        payout_id: p.payout_id,
      })),
    };
  }

  // ---- Analytics ---------------------------------------------------------

  /** Educator / institution revenue: totals, by month (12), by course. */
  async payeeAnalytics(payeeIds: string[]) {
    const rows = await this.payments.find({
      where: { payee_id: In(payeeIds), status: PaymentStatus.CONFIRMED, purpose: Not(PaymentPurpose.WALLET_TOPUP) },
      order: { created_at: 'ASC' },
    });
    return this.summarize(rows);
  }

  /** Platform-wide money view for the admin console. */
  async adminAnalytics() {
    const rows = await this.payments.find({ where: { status: PaymentStatus.CONFIRMED }, order: { created_at: 'ASC' } });
    const revenue = rows.filter((r) => r.purpose !== PaymentPurpose.WALLET_TOPUP);
    const summary = this.summarize(revenue);
    const pending = await this.payments.count({ where: { status: PaymentStatus.PENDING } });
    const failed = await this.payments.count({ where: { status: PaymentStatus.FAILED } });
    const byPurpose: Record<string, { count: number; gross_etb: number }> = {};
    for (const r of rows) {
      const b = (byPurpose[r.purpose] ??= { count: 0, gross_etb: 0 });
      b.count += 1;
      b.gross_etb = Number((b.gross_etb + Number(r.amount_etb)).toFixed(2));
    }
    const byMethod: Record<string, number> = {};
    for (const r of revenue) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
    return {
      ...summary,
      pending_count: pending,
      failed_count: failed,
      by_purpose: byPurpose,
      by_method: byMethod,
      coupon_discount_total_etb: Number(revenue.reduce((s, r) => s + Number(r.discount_etb), 0).toFixed(2)),
      wallet: await this.growth.adminWalletStats(),
    };
  }

  private summarize(rows: Payment[]) {
    const gross = rows.reduce((s, r) => s + Number(r.amount_etb), 0);
    const months: Record<string, { gross_etb: number; count: number }> = {};
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 11);
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      months[d.toISOString().slice(0, 7)] = { gross_etb: 0, count: 0 };
    }
    const byCourse: Record<string, { course_id: string; course_title: string; count: number; gross_etb: number }> = {};
    for (const r of rows) {
      const key = r.created_at.toISOString().slice(0, 7);
      if (months[key]) {
        months[key].gross_etb = Number((months[key].gross_etb + Number(r.amount_etb)).toFixed(2));
        months[key].count += 1;
      }
      const c = (byCourse[r.course_id] ??= { course_id: r.course_id, course_title: r.course_title, count: 0, gross_etb: 0 });
      c.count += 1;
      c.gross_etb = Number((c.gross_etb + Number(r.amount_etb)).toFixed(2));
    }
    return {
      total_gross_etb: Number(gross.toFixed(2)),
      total_net_etb: Number((gross * 0.8).toFixed(2)),
      payment_count: rows.length,
      by_month: Object.entries(months).map(([month, v]) => ({ month, ...v })),
      by_course: Object.values(byCourse).sort((a, b) => b.gross_etb - a.gross_etb),
    };
  }

  // ---- helpers -----------------------------------------------------------

  private async ownsCourse(learnerId: string, courseId: string): Promise<boolean> {
    try {
      const e = await this.internal.get<{ entitlement_status: string }>(`/api/v1/internal/entitlements?learner_id=${learnerId}&course_id=${courseId}`);
      return e.entitlement_status === 'active';
    } catch {
      return false;
    }
  }

  publicView(p: Payment) {
    return {
      id: p.id,
      course_id: p.course_id,
      course_title: p.course_title,
      amount_etb: Number(p.amount_etb),
      list_price_etb: p.list_price_etb != null ? Number(p.list_price_etb) : null,
      discount_etb: Number(p.discount_etb ?? 0),
      coupon_code: p.coupon_code,
      purpose: p.purpose,
      method: p.method,
      status: p.status,
      tx_ref: p.chapa_tx_ref,
      created_at: p.created_at,
    };
  }

  private verifyHmac(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader) return false;
    const secret = env('CHAPA_WEBHOOK_SECRET', 'dev-webhook-secret');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const presented = Buffer.from(signatureHeader.trim());
    const computed = Buffer.from(expected);
    return presented.length === computed.length && timingSafeEqual(presented, computed);
  }

  private async emitConfirmed(payment: Payment) {
    const learner = await this.learnerInfo(payment.learner_id);
    await this.bus.publish<PaymentConfirmedPayload>('PaymentConfirmed', {
      payment_id: payment.id,
      tx_ref: payment.chapa_tx_ref,
      learner_id: payment.learner_id,
      learner_email: learner.email,
      learner_name: learner.name,
      course_id: payment.course_id,
      course_title: payment.course_title,
      amount_etb: Number(payment.amount_etb),
      payee_id: payment.payee_id,
      payee_type: payment.payee_type,
    });
  }

  private async emitFailed(payment: Payment, reason: string) {
    const learner = await this.learnerInfo(payment.learner_id);
    await this.bus.publish('PaymentFailed', {
      payment_id: payment.id,
      tx_ref: payment.chapa_tx_ref,
      learner_id: payment.learner_id,
      learner_email: learner.email,
      course_id: payment.course_id,
      course_title: payment.course_title,
      amount_etb: Number(payment.amount_etb),
      reason,
    });
  }

  async learnerInfo(learnerId: string): Promise<{ email: string; name: string }> {
    try {
      return await this.internal.get<{ email: string; name: string }>(`/api/v1/internal/users/${learnerId}`);
    } catch {
      return { email: '', name: '' };
    }
  }
}
