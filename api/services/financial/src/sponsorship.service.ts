import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { dailyCapExceeded, Emit, env, envInt, EventBusService, InternalHttpClient, internalPath, OutboxService, recipientCapExceeded, UserContext } from '@ethiopialearn/common';
import {
  BulkPurchaseActivatedPayload,
  PayRequestCreatedPayload,
  PaymentPurpose,
  PricingType,
  Role,
  SponsorshipGrantedPayload,
  SponsorshipInvitedPayload,
  UserRegisteredPayload,
} from '@ethiopialearn/contracts';
import { BulkPurchase, Payment, Sponsorship } from './entities';
import { randomCode } from './growth.service';
import { bulkDiscountPercent, CourseInfo, PaymentService, SessionInput, SessionResult } from './payment.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAY_REQUESTS_PER_EMAIL_PER_DAY = 3;

interface UserInfo {
  id: string;
  name: string;
  email: string;
  role: string;
}

/**
 * Access paid for by someone other than the learner:
 *  - gifts ("buy this course for my sister")
 *  - pay requests ("ask my uncle to pay for me")
 *  - corporate bulk seats ("30 licences for our staff")
 * Every path ends in ONE event, SponsorshipGranted, which is the only
 * non-payment route to entitlement in the enrollment service.
 */
@Injectable()
export class SponsorshipService implements OnModuleInit {
  private readonly logger = new Logger(SponsorshipService.name);

