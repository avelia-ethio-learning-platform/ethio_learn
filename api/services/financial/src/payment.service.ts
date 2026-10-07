import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { Between, DataSource, EntityManager, In, IsNull, LessThan, MoreThan, Not, Repository } from 'typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { BrokerPublishError, env, envInt, EventBusService, InternalHttpClient, internalPath, isUniqueViolation, stableEventId, UserContext } from '@ethiopialearn/common';
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
import { CHAPA_PROVIDER, ChapaProvider, ChapaVerification, chapaMode, MockChapaProvider } from './chapa.provider';
import { Payment, PLATFORM_PAYEE_ID } from './entities';
import { CouponQuote, couponUnavailable, GrowthService, WalletCredit } from './growth.service';

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

/**
 * Completes a confirmed payment of one purpose: publishes the event that
 * grants access (through `publishConfirmed`) after any state change it needs.
 * Runs after the confirmation commits and again from the re-publish cron
 * until it succeeds, so it must be idempotent.
 */
type PurposeHandler = (payment: Payment) => Promise<void>;

/** Every path that can confirm or fail a payment; it goes in the log line. */
export type ConfirmSource = 'webhook' | 'reconcile' | 'sweep' | 'wallet' | 'coupon' | 'bank_transfer' | 'checkout';

/** Settlements without a gateway: they claim only a pending row (see confirmPayment). */
const INSTANT_SOURCES: ReadonlySet<ConfirmSource> = new Set(['wallet', 'coupon']);

/**
 * Why a checkout failed its own payment row. A superseded row belongs to a
 * payer who is retrying, and the other two to a payer who has just seen the
 * error in the response, so these send no PaymentFailed notice. `error` (any
 * other throw) and the gateway's own reasons do.
 */
type CheckoutFailReason = 'superseded' | 'wallet_insufficient' | 'checkout_open_failed' | 'error';
const SILENT_FAIL_REASONS: ReadonlySet<string> = new Set<CheckoutFailReason>(['superseded', 'wallet_insufficient', 'checkout_open_failed']);

/** 409 for a checkout whose row a retry of the same purchase superseded before it could be returned. */
const REPLACED_BY_RETRY = 'A newer checkout for this purchase replaced this one.';

/** HH:MM in Addis Ababa, for "try again after" in a coupon refusal. */
const HOLD_ENDS_AT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** How long an open checkout holds its coupon (COUPON_HOLD_MINUTES, default 60). */
function couponHoldMs(): number {
  return envInt('COUPON_HOLD_MINUTES', 60) * 60_000;
}

/**
 * Whether an open payment is for the same purchase as this checkout: the same
 * course bought for oneself (the payer is the learner), or the same gift, pay
 * request or bulk order row (`meta`).
 */
function isSamePurchase(p: Payment, input: SessionInput): boolean {
  if ((p.purpose ?? PaymentPurpose.COURSE) !== input.purpose) return false;
  const sameMeta = (key: 'sponsorship_id' | 'bulk_purchase_id') => input.meta?.[key] != null && p.meta?.[key] === input.meta[key];
  switch (input.purpose) {
    case PaymentPurpose.COURSE:
      return p.course_id === input.courseId;
    case PaymentPurpose.GIFT:
    case PaymentPurpose.PAY_REQUEST:
      return sameMeta('sponsorship_id');
    case PaymentPurpose.BULK:
      return sameMeta('bulk_purchase_id');
    default:
      return false;
  }
}

export interface WebhookOutcome {
  processed: boolean;
  reason: string;
}

