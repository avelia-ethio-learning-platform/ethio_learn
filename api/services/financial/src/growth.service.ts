import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { env, envInt, EventBusService, InternalHttpClient, UserContext } from '@ethiopialearn/common';
import { PaymentMethod, PaymentPurpose, ReferralInviteSentPayload, Role, WalletCreditedPayload } from '@ethiopialearn/contracts';
import { Coupon, CouponKind, Payment, Referral, ReferralCode, Wallet, WalletTransaction, WalletTxKind } from './entities';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

export function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export interface CouponQuote {
  coupon: Coupon | null;
  list_price_etb: number;
  discount_etb: number;
  amount_due_etb: number;
}

/**
 * Coupons, the prepaid wallet, and referrals. All three feed the checkout in
 * PaymentService: a coupon lowers the price, the wallet can settle it, and a
 * confirmed purchase pays cashback + the referrer's reward back into wallets.
 */
@Injectable()
export class GrowthService {
  private readonly logger = new Logger(GrowthService.name);

  constructor(
    @InjectRepository(Coupon) private readonly coupons: Repository<Coupon>,
    @InjectRepository(Wallet) private readonly wallets: Repository<Wallet>,
    @InjectRepository(WalletTransaction) private readonly walletTx: Repository<WalletTransaction>,
    @InjectRepository(ReferralCode) private readonly referralCodes: Repository<ReferralCode>,
    @InjectRepository(Referral) private readonly referrals: Repository<Referral>,
    private readonly dataSource: DataSource,
    private readonly bus: EventBusService,
    private readonly internal: InternalHttpClient,
  ) {}

  // ---- Coupons -----------------------------------------------------------

  async createCoupon(
    ctx: UserContext,
    dto: { code?: string; kind: CouponKind; value: number; course_id?: string | null; max_uses?: number | null; expires_at?: string | null; note?: string },
  ) {
    const code = (dto.code?.trim().toUpperCase() || randomCode(8)).replace(/[^A-Z0-9-]/g, '');
    if (code.length < 4 || code.length > 32) throw new BadRequestException('Code must be 4–32 letters/digits');
    if (await this.coupons.findOne({ where: { code } })) throw new BadRequestException('That code already exists');

    if (dto.kind === 'percent' && (dto.value < 1 || dto.value > 100)) throw new BadRequestException('Percent must be 1–100');
    if (dto.kind === 'amount' && dto.value <= 0) throw new BadRequestException('Amount must be positive');

    let courseId: string | null = dto.course_id ?? null;
    if (ctx.role !== Role.PLATFORM_ADMIN) {
      // Educators/institutions can only discount their own courses — and never platform-wide.
      if (!courseId) throw new BadRequestException('Pick one of your courses for this coupon');
      const course = await this.internal.get<{ owner_id: string }>(`/api/v1/internal/courses/${courseId}`);
      const ownerIds = await this.ownerIdsFor(ctx);
      if (!ownerIds.includes(course.owner_id)) throw new ForbiddenException('Not your course');
    } else if (courseId) {
      await this.internal.get(`/api/v1/internal/courses/${courseId}`); // 404 if bogus
    }

    const expires = dto.expires_at ? new Date(dto.expires_at) : null;
    if (expires && Number.isNaN(expires.getTime())) throw new BadRequestException('Invalid expires_at');

    return this.coupons.save(
      this.coupons.create({
        code,
        kind: dto.kind,
        value: dto.value.toFixed(2),
        course_id: courseId,
        created_by: ctx.id,
        creator_role: ctx.role,
        max_uses: dto.max_uses && dto.max_uses > 0 ? Math.floor(dto.max_uses) : null,
        expires_at: expires,
        note: (dto.note ?? '').slice(0, 200),
      }),
    );
  }

  async listCoupons(ctx: UserContext) {
    const where = ctx.role === Role.PLATFORM_ADMIN ? {} : { created_by: ctx.id };
    const rows = await this.coupons.find({ where, order: { created_at: 'DESC' }, take: 200 });
    return rows.map((c) => this.couponView(c));
  }

  async deactivateCoupon(ctx: UserContext, id: string) {
    const coupon = await this.coupons.findOne({ where: { id } });
    if (!coupon) throw new NotFoundException('Coupon not found');
    if (ctx.role !== Role.PLATFORM_ADMIN && coupon.created_by !== ctx.id) throw new ForbiddenException('Not your coupon');
    coupon.active = false;
    await this.coupons.save(coupon);
    return this.couponView(coupon);
  }

