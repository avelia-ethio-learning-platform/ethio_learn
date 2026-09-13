import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { env, EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
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
import { bulkDiscountPercent, CourseInfo, PaymentService, SessionResult } from './payment.service';

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
    const session = await this.payments.createSession({
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
    });
    if (!session.confirmed) {
      s.payment_id = session.payment_id;
      await this.sponsorships.save(s);
    }
    return { ...session, sponsorship_id: s.id };
  }

  // ---- Pay requests ------------------------------------------------------

  async createPayRequest(ctx: UserContext, dto: { course_id: string; payer_email: string; message?: string }) {
    const course = await this.paidCourse(dto.course_id);
    if (await this.entitled(ctx.id, course.id)) throw new BadRequestException('You already own this course');
    const payerEmail = dto.payer_email.trim().toLowerCase();
    if (payerEmail === (ctx.email ?? '').toLowerCase()) throw new BadRequestException('Enter the email of the person who will pay');
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
    const payUrl = `${env('WEB_URL', 'http://localhost:3000')}/pay/${s.token}`;
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
    if (s.recipient_user_id && (await this.entitled(s.recipient_user_id, s.course_id))) {
      s.status = 'cancelled';
      await this.sponsorships.save(s);
      throw new BadRequestException('The learner already has access to this course');
    }
    const course = await this.paidCourse(s.course_id);
    const me = await this.user(ctx.id);
    s.sponsor_id = ctx.id;
    s.sponsor_name = me.name;
    s.status = 'pending_payment';
    await this.sponsorships.save(s);

    const session = await this.payments.createSession({
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
    });
    if (!session.confirmed) {
      s.payment_id = session.payment_id;
      await this.sponsorships.save(s);
    }
    return { ...session, sponsorship_id: s.id };
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
    const session = await this.payments.createSession({
      payer: ctx,
      purpose: PaymentPurpose.BULK,
      courseId: course.id,
      courseTitle: `${course.title} × ${q.seats} seats`,
      listPriceEtb: q.total_etb,
      payee: { id: course.owner_id, type: course.owner_type },
      useWallet: dto.use_wallet,
      meta: { bulk_purchase_id: order.id, seats: q.seats },
      returnPath: `/institution?bulk=${order.id}`,
    });
    if (!session.confirmed) {
      order.payment_id = session.payment_id;
      await this.bulk.save(order);
    }
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
      const recipient = await this.userByEmail(email);
      const s = await this.sponsorships.save(
        this.sponsorships.create({
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
      if (recipient) {
        if (await this.entitled(recipient.id, order.course_id)) {
          s.status = 'granted';
          s.granted_at = new Date();
          await this.sponsorships.save(s);
          results.push({ email, status: 'already_enrolled' });
          continue;
        }
        await this.grant(s);
        results.push({ email, status: 'granted' });
      } else {
        await this.invite(s);
        results.push({ email, status: 'invited' });
      }
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

  private async onSponsoredPaymentConfirmed(payment: Payment) {
    const id = payment.meta?.sponsorship_id as string | undefined;
    if (!id) return;
    const s = await this.sponsorships.findOne({ where: { id } });
    if (!s) return;
    if (s.status === 'granted') return;
    s.payment_id = payment.id;
    if (!s.recipient_user_id) {
      const recipient = await this.userByEmail(s.recipient_email);
      if (recipient) s.recipient_user_id = recipient.id;
    }
    if (s.recipient_user_id) await this.grant(s);
    else await this.invite(s);
  }

  private async onBulkPaid(payment: Payment) {
    const id = payment.meta?.bulk_purchase_id as string | undefined;
    if (!id) return;
    const order = await this.bulk.findOne({ where: { id } });
    if (!order || order.status === 'active') return;
    order.status = 'active';
    order.payment_id = payment.id;
    await this.bulk.save(order);
    const buyer = await this.user(order.buyer_id);
    await this.bus.publish<BulkPurchaseActivatedPayload>('BulkPurchaseActivated', {
      bulk_purchase_id: order.id,
      buyer_id: order.buyer_id,
      buyer_email: buyer.email,
      organization_name: order.organization_name,
      course_id: order.course_id,
      course_title: order.course_title,
      seats: order.seats,
      total_etb: Number(order.total_etb),
    });
  }

  private async claimForEmail(userId: string, email: string): Promise<number> {
    const waiting = await this.sponsorships.find({ where: { recipient_email: email.toLowerCase(), status: 'pending_claim' } });
    let n = 0;
    for (const s of waiting) {
      s.recipient_user_id = userId;
      await this.grant(s);
      n += 1;
    }
    if (n) this.logger.log(`claimed ${n} sponsored seat(s) for ${email}`);
    return n;
  }

  private async grant(s: Sponsorship) {
    s.status = 'granted';
    s.granted_at = new Date();
    await this.sponsorships.save(s);
    await this.bus.publish<SponsorshipGrantedPayload>('SponsorshipGranted', {
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
    });
  }

  private async invite(s: Sponsorship) {
    s.status = 'pending_claim';
    await this.sponsorships.save(s);
    await this.bus.publish<SponsorshipInvitedPayload>('SponsorshipInvited', {
      sponsorship_id: s.id,
      source: s.source,
      sponsor_name: s.sponsor_name,
      recipient_email: s.recipient_email,
      course_id: s.course_id,
      course_title: s.course_title,
      message: s.message,
      organization_name: s.organization_name,
      signup_url: `${env('WEB_URL', 'http://localhost:3000')}/signup?gift=${s.token}`,
    });
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
            `/api/v1/internal/entitlements?learner_id=${s.recipient_user_id}&course_id=${s.course_id}`,
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
      const e = await this.internal.get<{ entitlement_status: string }>(`/api/v1/internal/entitlements?learner_id=${learnerId}&course_id=${courseId}`);
      return e.entitlement_status === 'active';
    } catch {
      return false;
    }
  }

  private async userByEmail(email: string): Promise<UserInfo | null> {
    try {
      return await this.internal.get<UserInfo>(`/api/v1/internal/users/by-email/${encodeURIComponent(email)}`);
    } catch {
      return null;
    }
  }

  private async user(id: string): Promise<{ name: string; email: string }> {
    try {
      return await this.internal.get<{ name: string; email: string }>(`/api/v1/internal/users/${id}`);
    } catch {
      return { name: '', email: '' };
    }
  }

  /** Institution admins pay as themselves; ownership of the order is the buyer account. */
  static allowedBuyer(role: Role): boolean {
    return [Role.LEARNER, Role.EDUCATOR, Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN].includes(role);
  }
}