/** Re-publish confirmed payments whose access events weren't acknowledged, once they are this old. */
const EFFECTS_RETRY_AFTER_MS = 60_000;
const EFFECTS_BATCH = 50;

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
  private completingEffects = false;

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @Inject(CHAPA_PROVIDER) private readonly chapa: ChapaProvider,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
    private readonly growth: GrowthService,
    private readonly dataSource: DataSource,
  ) {}

  /** Other services register what a CONFIRMED payment of a purpose must publish to grant access (see PurposeHandler). */
  onPurposeConfirmed(purpose: PaymentPurpose, handler: PurposeHandler) {
    const list = this.purposeHandlers.get(purpose) ?? [];
    list.push(handler);
    this.purposeHandlers.set(purpose, list);
  }

  async courseInfo(courseId: string): Promise<CourseInfo> {
    return this.internal.get<CourseInfo>(internalPath`/api/v1/internal/courses/${courseId}`);
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
   * is created FIRST either way — every attempt is recorded. With a coupon,
   * the row is inserted under the coupon's lock and is that checkout's hold
   * on a use (openCouponCheckout).
   *
   * Every failure after the insert fails the row through the guarded fail
   * path before the error reaches the caller, which releases a coupon hold.
   */
  async createSession(input: SessionInput): Promise<SessionResult> {
    if (input.useWallet && input.purpose === PaymentPurpose.WALLET_TOPUP) throw new BadRequestException('Cannot top up a wallet from a wallet');
    const quote = input.courseId
      ? await this.growth.quote(input.courseId, input.listPriceEtb, input.couponCode)
      : { coupon: null, list_price_etb: input.listPriceEtb, discount_etb: 0, amount_due_etb: input.listPriceEtb };
    const due = quote.amount_due_etb;

    // tx_ref is OURS: SDK-style TX-XXXX reference, generated server-side.
    // Clients can never supply one (webhook idempotency hangs off it).
    const txRef = await this.chapa.generateTxRef();
    const draft = this.payments.create({
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
    });
    const opened = quote.coupon ? await this.openCouponCheckout(input, quote, draft) : { payment: await this.payments.save(draft) };
    if ('reused' in opened) return opened.reused;
    const { payment } = opened;

    const result = (checkoutUrl: string | null, confirmed: boolean): SessionResult => ({
      payment_id: payment.id,
      tx_ref: txRef,
      checkout_url: checkoutUrl,
      confirmed,
      amount_etb: due,
      discount_etb: quote.discount_etb,
    });

    let reason: CheckoutFailReason = 'error';
    try {
      // 100% off → nothing to charge. Keep the row for the audit trail.
      if (due <= 0) {
        payment.method = PaymentMethod.COUPON;
        await this.settleInstantly(payment, 'coupon');
        return result(null, true);
      }

      if (input.useWallet) {
        // The debit happens inside the confirmation and throws a readable
        // error (a BadRequestException, its only one) when the balance is too
        // low, which rolls the confirmation back and leaves the row pending.
        payment.method = PaymentMethod.WALLET;
        try {
          await this.settleInstantly(payment, 'wallet');
        } catch (err) {
          if (err instanceof BadRequestException) reason = 'wallet_insufficient';
          throw err;
        }
        return result(null, true);
      }

      reason = 'checkout_open_failed';
      const checkoutUrl = await this.openChapaCheckout(payment, input);
      reason = 'error';
      // Only the URL, and only onto a row still pending. A retry of the same
      // purchase (a double-click) may have superseded this row while Chapa
      // was answering; the retry's checkout is then the live one, and this
      // URL is never handed out. (A save() would also write back the status
      // this request read, undoing that supersede.)
      const saved = await this.payments.update({ id: payment.id, status: PaymentStatus.PENDING }, { chapa_checkout_url: checkoutUrl });
      if (saved.affected !== 1) {
        this.logger.log(`payment ${payment.id} (${payment.chapa_tx_ref}): replaced while Chapa opened its checkout; the checkout was not returned`);
        throw new ConflictException(REPLACED_BY_RETRY);
      }
      payment.chapa_checkout_url = checkoutUrl;
      return result(checkoutUrl, false);
    } catch (err) {
      await this.failCheckout(payment, reason);
      throw err;
    }
  }

  /**
   * Decisions 11-12 (P1-13): a coupon checkout's row is inserted under the
   * coupon's row lock, so checkouts of one coupon queue and each counts the
   * others. A hold is a pending payment with the code created within
   * COUPON_HOLD_MINUTES; it lapses on its own. In one transaction:
   *  1. lock the coupon and re-check that it is active and unexpired;
   *  2. lock the payer's own open checkouts with the code. One for this
   *     same purchase: a Chapa retry at the same amount gets it back (no new
   *     row); otherwise it is superseded (failed), and a late payment of it
   *     still confirms;
   *  3. refuse when confirmed uses plus holds reach max_uses. Confirmed uses
   *     are GREATEST(uses, confirmed payments), since the savepoint around
   *     uses + 1 can roll back;
   *  4. refuse when the payer's confirmed uses plus their holds reach
   *     max_uses_per_user;
   *  5. insert the row.
   * The payer's open checkouts for other purchases are holds like anyone
   * else's. When they are what blocks the payer, the refusal says so.
   */
  private async openCouponCheckout(input: SessionInput, quote: CouponQuote, draft: Payment): Promise<{ payment: Payment } | { reused: SessionResult }> {
    const code = quote.coupon!.code;
    const due = quote.amount_due_etb;
    const holdMs = couponHoldMs();
    const superseded: Payment[] = [];
    const opened = await this.dataSource.transaction(async (m): Promise<{ payment: Payment } | { reused: SessionResult }> => {
      const payments = m.getRepository(Payment);
      const coupon = await this.growth.lockCoupon(m, code);
      const unavailable = couponUnavailable(coupon);
      if (unavailable || !coupon) throw new BadRequestException(unavailable);

      const held = { coupon_code: code, status: PaymentStatus.PENDING, created_at: MoreThan(new Date(Date.now() - holdMs)) };
      // FOR UPDATE (after the coupon, the order a confirmation uses too): a
      // checkout still writing its Chapa URL onto one of these rows either
      // committed first, so its URL is seen here, or waits for this
      // transaction and then finds its row superseded (createSession's 409).
      const mine = await payments.find({ where: { ...held, learner_id: input.payer.id }, order: { created_at: 'ASC' }, lock: { mode: 'pessimistic_write' } });
      const same = mine.filter((p) => isSamePurchase(p, input));
      const latest = same[same.length - 1];
      const reusable =
        latest && due > 0 && !input.useWallet && latest.chapa_checkout_url && Number(latest.amount_etb).toFixed(2) === due.toFixed(2) ? latest : null;
      for (const p of same) if (p !== reusable && (await this.failPayment(p, 'checkout', 'superseded', m))) superseded.push(p);
      if (reusable) {
        this.logger.log(`payment ${reusable.id} (${reusable.chapa_tx_ref}): open checkout returned to a retry of the same purchase`);
        return {
          reused: {
            payment_id: reusable.id,
            tx_ref: reusable.chapa_tx_ref,
            checkout_url: reusable.chapa_checkout_url,
            confirmed: false,
            amount_etb: due,
            discount_etb: Number(reusable.discount_etb),
          },
        };
      }
      // Oldest first: the payer's holds on other purchases.
      const mineHeld = mine.filter((p) => !same.includes(p));

      if (coupon.max_uses != null) {
        const confirmed = Math.max(coupon.uses, await payments.count({ where: { coupon_code: code, status: PaymentStatus.CONFIRMED } }));
        // How many holds would have to lapse for this checkout to fit.
        const over = confirmed + (await payments.count({ where: held })) - coupon.max_uses + 1;
        if (over > 0 && over <= mineHeld.length) throw this.heldByYou(mineHeld[over - 1], holdMs);
        if (over > 0) throw new BadRequestException('This coupon has been fully used.');
      }
      if (coupon.max_uses_per_user != null) {
        const used = await payments.count({ where: { coupon_code: code, status: PaymentStatus.CONFIRMED, learner_id: input.payer.id } });
        if (used >= coupon.max_uses_per_user) throw new BadRequestException("You've already used this coupon.");
        const over = used + mineHeld.length - coupon.max_uses_per_user + 1;
        if (over > 0) throw this.heldByYou(mineHeld[over - 1], holdMs);
      }

      return { payment: await payments.save(draft) };
    });
    // Only now: a refusal later in the transaction rolls the supersede back.
    const by = 'reused' in opened ? opened.reused.payment_id : opened.payment.id;
    for (const p of superseded) this.logger.log(`payment ${p.id} (${p.chapa_tx_ref}) marked failed via checkout (superseded by payment ${by})`);
    return opened;
  }

  /** 400 naming the payer's own open checkout that holds the coupon, with its link when it has one. */
  private heldByYou(hold: Payment, holdMs: number): BadRequestException {
    const until = HOLD_ENDS_AT.format(new Date(hold.created_at.getTime() + holdMs));
    return new BadRequestException({
      statusCode: 400,
      message: `This coupon is held by another checkout you started. Finish paying it, or try again after ${until}.`,
      error: 'Bad Request',
      ...(hold.chapa_checkout_url ? { checkout_url: hold.chapa_checkout_url } : {}),
    });
  }

  /**
   * Confirms a 100% coupon or wallet payment in the request. Its row can only
   * have left `pending` because a concurrent retry of the same purchase
   * superseded it; that retry settles the purchase, so this one is refused.
   */
  private async settleInstantly(payment: Payment, source: 'coupon' | 'wallet'): Promise<void> {
    if (await this.confirmPayment(payment, source)) return;
    throw new ConflictException(REPLACED_BY_RETRY);
  }

  /** Fails a checkout's row after an error, which releases its coupon hold. A failure here is logged; the hold then lapses. */
  private async failCheckout(payment: Payment, reason: CheckoutFailReason): Promise<void> {
    try {
      await this.failPayment(payment, 'checkout', reason);
    } catch (err) {
      this.logger.error(`payment ${payment.id} (${payment.chapa_tx_ref}): could not mark the failed checkout failed (${reason}): ${(err as Error).message}`);
    }
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
   * Spec §6 steps 4-7. NEVER trust an unverified webhook: the HMAC in
   * `x-chapa-signature` must match before anything is processed, and even a
   * signed webhook only prompts a verify() call, whose answer decides. The
   * controller answers 401 for 'invalid signature' and 200 otherwise (Chapa
   * retries on non-200).
   */
  async handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookOutcome> {
    if (!this.verifySignature(rawBody, headers['x-chapa-signature'])) {
      this.logger.warn('webhook rejected: x-chapa-signature verification failed');
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

    // Step 7: duplicate guard — a settled payment needs no verify() call. The
    // confirmation itself is guarded too, for webhooks that race each other.
    if (payment.status === PaymentStatus.CONFIRMED) return { processed: true, reason: 'duplicate — already confirmed' };
    if (payment.status === PaymentStatus.REFUNDED) return { processed: true, reason: 'no change — payment was refunded' };

    // Step 5: the webhook's claim grants nothing, success or failure — ask Chapa directly.
    const verification = await this.chapa.verify(payment.chapa_tx_ref);
    return this.applyVerification(payment, verification, 'webhook');
  }

  /**
   * Learner-triggered fallback for a payment stuck pending (webhook delayed or
   * undeliverable), or a failed Chapa checkout paid late, such as one a retry
   * superseded. The browser's word grants NOTHING: the server asks Chapa's
   * verify API directly and applies exactly the same rules as the webhook path
   * (a failed row only ever becomes confirmed; a failed or pending answer
   * leaves it as it is, with no second notice).
   *
   * A failed row is checked only when it has a checkout URL. Without one
   * (wallet, 100% coupon, or a checkout that failed before Chapa opened it)
   * there was never anything to pay.
   */
  async reconcile(ctx: UserContext, txRef: string) {
    const payment = await this.payments.findOne({ where: { chapa_tx_ref: txRef, learner_id: ctx.id } });
    if (!payment) throw new NotFoundException('Payment not found');
    const payable = payment.status === PaymentStatus.PENDING || (payment.status === PaymentStatus.FAILED && !!payment.chapa_checkout_url);
    if (payable && chapaMode() === 'live') {
      const verification = await this.chapa.verify(payment.chapa_tx_ref);
      await this.applyVerification(payment, verification, 'reconcile');
      // Report the row as it is now, whichever path (webhook, sweep, this call) settled it.
      return this.publicView((await this.payments.findOne({ where: { id: payment.id } })) ?? payment);
    }
    return this.publicView(payment);
  }

  /**
   * Safety net for missed webhooks and abandoned return pages. Every 2 minutes,
   * ask Chapa about recent pending payments and apply the standard rules.
   *
   * Then it re-checks recent failed Chapa payments that had a checkout page,
   * such as one a retry of the same purchase superseded. One Chapa reports
   * paid is confirmed exactly as its webhook would confirm it (paying both
   * pages is a duplicate purchase, a refund case); one reported unpaid or
   * still pending stays failed. A failed row with no checkout URL is never
   * selected: Chapa never opened its page, so it can't have been paid.
   */
  @Cron('*/2 * * * *')
  async sweepPendingPayments(): Promise<void> {
    if (chapaMode() !== 'live') return;
    const now = Date.now();
    const recent = Between(new Date(now - 24 * 3600_000), new Date(now - 60_000));
    const pending = await this.payments.find({
      where: { status: PaymentStatus.PENDING, method: PaymentMethod.CHAPA, created_at: recent },
      order: { created_at: 'DESC' },
      take: 25,
    });
    const failed = await this.payments.find({
      where: {
        status: PaymentStatus.FAILED,
        method: PaymentMethod.CHAPA,
        chapa_tx_ref: Not(IsNull()),
        chapa_checkout_url: Not(IsNull()),
        created_at: recent,
      },
      order: { created_at: 'DESC' },
      take: 10,
    });
    for (const payment of [...pending, ...failed]) {
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
   * notification service). Runs hourly.
   *
   * Each row is claimed with a conditional update (still pending, not yet
   * nudged) and never saved: a save would write this run's stale `pending`
   * back over a confirmation that landed in the meantime. Only the run that
   * claims a row sends its reminder, so each payment gets at most one. The
   * claim comes before the publish: a publish that fails after the claim
   * loses that one reminder, and ends the run, rather than sending two.
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
    let sent = 0;
    for (const payment of rows) {
      const owned = await this.ownsCourse(payment.learner_id, payment.course_id);
      const claimed = await this.payments.update({ id: payment.id, status: PaymentStatus.PENDING, nudged_at: IsNull() }, { nudged_at: new Date() });
      // Confirmed or nudged since the select; or the learner already owns the course through another payment.
      if (claimed.affected !== 1 || owned) continue;
      const learner = await this.learnerInfo(payment.learner_id);
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
      sent += 1;
    }
    if (sent) this.logger.log(`abandoned-checkout nudges sent: ${sent}`);
  }

  /**
   * Turns a gateway verification into a confirmation or a failure. Cross-
   * checks the verified amount and currency against our ledger row first: in
   * live mode Chapa must report both, and a mismatch fails the payment.
   */
  private async applyVerification(payment: Payment, verification: ChapaVerification, source: ConfirmSource): Promise<WebhookOutcome> {
    if (verification.status === 'success') {
      const live = chapaMode() === 'live';
      if (live && (verification.amount == null || verification.currency == null)) {
        this.logger.warn(`verify reported ${payment.chapa_tx_ref} paid without an amount or currency (${source}); NOT confirming yet`);
        return { processed: false, reason: 'amount not verified' };
      }
      // Tamper guard: the verified amount must match what we quoted.
      let mismatch: string | null = null;
      if (verification.amount != null && Math.abs(verification.amount - Number(payment.amount_etb)) > 0.009) {
        mismatch = 'amount mismatch';
        this.logger.error(`amount mismatch on ${payment.chapa_tx_ref}: gateway verified ${verification.amount}, ledger says ${payment.amount_etb} — NOT confirming`);
      } else if (verification.currency && verification.currency !== 'ETB') {
        mismatch = 'currency mismatch';
        this.logger.error(`currency mismatch on ${payment.chapa_tx_ref}: ${verification.currency} — NOT confirming`);
      }
      if (mismatch) {
        await this.failPayment(payment, source, mismatch);
        return { processed: false, reason: mismatch };
      }
      const won = await this.confirmPayment(payment, source);
      return won ? { processed: true, reason: 'confirmed' } : { processed: true, reason: 'duplicate — already confirmed' };
    }

    if (verification.status === 'failed') {
      const failed = await this.failPayment(payment, source, 'failed');
      return failed ? { processed: true, reason: 'failed' } : { processed: true, reason: 'no change — payment was not pending' };
    }

    this.logger.warn(`verify says ${payment.chapa_tx_ref} is still pending at the gateway (${source})`);
    return { processed: false, reason: 'still pending at gateway' };
  }

  /**
   * The single place a payment becomes confirmed, for every source (webhook,
   * reconcile, sweep, wallet, coupon, bank transfer). Exactly once (P0-04):
   * a conditional UPDATE decides the winner, so of any number of concurrent
   * callers only one runs the effects. A failed payment can still be
   * confirmed through the gateway, since Chapa's verify() is authoritative.
   * An instant settlement (wallet, 100% coupon) claims only a pending row:
   * one a retry of the same purchase superseded is never settled as well.
   *
   * - First, a payment with a coupon locks the coupon row, as a checkout
   *   does: one lock order (coupon, then payment) on both paths, so a
   *   checkout superseding this payment can't deadlock with it.
   * - In the transaction, with the status change: the effects that ARE the
   *   purchase (wallet debit, top-up credit). They commit or roll back with it.
   * - In a savepoint each: coupon use, cashback, referral reward. A failure
   *   there rolls back only that savepoint and never blocks access. The
   *   cashback and reward are pending, held from this confirmation's `now`.
   * - After commit, winner only: WalletCredited, then the access events
   *   (completeEffects), which the re-publish cron retries if they fail.
   *
   * Returns false for the losers. Throws only when the purchase itself fails
   * (a wallet that can't cover it), leaving the payment as it was.
   */
  private async confirmPayment(payment: Payment, source: ConfirmSource): Promise<boolean> {
    const purpose = payment.purpose ?? PaymentPurpose.COURSE;
    const amount = Number(payment.amount_etb);
    // HTTP before the transaction keeps its row lock short. learnerInfo never throws.
    const buyerName = this.growth.rewardsApply(payment) ? (await this.learnerInfo(payment.learner_id)).name : '';
    const now = new Date();
    const credits: WalletCredit[] = [];

    const won = await this.dataSource.transaction(async (m) => {
      if (payment.coupon_code) await this.inSavepoint(m, payment, 'coupon lock', (sp) => this.growth.lockCoupon(sp, payment.coupon_code!));
      const claimable = INSTANT_SOURCES.has(source) ? [PaymentStatus.PENDING] : [PaymentStatus.PENDING, PaymentStatus.FAILED];
      const claimed = await m.getRepository(Payment).update(
        { id: payment.id, status: In(claimable) },
        {
          status: PaymentStatus.CONFIRMED,
          method: payment.method,
          webhook_received_at: now,
          // A top-up grants no access, so it has no event to wait for.
          ...(purpose === PaymentPurpose.WALLET_TOPUP ? { effects_completed_at: now } : {}),
        },
      );
      if (claimed.affected !== 1) return false;

      if (payment.method === PaymentMethod.WALLET) {
        await this.growth.debitWith(m, payment.learner_id, amount, 'purchase', payment.id, `Paid for "${payment.course_title}"`);
      }
      if (purpose === PaymentPurpose.WALLET_TOPUP) {
        const topup = await this.growth.creditWith(m, payment.learner_id, amount, 'topup', payment.id, 'Wallet top-up via Chapa');
        if (topup) credits.push(topup);
      }

      await this.inSavepoint(m, payment, 'coupon use', (sp) => this.growth.recordCouponUse(payment.coupon_code ?? null, sp));
      if (purpose !== PaymentPurpose.WALLET_TOPUP) {
        const cashback = await this.inSavepoint(m, payment, 'cashback', (sp) => this.growth.creditCashback(sp, payment, now));
        if (cashback) credits.push(cashback);
        const reward = await this.inSavepoint(m, payment, 'referral reward', (sp) => this.growth.rewardReferrer(sp, payment, buyerName, now));
        if (reward) credits.push(reward);
      }
      return true;
    });

    if (!won) {
      this.logger.log(`payment ${payment.id} (${payment.chapa_tx_ref}): duplicate confirmation via ${source} ignored`);
      return false;
    }
    payment.status = PaymentStatus.CONFIRMED;
    payment.webhook_received_at = now;
    if (purpose === PaymentPurpose.WALLET_TOPUP) payment.effects_completed_at = now;
    this.logger.log(`payment ${payment.id} (${payment.chapa_tx_ref}, ${purpose}) confirmed via ${source}`);

    await this.growth.announceCredits(credits);
    if (!payment.effects_completed_at) {
      try {
        await this.completeEffects(payment);
      } catch (err) {
        // The payment is confirmed and the caller (a webhook among them) must
        // succeed; the re-publish cron finishes the job.
        this.logger.warn(`payment ${payment.id}: access events not completed yet, the re-publish cron will retry: ${(err as Error).message}`);
      }
    }
    return true;
  }

  /** Runs fn in a savepoint of `m`; a failure rolls back only that savepoint and is logged. */
  private async inSavepoint<T>(m: EntityManager, payment: Payment, label: string, fn: (sp: EntityManager) => Promise<T>): Promise<T | null> {
    try {
      return await m.transaction(fn);
    } catch (err) {
      this.logger.error(`payment ${payment.id}: ${label} failed and was rolled back; the confirmation stands: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Guarded like confirmation: only a pending payment fails, and PaymentFailed
   * goes out once. Only the notification service consumes PaymentFailed, so
   * the checkout's own reasons (SILENT_FAIL_REASONS) don't publish it. Runs in
   * `manager`'s transaction when given (a superseded row, which publishes
   * nothing before that transaction commits); the caller then writes the log
   * line after the commit.
   */
  private async failPayment(payment: Payment, source: ConfirmSource, reason: string, manager?: EntityManager): Promise<boolean> {
    const repo = manager ? manager.getRepository(Payment) : this.payments;
    const failed = await repo.update({ id: payment.id, status: PaymentStatus.PENDING }, { status: PaymentStatus.FAILED, webhook_received_at: new Date() });
    if (failed.affected !== 1) return false;
    payment.status = PaymentStatus.FAILED;
    // In the caller's transaction a later rollback would undo this, so that caller logs it once it commits.
    if (!manager) this.logger.log(`payment ${payment.id} (${payment.chapa_tx_ref}) marked failed via ${source} (${reason})`);
    if (SILENT_FAIL_REASONS.has(reason)) return true;
    if ((payment.purpose ?? PaymentPurpose.COURSE) === PaymentPurpose.COURSE) {
      try {
        await this.emitFailed(payment, reason);
      } catch (err) {
        this.logger.warn(`payment ${payment.id}: PaymentFailed not published: ${(err as Error).message}`);
      }
    }
    return true;
  }

  /**
   * Publishes the events that grant access for a confirmed payment and, once
   * the broker has acknowledged them all, marks the payment done (P0-05).
   * Course → PaymentConfirmed; other purposes → their registered handler.
   * Throws BrokerPublishError when the broker didn't acknowledge, any other
   * error when this payment can't be completed.
   */
  private async completeEffects(payment: Payment): Promise<void> {
    const purpose = payment.purpose ?? PaymentPurpose.COURSE;
    if (purpose === PaymentPurpose.COURSE) await this.emitConfirmed(payment);
    for (const handler of this.purposeHandlers.get(purpose) ?? []) await handler(payment);
    await this.payments.update({ id: payment.id, effects_completed_at: IsNull() }, { effects_completed_at: new Date() });
    payment.effects_completed_at ??= new Date();
  }

  /**
   * Re-publishes the access events of confirmed payments that aren't marked
   * done, oldest first (P0-05). Runs in every CHAPA_MODE. Skips a tick while
   * the previous run is still going (with the broker down a run can outlast
   * the interval), stops at the first broker failure, and logs and skips a
   * payment that fails for its own reason so it can't block the rest.
   * Returns null when the tick was skipped.
   */
  @Cron('*/2 * * * *')
  async completePendingEffects(): Promise<{ completed: number; failed: number } | null> {
    if (this.completingEffects) {
      this.logger.warn('re-publish run still in progress; skipping this tick');
      return null;
    }
    this.completingEffects = true;
    let completed = 0;
    let failed = 0;
    try {
      const cutoff = new Date(Date.now() - EFFECTS_RETRY_AFTER_MS);
      const pending = { status: PaymentStatus.CONFIRMED, effects_completed_at: IsNull() };
      const rows = await this.payments.find({
        where: [
          { ...pending, webhook_received_at: LessThan(cutoff) },
          { ...pending, webhook_received_at: IsNull(), created_at: LessThan(cutoff) },
        ],
        order: { webhook_received_at: 'ASC' },
        take: EFFECTS_BATCH,
      });
      for (const payment of rows) {
        try {
          await this.completeEffects(payment);
          completed += 1;
        } catch (err) {
          if (err instanceof BrokerPublishError) {
            this.logger.warn(`re-publish run stopped at payment ${payment.id}: ${err.message}`);
            break;
          }
          failed += 1;
          this.logger.error(`payment ${payment.id}: could not complete its access events, skipped this run: ${(err as Error).message}`);
        }
      }
      if (rows.length) this.logger.log(`re-publish run: ${completed} of ${rows.length} confirmed payment(s) completed, ${failed} failed`);
      return { completed, failed };
    } finally {
      this.completingEffects = false;
    }
  }

  /**
   * DEV-ONLY (CHAPA_MODE=mock, never in production): the mock checkout page
   * calls this; we deliver a properly HMAC-signed webhook to ourselves so the
   * real path runs. The mock gateway's verify() then reports the outcome the
   * checkout chose.
   */
  async mockComplete(txRef: string, outcome: 'success' | 'failed') {
    if (process.env.NODE_ENV === 'production' || chapaMode() !== 'mock') throw new ForbiddenException('Mock checkout disabled');
    if (this.chapa instanceof MockChapaProvider) this.chapa.settle(txRef, outcome);
    const raw = Buffer.from(JSON.stringify({ tx_ref: txRef, status: outcome, event: 'charge.complete' }));
    const signature = createHmac('sha256', env('CHAPA_WEBHOOK_SECRET', '')).update(raw).digest('hex');
    return this.handleWebhook(raw, { 'x-chapa-signature': signature });
  }

  /**
   * Manual bank-transfer fallback — platform admin marks it settled (spec §0.4).
   * The bank's reference is the idempotency key (`bank-<REF>`). In order:
   *  1. a payment with that reference: the same learner and course get it
   *     back (an exact replay, settled now if it was left pending or failed);
   *     anything else is a 409;
   *  2. a confirmed course payment for this learner and course: a 409. Read
   *     here, so it sees a Chapa payment confirmed moments ago, before the
   *     enrollment service has granted the entitlement. When that payment is
   *     this reference, recorded by a concurrent submit since step 1, it is
   *     judged by step 1 instead (and likewise at step 4);
   *  3. the learner exists: 404 when not, 503 when the lookup fails;
   *  4. the learner doesn't own the course another way (gift, seat,
   *     sponsorship): 409, and 503 when that can't be checked. Unlike
   *     checkout's ownsCourse, this fails closed;
   *  5. insert. A concurrent submit of the same reference that inserted first
   *     makes this insert fail on the unique index; the row is re-read and
   *     judged by step 1.
   * `created` is false for a replay (the controller answers 200, not 201).
   */
  async recordBankTransfer(
    adminId: string,
    dto: { learner_id: string; course_id: string; bank_reference: string },
  ): Promise<{ payment: Payment; created: boolean }> {
    const txRef = `bank-${dto.bank_reference}`;
    /** Step 1: the payment already recorded under this reference, judged by replayBankTransfer; undefined when there is none. */
    const replayed = async () => {
      const recorded = await this.payments.findOne({ where: { chapa_tx_ref: txRef } });
      return recorded ? { payment: await this.replayBankTransfer(adminId, recorded, dto), created: false } : undefined;
    };
    const first = await replayed();
    if (first) return first;

    const paid = await this.payments.findOne({
      where: { learner_id: dto.learner_id, course_id: dto.course_id, purpose: PaymentPurpose.COURSE, status: PaymentStatus.CONFIRMED },
    });
    if (paid) {
      const replay = await replayed();
      if (replay) return replay;
      throw new ConflictException('This learner already paid for the course');
    }

    try {
      await this.internal.get(internalPath`/api/v1/internal/users/${dto.learner_id}`);
    } catch (err) {
      // Phase 9c's typed PeerNotFoundError replaces this match on InternalHttpClient's message.
      if ((err as Error).message.endsWith('-> 404')) throw new NotFoundException('Learner not found');
      throw new ServiceUnavailableException("Couldn't check the learner. Try again.");
    }

    let entitlement: { entitlement_status: string };
    try {
      entitlement = await this.internal.get(internalPath`/api/v1/internal/entitlements?learner_id=${dto.learner_id}&course_id=${dto.course_id}`);
    } catch {
      throw new ServiceUnavailableException("Couldn't check enrollment. Try again.");
    }
    if (entitlement.entitlement_status === 'active') {
      const replay = await replayed();
      if (replay) return replay;
      throw new ConflictException('This learner already owns the course');
    }

    const course = await this.courseInfo(dto.course_id);
    if (!course.price_etb) throw new BadRequestException('Course has no price');
    let payment: Payment;
    try {
      // save() runs in a transaction of its own, rolled back on a failure, so
      // the re-read below runs outside it, not in an aborted transaction.
      payment = await this.payments.save(
        this.payments.create({
          learner_id: dto.learner_id,
          course_id: dto.course_id,
          amount_etb: course.price_etb.toFixed(2),
          list_price_etb: course.price_etb.toFixed(2),
          method: PaymentMethod.BANK_TRANSFER,
          status: PaymentStatus.PENDING,
          chapa_tx_ref: txRef,
          payee_id: course.owner_id,
          payee_type: course.owner_type,
          course_title: course.title,
          purpose: PaymentPurpose.COURSE,
        }),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await replayed();
      if (!winner) throw err;
      return winner;
    }
    this.logger.log(`payment ${payment.id} (${payment.chapa_tx_ref}): bank transfer recorded by admin ${adminId} for course ${dto.course_id}`);
    return { payment: await this.settleBankTransfer(payment), created: true };
  }

  /** Check 1: an exact replay gets the recorded payment back, settled if it wasn't; another learner or course is a 409. */
  private async replayBankTransfer(adminId: string, recorded: Payment, dto: { learner_id: string; course_id: string }): Promise<Payment> {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (!same(recorded.learner_id, dto.learner_id) || !same(recorded.course_id, dto.course_id)) {
      throw new ConflictException('This bank reference is already recorded for another payment.');
    }
    this.logger.log(`payment ${recorded.id} (${recorded.chapa_tx_ref}): bank transfer replayed by admin ${adminId} (${recorded.status})`);
    if (recorded.status !== PaymentStatus.PENDING && recorded.status !== PaymentStatus.FAILED) return recorded;
    return this.settleBankTransfer(recorded);
  }

  /** Confirms once (confirmPayment); when a concurrent submit confirmed it instead, reports the row as it is now. */
  private async settleBankTransfer(payment: Payment): Promise<Payment> {
    if (await this.confirmPayment(payment, 'bank_transfer')) return payment;
    return (await this.payments.findOne({ where: { id: payment.id } })) ?? payment;
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
      const e = await this.internal.get<{ entitlement_status: string }>(internalPath`/api/v1/internal/entitlements?learner_id=${learnerId}&course_id=${courseId}`);
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

  /**
   * Chapa's `x-chapa-signature` is HMAC-SHA256 of the payload, keyed by the
   * webhook secret. Which bytes it signs in practice (the raw body, or JSON
   * re-serialized as in Chapa's sample code) is unverified, so both are
   * accepted. `chapa-signature` is ignored: it is HMAC(secret, secret), the
   * same on every webhook, so anyone who saw one could replay it with any body.
   */
  private verifySignature(rawBody: Buffer, header: string | string[] | undefined): boolean {
    const presented = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
    if (!presented || !/^[0-9a-f]{64}$/.test(presented)) return false;
    const secret = env('CHAPA_WEBHOOK_SECRET', '');
    if (!secret) {
      this.logger.error('CHAPA_WEBHOOK_SECRET is not set: every webhook is rejected');
      return false;
    }
    const signature = Buffer.from(presented, 'hex');
    const bodies = [rawBody];
    try {
      bodies.push(Buffer.from(JSON.stringify(JSON.parse(rawBody.toString('utf8')))));
    } catch {
      /* not JSON: only the raw body can match */
    }
    return bodies.some((body) => timingSafeEqual(signature, createHmac('sha256', secret).update(body).digest()));
  }

  /**
   * THE event that grants entitlement for a course purchase, acknowledged by the broker.
   * Its id is stable per payment, so the cron's re-publish is the same event to the consumers' dedupe.
   */
  private async emitConfirmed(payment: Payment) {
    const learner = await this.learnerInfo(payment.learner_id);
    await this.bus.publishConfirmed<PaymentConfirmedPayload>(
      'PaymentConfirmed',
      {
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
      },
      { correlationId: payment.id, eventId: stableEventId(`${payment.id}:PaymentConfirmed`) },
    );
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
      return await this.internal.get<{ email: string; name: string }>(internalPath`/api/v1/internal/users/${learnerId}`);
    } catch {
      return { email: '', name: '' };
    }
  }
}