  /**
   * Price a course with an optional coupon. Throws a readable error when the
   * code cannot be applied so the checkout UI can show it inline.
   */
  async quote(courseId: string, listPrice: number, code?: string | null): Promise<CouponQuote> {
    const list = Math.max(0, Number(listPrice.toFixed(2)));
    if (!code?.trim()) return { coupon: null, list_price_etb: list, discount_etb: 0, amount_due_etb: list };
    const coupon = await this.coupons.findOne({ where: { code: code.trim().toUpperCase() } });
    if (!coupon || !coupon.active) throw new BadRequestException('This coupon code is not valid');
    if (coupon.expires_at && coupon.expires_at.getTime() < Date.now()) throw new BadRequestException('This coupon has expired');
    if (coupon.max_uses != null && coupon.uses >= coupon.max_uses) throw new BadRequestException('This coupon has been fully used');
    if (coupon.course_id && coupon.course_id !== courseId) throw new BadRequestException('This coupon is for a different course');

    const value = Number(coupon.value);
    const discount = coupon.kind === 'percent' ? (list * value) / 100 : Math.min(list, value);
    const due = Math.max(0, Number((list - discount).toFixed(2)));
    return { coupon, list_price_etb: list, discount_etb: Number((list - due).toFixed(2)), amount_due_etb: due };
  }

  /** Public-facing quote for the checkout UI (no coupon internals leaked). */
  async previewCoupon(code: string, courseId: string) {
    const course = await this.internal.get<{ price_etb: number | null; pricing_type: string }>(`/api/v1/internal/courses/${courseId}`);
    if (!course.price_etb) throw new BadRequestException('This course is free — no coupon needed');
    const q = await this.quote(courseId, course.price_etb, code);
    return {
      code: q.coupon?.code ?? null,
      list_price_etb: q.list_price_etb,
      discount_etb: q.discount_etb,
      amount_due_etb: q.amount_due_etb,
      description: q.coupon ? (q.coupon.kind === 'percent' ? `${Number(q.coupon.value)}% off` : `${Number(q.coupon.value)} ETB off`) : null,
    };
  }

  /** Called once per CONFIRMED payment — usage is never counted at checkout start. */
  async recordCouponUse(code: string | null) {
    if (!code) return;
    await this.coupons.increment({ code }, 'uses', 1);
  }

  private couponView(c: Coupon) {
    return {
      id: c.id,
      code: c.code,
      kind: c.kind,
      value: Number(c.value),
      course_id: c.course_id,
      max_uses: c.max_uses,
      uses: c.uses,
      expires_at: c.expires_at,
      active: c.active && !(c.expires_at && c.expires_at.getTime() < Date.now()) && !(c.max_uses != null && c.uses >= c.max_uses),
      note: c.note,
      created_at: c.created_at,
    };
  }

  // ---- Wallet ------------------------------------------------------------

  async wallet(userId: string) {
    const w = await this.wallets.findOne({ where: { user_id: userId } });
    const tx = await this.walletTx.find({ where: { user_id: userId }, order: { created_at: 'DESC' }, take: 50 });
    return {
      user_id: userId,
      balance_etb: Number(w?.balance_etb ?? 0),
      transactions: tx.map((t) => ({ id: t.id, amount_etb: Number(t.amount_etb), kind: t.kind, note: t.note, reference: t.reference, created_at: t.created_at })),
      referral_reward_etb: this.referralReward(),
      cashback_percent: this.cashbackPercent(),
    };
  }

  async balance(userId: string): Promise<number> {
    const w = await this.wallets.findOne({ where: { user_id: userId } });
    return Number(w?.balance_etb ?? 0);
  }

  /** Credit under a row lock; publishes WalletCredited for reward-type credits. */
  async credit(userId: string, amount: number, kind: WalletTxKind, reference: string, note: string): Promise<number> {
    if (amount <= 0) return this.balance(userId);
    const balance = await this.dataSource.transaction(async (m) => {
      let w = await m.getRepository(Wallet).findOne({ where: { user_id: userId }, lock: { mode: 'pessimistic_write' } });
      if (!w) w = m.getRepository(Wallet).create({ user_id: userId, balance_etb: '0' });
      w.balance_etb = (Number(w.balance_etb) + amount).toFixed(2);
      await m.getRepository(Wallet).save(w);
      await m.getRepository(WalletTransaction).save(
        m.getRepository(WalletTransaction).create({ user_id: userId, amount_etb: amount.toFixed(2), kind, reference, note }),
      );
      return Number(w.balance_etb);
    });
    if (kind === 'referral_reward' || kind === 'cashback' || kind === 'topup' || kind === 'admin_adjust') {
      await this.bus.publish<WalletCreditedPayload>('WalletCredited', { user_id: userId, amount_etb: amount, balance_etb: balance, kind, note });
    }
    return balance;
  }

