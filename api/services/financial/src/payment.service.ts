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
import { Between, Repository } from 'typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { env, EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import {
  OwnerType,
  PaymentConfirmedPayload,
  PaymentMethod,
  PaymentStatus,
  PricingType,
  Role,
} from '@ethiopialearn/contracts';
import { CHAPA_PROVIDER, ChapaProvider, ChapaVerification, chapaMode } from './chapa.provider';
import { Payment } from './entities';

interface CourseInfo {
  id: string;
  title: string;
  owner_id: string;
  owner_type: OwnerType;
  pricing_type: PricingType;
  price_etb: number | null;
  status: string;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @Inject(CHAPA_PROVIDER) private readonly chapa: ChapaProvider,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
  ) {}

  /**
   * Spec §6 steps 1-2: create the pending ledger row FIRST (every attempt is
   * recorded, even ones the learner abandons), then get the Chapa checkout URL.
   * Free courses never touch Chapa — they enroll via POST /enrollments.
   */
  async initiate(ctx: UserContext, courseId: string) {
    const course = await this.internal.get<CourseInfo>(`/api/v1/internal/courses/${courseId}`);
    if (course.status !== 'published') throw new NotFoundException('Course not available');
    if (course.pricing_type === PricingType.FREE || !course.price_etb) {
      throw new BadRequestException('This course is free — enroll directly via POST /enrollments');
    }
    const existing = await this.payments.findOne({
      where: { learner_id: ctx.id, course_id: courseId, status: PaymentStatus.CONFIRMED },
    });
    if (existing) throw new BadRequestException('You already own this course');

    // tx_ref is OURS: SDK-style TX-XXXX reference, generated server-side.
    // Clients can never supply one (webhook idempotency hangs off it).
    const txRef = await this.chapa.generateTxRef();
    const gatewayUrl = env('GATEWAY_PUBLIC_URL', 'http://localhost:4000');
    const webUrl = env('WEB_URL', 'http://localhost:3000');
    const learner = await this.learnerInfo(ctx.id);
    const [firstName, ...rest] = (learner.name || 'EthiopiaLearn Learner').trim().split(/\s+/);

    // Local-dev URL handling: Chapa's SDK validation rejects `localhost` URLs
    // (no TLD), and Chapa's servers can't call a localhost callback anyway.
    //  - return_url: browser-side redirect, so the loopback IP form works —
    //    the return page bounces 127.0.0.1 back to localhost to keep the
    //    login session's origin.
    //  - callback_url: server→server; only sent when publicly reachable. In
    //    production register the dashboard webhook + set GATEWAY_PUBLIC_URL.
    const isLocal = (u: string) => /\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(u);
    const returnUrl = `${webUrl.replace('//localhost', '//127.0.0.1')}/payment/return?course_id=${courseId}&tx_ref=${txRef}`;
    const callbackUrl = isLocal(gatewayUrl) ? undefined : `${gatewayUrl}/api/v1/payments/webhook/chapa`;

    const payment = await this.payments.save(
      this.payments.create({
        learner_id: ctx.id,
        course_id: courseId,
        amount_etb: course.price_etb.toFixed(2),
        method: PaymentMethod.CHAPA,
        status: PaymentStatus.PENDING,
        chapa_tx_ref: txRef,
        payee_id: course.owner_id,
        payee_type: course.owner_type,
        course_title: course.title,
      }),
    );

    // chapa-nestjs InitializeOptions shape: names required, amount as string.
    const customerEmail = ctx.email || learner.email;
    const initOpts = {
      first_name: firstName,
      last_name: rest.join(' ') || firstName,
      email: customerEmail,
      currency: 'ETB' as const,
      amount: course.price_etb.toFixed(2),
      tx_ref: txRef,
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      return_url: returnUrl,
      customization: { title: 'EthiopiaLearn'.slice(0, 16), description: course.title.slice(0, 100) },
    };
    // Chapa validates the customer email DOMAIN for deliverability and rejects
    // non-mainstream domains (e.g. the *.et demo accounts). Our own receipt goes
    // to the learner's real address via the notification service, so if Chapa
    // refuses the email we retry once with a configured, gateway-accepted
    // fallback rather than blocking the purchase.
    let checkout: { checkout_url: string };
    try {
      checkout = await this.chapa.initialize(initOpts);
    } catch (err) {
      const fallback = env('CHAPA_FALLBACK_EMAIL', '');
      if (fallback && fallback !== customerEmail && /validation\.email|valid email/i.test((err as Error).message)) {
        this.logger.warn(`Chapa rejected customer email "${customerEmail}"; retrying with fallback "${fallback}"`);
        checkout = await this.chapa.initialize({ ...initOpts, email: fallback });
      } else {
        throw err;
      }
    }
    const { checkout_url } = checkout;

    payment.chapa_checkout_url = checkout_url;
    await this.payments.save(payment);
    return { checkout_url, tx_ref: txRef, payment_id: payment.id };
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
   * undeliverable — e.g. local dev where Chapa cannot reach the machine). The
   * browser's word grants NOTHING: the server asks Chapa's verify API directly
   * and applies exactly the same rules as the webhook path. Mock mode never
   * short-circuits here — the mock flow must go through its signed webhook.
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
   * Safety net for missed webhooks and abandoned return pages: a completed
   * checkout must never stay pending just because the browser never came back
   * (webhooks can't reach local dev at all). Every 2 minutes, ask Chapa about
   * recent pending payments and apply the standard verification rules. Live
   * mode only — the mock flow always goes through its signed webhook.
   */
  @Cron('*/2 * * * *')
  async sweepPendingPayments(): Promise<void> {
    if (chapaMode() !== 'live') return;
    const now = Date.now();
    const rows = await this.payments.find({
      where: {
        status: PaymentStatus.PENDING,
        method: PaymentMethod.CHAPA,
        // Skip the newest minute (checkout may still be in progress) and cap
        // at 24h — older rows are abandoned checkouts, harmless as pending.
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
   * The single place a payment becomes confirmed/failed. Idempotent; cross-
   * checks the gateway-verified amount and currency against our ledger row
   * before publishing PaymentConfirmed (the only event that grants access).
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
      await this.emitConfirmed(payment);
      this.logger.log(`payment ${payment.id} (${payment.chapa_tx_ref}) confirmed via ${source}`);
      return { processed: true, reason: 'confirmed' };
    }

    if (verification.status === 'failed') {
      payment.status = PaymentStatus.FAILED;
      payment.webhook_received_at = new Date();
      await this.payments.save(payment);
      await this.emitFailed(payment, 'failed');
      this.logger.log(`payment ${payment.id} (${payment.chapa_tx_ref}) marked failed via ${source}`);
      return { processed: true, reason: 'failed' };
    }

    this.logger.warn(`verify says ${payment.chapa_tx_ref} is still pending at the gateway (${source})`);
    return { processed: false, reason: 'still pending at gateway' };
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
    const course = await this.internal.get<CourseInfo>(`/api/v1/internal/courses/${dto.course_id}`);
    if (!course.price_etb) throw new BadRequestException('Course has no price');
    const payment = await this.payments.save(
      this.payments.create({
        learner_id: dto.learner_id,
        course_id: dto.course_id,
        amount_etb: course.price_etb.toFixed(2),
        method: PaymentMethod.BANK_TRANSFER,
        status: PaymentStatus.CONFIRMED,
        chapa_tx_ref: `bank-${uuidv4()}`,
        webhook_received_at: new Date(),
        payee_id: course.owner_id,
        payee_type: course.owner_type,
        course_title: course.title,
      }),
    );
    this.logger.log(`bank transfer recorded by admin ${adminId} for ${dto.course_id}`);
    await this.emitConfirmed(payment);
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
    // Resolve payer names/emails once per unique learner (small pages, admin-only).
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

  private publicView(p: Payment) {
    return {
      id: p.id,
      course_id: p.course_id,
      course_title: p.course_title,
      amount_etb: Number(p.amount_etb),
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

  private async learnerInfo(learnerId: string): Promise<{ email: string; name: string }> {
    try {
      return await this.internal.get<{ email: string; name: string }>(`/api/v1/internal/users/${learnerId}`);
    } catch {
      return { email: '', name: '' };
    }
  }
}