  constructor(
    @InjectRepository(Sponsorship) private readonly sponsorships: Repository<Sponsorship>,
    @InjectRepository(BulkPurchase) private readonly bulk: Repository<BulkPurchase>,
    private readonly payments: PaymentService,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit() {
    this.payments.onPurposeConfirmed(PaymentPurpose.GIFT, (p) => this.onSponsoredPaymentConfirmed(p));
    this.payments.onPurposeConfirmed(PaymentPurpose.PAY_REQUEST, (p) => this.onSponsoredPaymentConfirmed(p));
    this.payments.onPurposeConfirmed(PaymentPurpose.BULK, (p) => this.onBulkPaid(p));
    // A seat waiting for an email that just signed up → grant it now.
    this.bus.subscribe<UserRegisteredPayload>('UserRegistered', async (p) => {
      await this.claimForEmail(p.user_id, p.email);
    });
  }

  // ---- Gifts -------------------------------------------------------------

  async createGift(
    ctx: UserContext,
    dto: { course_id: string; recipient_email: string; message?: string; coupon_code?: string | null; use_wallet?: boolean },
  ): Promise<SessionResult & { sponsorship_id: string }> {
    const course = await this.paidCourse(dto.course_id);
    const email = dto.recipient_email.trim().toLowerCase();
    if (email === (ctx.email ?? '').toLowerCase()) throw new BadRequestException('Use the normal checkout to buy a course for yourself');
    const recipient = await this.userByEmail(email);
    if (recipient && (await this.entitled(recipient.id, course.id))) throw new BadRequestException('That person already has this course');

    const giftsToday = await this.sponsorships.count({ where: { source: 'gift', sponsor_id: ctx.id, created_at: MoreThan(new Date(Date.now() - DAY_MS)) } });
    if (giftsToday >= envInt('GIFTS_PER_DAY', 10)) {
      this.logger.warn(`Gift cap hit: user ${ctx.id} POST /gifts`);
      throw dailyCapExceeded('gifts');
    }

    const me = await this.user(ctx.id);
    const s = await this.sponsorships.save(
      this.sponsorships.create({
        source: 'gift',
        status: 'pending_payment',
        sponsor_id: ctx.id,
        sponsor_name: me.name,
        recipient_user_id: recipient?.id ?? null,
        recipient_email: email,
        course_id: course.id,
        course_title: course.title,
        message: (dto.message ?? '').slice(0, 500),
        token: randomCode(24),
      }),
    );
    // Refused: no gift. Left behind, it would stay pending_payment and count toward the daily cap.
    const session = await this.checkoutOrUndo(
      {
        payer: ctx,
        purpose: PaymentPurpose.GIFT,
        courseId: course.id,
        courseTitle: course.title,
        listPriceEtb: course.price_etb!,
        payee: { id: course.owner_id, type: course.owner_type },
        couponCode: dto.coupon_code,
        useWallet: dto.use_wallet,
        meta: { sponsorship_id: s.id },
        returnPath: `/dashboard?gift=${s.id}`,
      },
      `gift ${s.id}`,
      () => this.sponsorships.delete({ id: s.id, status: 'pending_payment' }),
    );
    if (!session.confirmed) await this.sponsorships.update({ id: s.id, status: 'pending_payment' }, { payment_id: session.payment_id });
    return { ...session, sponsorship_id: s.id };
  }

  // ---- Pay requests ------------------------------------------------------

  async createPayRequest(ctx: UserContext, dto: { course_id: string; payer_email: string; message?: string }) {
    const course = await this.paidCourse(dto.course_id);
    if (await this.entitled(ctx.id, course.id)) throw new BadRequestException('You already own this course');
    const payerEmail = dto.payer_email.trim().toLowerCase();
    if (payerEmail === (ctx.email ?? '').toLowerCase()) throw new BadRequestException('Enter the email of the person who will pay');
    const payUrlFor = (token: string) => `${env('WEB_URL', 'http://localhost:3000')}/pay/${token}`;

    // The same open request (requester, course, payer) is returned again: no new row, no email, no cap.
    const open = await this.sponsorships.findOne({
      where: { source: 'pay_request', recipient_user_id: ctx.id, course_id: course.id, organization_name: payerEmail, status: In(['requested', 'pending_payment']) },
    });
    if (open) return { sponsorship_id: open.id, pay_url: payUrlFor(open.token), status: open.status };

    const since = MoreThan(new Date(Date.now() - DAY_MS));
    const mine = await this.sponsorships.count({ where: { source: 'pay_request', recipient_user_id: ctx.id, created_at: since } });
    if (mine >= envInt('PAY_REQUESTS_PER_DAY', 5)) {
      this.logger.warn(`Pay request cap hit: user ${ctx.id} POST /pay-requests`);
      throw dailyCapExceeded('pay requests');
    }
    const toThisEmail = await this.sponsorships.count({ where: { source: 'pay_request', organization_name: payerEmail, created_at: since } });
    if (toThisEmail >= PAY_REQUESTS_PER_EMAIL_PER_DAY) {
      this.logger.warn(`Pay request recipient cap hit: user ${ctx.id} POST /pay-requests`);
      throw recipientCapExceeded('pay requests');
    }
    const me = await this.user(ctx.id);

    const s = await this.sponsorships.save(
      this.sponsorships.create({
        source: 'pay_request',
        status: 'requested',
        sponsor_id: null,
        sponsor_name: '',
        recipient_user_id: ctx.id,
        recipient_email: (ctx.email || me.email).toLowerCase(),
        course_id: course.id,
        course_title: course.title,
        message: (dto.message ?? '').slice(0, 500),
        organization_name: payerEmail, // remembered so the request shows who was asked
        token: randomCode(24),
      }),
    );
    const payUrl = payUrlFor(s.token);
    await this.bus.publish<PayRequestCreatedPayload>('PayRequestCreated', {
      sponsorship_id: s.id,
      requester_id: ctx.id,
      requester_name: me.name,
      requester_email: me.email,
      payer_email: payerEmail,
      course_id: course.id,
      course_title: course.title,
      amount_etb: course.price_etb!,
      message: s.message,
      pay_url: payUrl,
    });
    return { sponsorship_id: s.id, pay_url: payUrl, status: s.status };
  }

  /** Public landing data for /pay/:token — no PII beyond first name + course. */
  async payRequestPublic(token: string) {
    const s = await this.byToken(token);
    if (s.source !== 'pay_request') throw new NotFoundException('Request not found');
    const course = await this.payments.courseInfo(s.course_id);
    const requester = s.recipient_user_id ? await this.user(s.recipient_user_id) : { name: 'A learner' };
    return {
      sponsorship_id: s.id,
      token: s.token,
      status: s.status,
      course_id: s.course_id,
      course_title: s.course_title,
      price_etb: course.price_etb,
      requester_name: requester.name.split(' ')[0] || 'A learner',
      message: s.message,
      created_at: s.created_at,
    };
  }

  /** Anyone signed in can settle a pay request (Chapa or their wallet). */
  async payRequest(ctx: UserContext, token: string, dto: { coupon_code?: string | null; use_wallet?: boolean }) {
    const s = await this.byToken(token);
    if (s.source !== 'pay_request') throw new NotFoundException('Request not found');
    if (s.status === 'granted') throw new BadRequestException('This request has already been paid');
    if (s.status !== 'requested' && s.status !== 'pending_payment') throw new BadRequestException(`Request is ${s.status}`);
    // Every write below is conditional on the request still being open: a
    // grant (another payer's payment) can land at any await, and a stale
    // write must not reopen or cancel it.
    const open = { id: s.id, status: In(['requested', 'pending_payment']) };
    if (s.recipient_user_id && (await this.entitled(s.recipient_user_id, s.course_id))) {
      await this.sponsorships.update(open, { status: 'cancelled' });
      throw new BadRequestException('The learner already has access to this course');
    }
    const course = await this.paidCourse(s.course_id);
    const me = await this.user(ctx.id);
    const mine = { status: 'pending_payment' as const, sponsor_id: ctx.id, sponsor_name: me.name };
    if ((await this.sponsorships.update(open, mine)).affected !== 1) throw await this.closedRequest(s.id);

    // Refused: back to requested with no sponsor (sponsor_name is NOT NULL; '' as when it was asked).
    // Only while it is still this payer's and no checkout is attached: another payer's checkout stays.
    const session = await this.checkoutOrUndo(
      {
        payer: ctx,
        purpose: PaymentPurpose.PAY_REQUEST,
        courseId: course.id,
        courseTitle: course.title,
        listPriceEtb: course.price_etb!,
        payee: { id: course.owner_id, type: course.owner_type },
        couponCode: dto.coupon_code,
        useWallet: dto.use_wallet,
        meta: { sponsorship_id: s.id },
        returnPath: `/pay/${s.token}?paid=1`,
      },
      `pay request ${s.id}`,
      () =>
        this.sponsorships.update(
          { id: s.id, status: 'pending_payment', sponsor_id: ctx.id, payment_id: IsNull() },
          { status: 'requested', sponsor_id: null, sponsor_name: '' },
        ),
    );
    // Paid by someone else meanwhile: this checkout is left pending (it
    // expires like any abandoned one) and its URL is not handed out.
    if (!session.confirmed && (await this.sponsorships.update(open, { ...mine, payment_id: session.payment_id })).affected !== 1) {
      this.logger.warn(`pay request ${s.id}: closed during checkout, payment ${session.payment_id} left unattached`);
      throw await this.closedRequest(s.id);
    }
    return { ...session, sponsorship_id: s.id };
  }

  /** The 400 for a pay request that is no longer open, read after a conditional write matched nothing. */
  private async closedRequest(id: string): Promise<BadRequestException> {
    const now = await this.sponsorships.findOne({ where: { id } });
    if (!now || now.status === 'granted' || now.status === 'pending_claim') return new BadRequestException('This request has already been paid');
    return new BadRequestException(`Request is ${now.status}`);
  }

  // ---- Bulk purchases ----------------------------------------------------

  async quoteBulk(courseId: string, seats: number) {
    const course = await this.paidCourse(courseId);
    const n = Math.floor(seats);
    if (n < 2 || n > 5000) throw new BadRequestException('Seats must be between 2 and 5000');
    const pct = bulkDiscountPercent(n);
    const unit = course.price_etb!;
    const total = Number((unit * n * (1 - pct / 100)).toFixed(2));
    return {
      course_id: course.id,
      course_title: course.title,
      seats: n,
      unit_price_etb: unit,
      discount_percent: pct,
      list_total_etb: Number((unit * n).toFixed(2)),
      total_etb: total,
      tiers: env('BULK_DISCOUNT_TIERS', '5:10,10:20,50:30'),
    };
  }

  async createBulk(ctx: UserContext, dto: { course_id: string; seats: number; organization_name: string; use_wallet?: boolean }) {
    const q = await this.quoteBulk(dto.course_id, dto.seats);
    const course = await this.paidCourse(dto.course_id);
    const order = await this.bulk.save(
      this.bulk.create({
        buyer_id: ctx.id,
        buyer_role: ctx.role,
        organization_name: dto.organization_name.trim().slice(0, 120),
        course_id: course.id,
        course_title: course.title,
        seats: q.seats,
        unit_price_etb: q.unit_price_etb.toFixed(2),
        discount_percent: q.discount_percent,
        total_etb: q.total_etb.toFixed(2),
        status: 'pending_payment',
      }),
    );
    // Volume discount is baked into the list price; per-code coupons don't stack on bulk.
    // Refused: no order.
    const session = await this.checkoutOrUndo(
      {
        payer: ctx,
        purpose: PaymentPurpose.BULK,
        courseId: course.id,
        courseTitle: `${course.title} × ${q.seats} seats`,
        listPriceEtb: q.total_etb,
        payee: { id: course.owner_id, type: course.owner_type },
        useWallet: dto.use_wallet,
        meta: { bulk_purchase_id: order.id, seats: q.seats },
        returnPath: `/institution?bulk=${order.id}`,
      },
      `bulk purchase ${order.id}`,
      () => this.bulk.delete({ id: order.id, status: 'pending_payment' }),
    );
    if (!session.confirmed) await this.bulk.update({ id: order.id, status: 'pending_payment' }, { payment_id: session.payment_id });
    return { ...session, bulk_purchase_id: order.id };
  }

  async listBulk(ctx: UserContext) {
    const orders = await this.bulk.find({ where: ctx.role === Role.PLATFORM_ADMIN ? {} : { buyer_id: ctx.id }, order: { created_at: 'DESC' }, take: 100 });
    const out = [];
    for (const o of orders) {
      const seats = await this.sponsorships.find({ where: { bulk_purchase_id: o.id }, order: { created_at: 'ASC' } });
      out.push({
        id: o.id,
        organization_name: o.organization_name,
        course_id: o.course_id,
        course_title: o.course_title,
        seats: o.seats,
        seats_assigned: seats.filter((s) => s.status !== 'cancelled').length,
        unit_price_etb: Number(o.unit_price_etb),
        discount_percent: o.discount_percent,
        total_etb: Number(o.total_etb),
        status: o.status,
        created_at: o.created_at,
        assignments: await this.withProgress(seats),
      });
    }
    return out;
  }

  /** Assign seats to employee emails; existing accounts get access now, others on signup. */
  async assignSeats(ctx: UserContext, bulkId: string, emails: string[]) {
    const order = await this.bulk.findOne({ where: { id: bulkId } });
    if (!order) throw new NotFoundException('Bulk purchase not found');
    if (order.buyer_id !== ctx.id && ctx.role !== Role.PLATFORM_ADMIN) throw new ForbiddenException('Not your purchase');
    if (order.status !== 'active') throw new BadRequestException('Seats can be assigned once the purchase is paid');

    const existing = await this.sponsorships.find({ where: { bulk_purchase_id: order.id } });
    const used = new Set(existing.filter((s) => s.status !== 'cancelled').map((s) => s.recipient_email));
    const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))].filter((e) => !used.has(e));
    if (!clean.length) throw new BadRequestException('No new valid emails to assign');
    const remaining = order.seats - used.size;
    if (clean.length > remaining) throw new BadRequestException(`Only ${remaining} seat(s) left on this purchase`);

    const buyer = await this.user(ctx.id);
    const results: { email: string; status: string }[] = [];
    for (const email of clean) {
      // Looked up before the transaction, so no internal call holds it open.
      const recipient = await this.userByEmail(email);
      const enrolled = recipient ? await this.entitled(recipient.id, order.course_id) : false;
      // The seat commits with its SponsorshipGranted or SponsorshipInvited (the outbox).
      const status = await this.outbox.transaction(async (m, emit) => {
        const seats = m.getRepository(Sponsorship);
        const s = await seats.save(
          seats.create({
            source: 'bulk',
            status: 'pending_claim',
            sponsor_id: order.buyer_id,
            sponsor_name: order.organization_name || buyer.name,
            recipient_user_id: recipient?.id ?? null,
            recipient_email: email,
            course_id: order.course_id,
            course_title: order.course_title,
            message: `Your organisation ${order.organization_name} has enrolled you in this course.`,
            bulk_purchase_id: order.id,
            organization_name: order.organization_name,
            token: randomCode(24),
          }),
        );
        if (!recipient) {
          emit<SponsorshipInvitedPayload>('SponsorshipInvited', this.invitedPayload(s));
          return 'invited';
        }
        if (enrolled) {
          s.status = 'granted';
          s.granted_at = new Date();
          await seats.save(s);
          return 'already_enrolled';
        }
        await this.grant(m, emit, s);
        return 'granted';
      });
      results.push({ email, status });
    }
    return { assigned: results.length, results };
  }

  // ---- Views -------------------------------------------------------------

  /** Everything sponsorship-related for one user: gifts given (with recipient progress), received, and my pay requests. */
  async mine(ctx: UserContext) {
    const given = await this.sponsorships.find({ where: { sponsor_id: ctx.id }, order: { created_at: 'DESC' }, take: 100 });
    const received = await this.sponsorships.find({
      where: [{ recipient_user_id: ctx.id, status: 'granted' }, { recipient_email: (ctx.email ?? '').toLowerCase(), status: 'granted' }],
      order: { created_at: 'DESC' },
      take: 100,
    });
    const requests = await this.sponsorships.find({ where: { recipient_user_id: ctx.id, source: 'pay_request' }, order: { created_at: 'DESC' }, take: 50 });
    return {
      given: await this.withProgress(given.filter((s) => s.source !== 'pay_request' || s.sponsor_id === ctx.id)),
      received: received.map((s) => this.view(s)),
      pay_requests: requests.map((s) => ({ ...this.view(s), pay_url: `${env('WEB_URL', 'http://localhost:3000')}/pay/${s.token}`, asked: s.organization_name })),
    };
  }

  /** Idempotent: attach + grant any seats waiting on the caller's email (fallback for Google sign-ups). */
  async claimMine(ctx: UserContext) {
    if (!ctx.email) return { claimed: 0 };
    return { claimed: await this.claimForEmail(ctx.id, ctx.email) };
  }

  // ---- Event / payment reactions ----------------------------------------

  /**
   * A confirmed gift or pay request (PaymentService purpose handler; re-run by
   * its cron until it succeeds). The state change is conditional, so it
   * happens once; the event that must be acknowledged follows the
   * sponsorship's status as it is now, on every run:
   *  - granted → SponsorshipGranted (enrollment grants access);
   *  - pending_claim (the recipient has no account yet) → SponsorshipInvited,
   *    once; the grant at their signup is a separate flow (claimForEmail).
   */
  private async onSponsoredPaymentConfirmed(payment: Payment) {
    const id = payment.meta?.sponsorship_id as string | undefined;
    if (!id) return this.logger.warn(`payment ${payment.id}: no sponsorship_id, nothing to grant`);
    let s = await this.sponsorships.findOne({ where: { id } });
    if (!s) return this.logger.warn(`payment ${payment.id}: sponsorship ${id} not found, nothing to grant`);

    if (s.status !== 'granted' && s.status !== 'pending_claim') {
      const recipientId = s.recipient_user_id ?? (await this.userByEmail(s.recipient_email))?.id ?? null;
      // The sponsor is whoever paid: on a pay request several payers can have
      // opened checkouts, and the row may name a later one.
      const payer = s.sponsor_id === payment.learner_id ? {} : { sponsor_id: payment.learner_id, sponsor_name: (await this.user(payment.learner_id)).name };
      await this.sponsorships.update(
        { id, status: Not(In(['granted', 'pending_claim'])) },
        recipientId
          ? { status: 'granted', granted_at: new Date(), payment_id: payment.id, recipient_user_id: recipientId, ...payer }
          : { status: 'pending_claim', payment_id: payment.id, ...payer },
      );
      s = (await this.sponsorships.findOne({ where: { id } }))!;
    }

    if (s.status === 'granted') {
      await this.bus.publishConfirmed<SponsorshipGrantedPayload>('SponsorshipGranted', this.grantedPayload(s), { correlationId: payment.id });
    } else if (s.status === 'pending_claim') {
      await this.bus.publishConfirmed<SponsorshipInvitedPayload>('SponsorshipInvited', this.invitedPayload(s), { correlationId: payment.id });
    }
  }

  /** A confirmed bulk order: activated once, then BulkPurchaseActivated until the broker acknowledges it. */
  private async onBulkPaid(payment: Payment) {
    const id = payment.meta?.bulk_purchase_id as string | undefined;
    if (!id) return this.logger.warn(`payment ${payment.id}: no bulk_purchase_id, nothing to activate`);
    await this.bulk.update({ id, status: Not('active') }, { status: 'active', payment_id: payment.id });
    const order = await this.bulk.findOne({ where: { id } });
    if (!order) return this.logger.warn(`payment ${payment.id}: bulk purchase ${id} not found, nothing to activate`);
    const buyer = await this.user(order.buyer_id);
    await this.bus.publishConfirmed<BulkPurchaseActivatedPayload>(
      'BulkPurchaseActivated',
      {
        bulk_purchase_id: order.id,
        buyer_id: order.buyer_id,
        buyer_email: buyer.email,
        organization_name: order.organization_name,
        course_id: order.course_id,
        course_title: order.course_title,
        seats: order.seats,
        total_etb: Number(order.total_etb),
      },
      { correlationId: payment.id },
    );
  }

  /**
   * Grants the seats waiting for this email to the account, with their
   * SponsorshipGranted, in one outbox transaction. Safe to repeat: a seat
   * already granted is no longer waiting (a redelivered UserRegistered, or the
   * dashboard's claim racing it).
   */
  private async claimForEmail(userId: string, email: string): Promise<number> {
    const n = await this.outbox.transaction(async (m, emit) => {
      const waiting = await m.getRepository(Sponsorship).find({ where: { recipient_email: email.toLowerCase(), status: 'pending_claim' } });
      let granted = 0;
      for (const s of waiting) {
        s.recipient_user_id = userId;
        if (await this.grant(m, emit, s)) granted += 1;
      }
      return granted;
    });
    if (n) this.logger.log(`claimed ${n} sponsored seat(s) for ${email}`);
    return n;
  }

  /**
   * Grants a seat waiting for its claim to `s.recipient_user_id`, with its
   * SponsorshipGranted, in the caller's outbox transaction. Conditional, so
   * two claims of one seat grant and announce it once. False when the seat
   * was no longer waiting.
   */
  private async grant(m: EntityManager, emit: Emit, s: Sponsorship): Promise<boolean> {
    const granted = { status: 'granted' as const, granted_at: new Date(), recipient_user_id: s.recipient_user_id };
    const done = await m.getRepository(Sponsorship).update({ id: s.id, status: 'pending_claim' }, granted);
    if (done.affected !== 1) return false;
    Object.assign(s, granted);
    emit<SponsorshipGrantedPayload>('SponsorshipGranted', this.grantedPayload(s));
    return true;
  }

  private grantedPayload(s: Sponsorship): SponsorshipGrantedPayload {
    return {
      sponsorship_id: s.id,
      source: s.source,
      sponsor_id: s.sponsor_id,
      sponsor_name: s.sponsor_name,
      recipient_user_id: s.recipient_user_id!,
      recipient_email: s.recipient_email,
      course_id: s.course_id,
      course_title: s.course_title,
      message: s.message,
      organization_name: s.organization_name,
    };
  }

  private invitedPayload(s: Sponsorship): SponsorshipInvitedPayload {
    return {
      sponsorship_id: s.id,
      source: s.source,
      sponsor_name: s.sponsor_name,
      recipient_email: s.recipient_email,
      course_id: s.course_id,
      course_title: s.course_title,
      message: s.message,
      organization_name: s.organization_name,
      signup_url: `${env('WEB_URL', 'http://localhost:3000')}/signup?gift=${s.token}`,
    };
  }

  // ---- helpers -----------------------------------------------------------

  private view(s: Sponsorship) {
    return {
      id: s.id,
      source: s.source,
      status: s.status,
      sponsor_id: s.sponsor_id,
      sponsor_name: s.sponsor_name,
      recipient_user_id: s.recipient_user_id,
      recipient_email: s.recipient_email,
      course_id: s.course_id,
      course_title: s.course_title,
      message: s.message,
      organization_name: s.organization_name,
      granted_at: s.granted_at,
      created_at: s.created_at,
    };
  }

  /** Sponsor's view of each recipient — the "parent dashboard": progress + completion. */
  private async withProgress(rows: Sponsorship[]) {
    const out = [];
    for (const s of rows) {
      let progress: { progress_percent: number; lessons_complete: boolean } | null = null;
      if (s.status === 'granted' && s.recipient_user_id) {
        try {
          const e = await this.internal.get<{ progress_percent: number; lessons_complete: boolean }>(
            internalPath`/api/v1/internal/entitlements?learner_id=${s.recipient_user_id}&course_id=${s.course_id}`,
          );
          progress = { progress_percent: e.progress_percent ?? 0, lessons_complete: !!e.lessons_complete };
        } catch {
          progress = null;
        }
      }
      out.push({ ...this.view(s), progress });
    }
    return out;
  }

  /**
   * Opens the checkout for a gift, pay request or bulk order whose row was
   * just written. When createSession refuses it, `undo` takes that row back,
   * so a refused checkout leaves nothing behind. Each undo is conditional on
   * the row still waiting for this checkout's payment, so it never touches a
   * row a confirmation or another payer has moved on. A failing undo is
   * logged, and the caller still gets the refusal.
   */
  private async checkoutOrUndo(input: SessionInput, row: string, undo: () => Promise<unknown>): Promise<SessionResult> {
    try {
      return await this.payments.createSession(input);
    } catch (err) {
      try {
        await undo();
      } catch (undoErr) {
        this.logger.error(`${row}: could not be undone after its checkout was refused: ${(undoErr as Error).message}`);
      }
      throw err;
    }
  }

  private async paidCourse(courseId: string): Promise<CourseInfo> {
    const course = await this.payments.courseInfo(courseId);
    if (course.status !== 'published') throw new NotFoundException('Course not available');
    if (course.pricing_type === PricingType.FREE || !course.price_etb) {
      throw new BadRequestException('This course is free — anyone can enroll in it directly');
    }
    return course;
  }

  private async byToken(token: string): Promise<Sponsorship> {
    const s = await this.sponsorships.findOne({ where: { token } });
    if (!s) throw new NotFoundException('Not found');
    return s;
  }

  private async entitled(learnerId: string, courseId: string): Promise<boolean> {
    try {
      const e = await this.internal.get<{ entitlement_status: string }>(internalPath`/api/v1/internal/entitlements?learner_id=${learnerId}&course_id=${courseId}`);
      return e.entitlement_status === 'active';
    } catch {
      return false;
    }
  }

  private async userByEmail(email: string): Promise<UserInfo | null> {
    try {
      return await this.internal.get<UserInfo>(internalPath`/api/v1/internal/users/by-email/${email}`);
    } catch {
      return null;
    }
  }

  private async user(id: string): Promise<{ name: string; email: string }> {
    try {
      return await this.internal.get<{ name: string; email: string }>(internalPath`/api/v1/internal/users/${id}`);
    } catch {
      return { name: '', email: '' };
    }
  }

  /** Institution admins pay as themselves; ownership of the order is the buyer account. */
  static allowedBuyer(role: Role): boolean {
    return [Role.LEARNER, Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN].includes(role);
  }
}