  /** Debit under a row lock; throws when the balance cannot cover it. */
  async debit(userId: string, amount: number, kind: WalletTxKind, reference: string, note: string): Promise<number> {
    if (amount <= 0) return this.balance(userId);
    return this.dataSource.transaction(async (m) => {
      const w = await m.getRepository(Wallet).findOne({ where: { user_id: userId }, lock: { mode: 'pessimistic_write' } });
      const current = Number(w?.balance_etb ?? 0);
      if (!w || current + 1e-9 < amount) throw new BadRequestException(`Wallet balance (${current.toFixed(2)} ETB) is not enough for ${amount.toFixed(2)} ETB`);
      w.balance_etb = (current - amount).toFixed(2);
      await m.getRepository(Wallet).save(w);
      await m.getRepository(WalletTransaction).save(
        m.getRepository(WalletTransaction).create({ user_id: userId, amount_etb: (-amount).toFixed(2), kind, reference, note }),
      );
      return Number(w.balance_etb);
    });
  }

  /** Admin: manual balance adjustment (support credits, corrections). */
  async adminAdjust(adminId: string, userId: string, amount: number, note: string) {
    await this.internal.get(`/api/v1/internal/users/${userId}`); // 404 if no such user
    const ref = `admin:${adminId}`;
    const balance = amount >= 0
      ? await this.credit(userId, amount, 'admin_adjust', ref, note || 'Adjustment by support')
      : await this.debit(userId, -amount, 'admin_adjust', ref, note || 'Adjustment by support');
    return { user_id: userId, balance_etb: balance };
  }

  /** Wallet liability + top-up totals for the admin dashboard. */
  async adminWalletStats() {
    const liability = await this.wallets.createQueryBuilder('w').select('COALESCE(SUM(w.balance_etb), 0)', 'sum').getRawOne<{ sum: string }>();
    const byKind = await this.walletTx
      .createQueryBuilder('t')
      .select('t.kind', 'kind')
      .addSelect('COALESCE(SUM(t.amount_etb), 0)', 'sum')
      .addSelect('COUNT(*)', 'count')
      .groupBy('t.kind')
      .getRawMany<{ kind: string; sum: string; count: string }>();
    return {
      outstanding_balance_etb: Number(liability?.sum ?? 0),
      by_kind: byKind.map((r) => ({ kind: r.kind, total_etb: Number(r.sum), count: Number(r.count) })),
    };
  }

  // ---- Referrals ---------------------------------------------------------

  referralReward(): number {
    return envInt('REFERRAL_REWARD_ETB', 50);
  }

  cashbackPercent(): number {
    return envInt('PURCHASE_CASHBACK_PERCENT', 5);
  }

  async myReferral(ctx: UserContext) {
    const code = await this.codeFor(ctx.id);
    const rows = await this.referrals.find({ where: { referrer_id: ctx.id }, order: { created_at: 'DESC' }, take: 200 });
    const earned = rows.reduce((s, r) => s + Number(r.reward_etb), 0);
    return {
      code,
      share_url: `${env('WEB_URL', 'http://localhost:3000')}/signup?ref=${code}`,
      reward_etb: this.referralReward(),
      stats: {
        invited: rows.filter((r) => r.status === 'invited').length,
        signed_up: rows.filter((r) => r.status === 'signed_up').length,
        rewarded: rows.filter((r) => r.status === 'rewarded').length,
        earned_etb: Number(earned.toFixed(2)),
      },
      invites: rows.slice(0, 50).map((r) => ({ email: r.referred_email, status: r.status, created_at: r.created_at, reward_etb: Number(r.reward_etb) })),
    };
  }

  /** Invite people by email as learners / educators; existing accounts get a "log in" variant. */
  async invite(ctx: UserContext, emails: string[], message: string, roleHint: string) {
    const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))].slice(0, 20);
    if (!clean.length) throw new BadRequestException('Provide at least one valid email');
    const code = await this.codeFor(ctx.id);
    const me = await this.userInfo(ctx.id);
    const signupUrl = `${env('WEB_URL', 'http://localhost:3000')}/signup?ref=${code}${roleHint ? `&role=${roleHint}` : ''}`;
    let sent = 0;
    for (const email of clean) {
      if (email === ctx.email?.toLowerCase()) continue;
      let existing = false;
      try {
        await this.internal.get(`/api/v1/internal/users/by-email/${encodeURIComponent(email)}`);
        existing = true;
      } catch {
        existing = false;
      }
      if (!existing) {
        const dup = await this.referrals.findOne({ where: { referrer_id: ctx.id, referred_email: email } });
        if (!dup) await this.referrals.save(this.referrals.create({ referrer_id: ctx.id, referred_email: email, status: 'invited' }));
      }
      await this.bus.publish<ReferralInviteSentPayload>('ReferralInviteSent', {
        referrer_id: ctx.id,
        referrer_name: me.name || 'A friend',
        to_email: email,
        message: (message ?? '').slice(0, 500),
        signup_url: signupUrl,
        existing_user: existing,
        role_hint: roleHint,
      });
      sent += 1;
    }
    return { sent, code, share_url: signupUrl };
  }

  /** New account attaches itself to the code it signed up with (idempotent). */
  async claim(ctx: UserContext, rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    const owner = await this.referralCodes.findOne({ where: { code } });
    if (!owner) throw new NotFoundException('Unknown referral code');
    if (owner.user_id === ctx.id) throw new BadRequestException('You cannot refer yourself');
    const already = await this.referrals.findOne({ where: { referred_user_id: ctx.id } });
    if (already) return { claimed: true, referrer_id: already.referrer_id, status: already.status };

    const email = (ctx.email ?? '').toLowerCase();
    let row = email ? await this.referrals.findOne({ where: { referrer_id: owner.user_id, referred_email: email } }) : null;
    if (!row) row = this.referrals.create({ referrer_id: owner.user_id, referred_email: email });
    row.referred_user_id = ctx.id;
    row.status = 'signed_up';
    await this.referrals.save(row);
    return { claimed: true, referrer_id: owner.user_id, status: row.status };
  }

  /**
   * After a REAL-money course purchase: cashback to the buyer, and — on the
   * buyer's first ever purchase — the referral reward to whoever referred them.
   */
  async onCoursePurchaseConfirmed(payment: Payment) {
    const amount = Number(payment.amount_etb);
    if (amount <= 0) return;
    if (payment.method !== PaymentMethod.CHAPA && payment.method !== PaymentMethod.BANK_TRANSFER) return; // no cashback on credits
    if (payment.purpose === PaymentPurpose.WALLET_TOPUP) return;

    const cashback = Number(((amount * this.cashbackPercent()) / 100).toFixed(2));
    if (cashback > 0) {
      await this.credit(payment.learner_id, cashback, 'cashback', payment.id, `${this.cashbackPercent()}% cashback on "${payment.course_title}"`);
    }

    const referral = await this.referrals.findOne({ where: { referred_user_id: payment.learner_id, status: 'signed_up' } });
    if (referral) {
      const reward = this.referralReward();
      referral.status = 'rewarded';
      referral.reward_etb = reward.toFixed(2);
      referral.rewarded_at = new Date();
      await this.referrals.save(referral);
      const who = await this.userInfo(payment.learner_id);
      await this.credit(referral.referrer_id, reward, 'referral_reward', referral.id, `Referral reward — ${who.name || 'your invitee'} made their first purchase`);
      this.logger.log(`referral ${referral.id} rewarded ${reward} ETB to ${referral.referrer_id}`);
    }
  }

  private async codeFor(userId: string): Promise<string> {
    const existing = await this.referralCodes.findOne({ where: { user_id: userId } });
    if (existing) return existing.code;
    for (let i = 0; i < 5; i++) {
      const code = randomCode(8);
      if (!(await this.referralCodes.findOne({ where: { code } }))) {
        await this.referralCodes.save(this.referralCodes.create({ user_id: userId, code }));
        return code;
      }
    }
    throw new Error('Could not allocate a referral code');
  }

  /** The payee ids this account can act for (self, plus its institution for institution admins). */
  async ownerIdsFor(ctx: UserContext): Promise<string[]> {
    const ids = [ctx.id];
    if (ctx.role === Role.INSTITUTION_ADMIN) {
      try {
        const inst = await this.internal.get<{ id: string }>(`/api/v1/internal/institutions/by-owner/${ctx.id}`);
        ids.push(inst.id);
      } catch {
        /* no institution yet */
      }
    }
    return ids;
  }

  private async userInfo(userId: string): Promise<{ email: string; name: string }> {
    try {
      return await this.internal.get<{ email: string; name: string }>(`/api/v1/internal/users/${userId}`);
    } catch {
      return { email: '', name: '' };
    }
  }
}
