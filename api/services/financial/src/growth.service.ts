import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, MoreThan, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { dailyCapExceeded, env, envInt, EventBusService, InternalHttpClient, internalPath, isUniqueViolation, UserContext } from '@ethiopialearn/common';
import { PaymentMethod, PaymentPurpose, ReferralInviteSentPayload, Role, WalletCreditedPayload } from '@ethiopialearn/contracts';
import { Coupon, CouponKind, Payment, Referral, ReferralCode, Wallet, WalletTransaction, WalletTxKind } from './entities';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How long a purchase's cashback and referral reward stay pending after its
 * confirmation: the 7-day refund window plus an hour, so every release lands
 * after the window has closed, whatever the clock skew between app and DB.
 */
const PURCHASE_CREDIT_HOLD_MS = 7 * DAY_MS + 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

export function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** A wallet credit that landed; announced as WalletCredited once its transaction has committed. */
export interface WalletCredit {
  user_id: string;
  amount_etb: number;
  balance_etb: number;
  kind: WalletTxKind;
  note: string;
  /** ISO time a pending credit becomes spendable; absent for a credit that is available at once. */
  available_at?: string;
}

/** A credit held out of the balance until available_at (see releaseMatured), for the purchase that earned it. */
export interface PendingCredit {
  state: 'pending';
  available_at: Date;
  payment_id: string;
}

/** Credit kinds the owner is told about (an in-app ping). */
const ANNOUNCED_KINDS: ReadonlySet<WalletTxKind> = new Set(['referral_reward', 'cashback', 'topup', 'admin_adjust']);

export interface CouponQuote {
  coupon: Coupon | null;
  list_price_etb: number;
  discount_etb: number;
  amount_due_etb: number;
}

/**
 * Why a coupon can't be applied at all right now (unknown, deactivated or
 * expired), or null. The quote and the checkout's re-check under the coupon
 * lock give the same answer.
 */
export function couponUnavailable(coupon: Coupon | null): string | null {
  if (!coupon || !coupon.active) return 'This coupon code is not valid';
  if (coupon.expires_at && coupon.expires_at.getTime() < Date.now()) return 'This coupon has expired';
  return null;
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
    dto: {
      code?: string;
      kind: CouponKind;
      value: number;
      course_id?: string | null;
      max_uses?: number | null;
      max_uses_per_user?: number | null;
      expires_at?: string | null;
      note?: string;
    },
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
      const course = await this.internal.get<{ owner_id: string }>(internalPath`/api/v1/internal/courses/${courseId}`);
      const ownerIds = await this.ownerIdsFor(ctx);
      if (!ownerIds.includes(course.owner_id)) throw new ForbiddenException('Not your course');
    } else if (courseId) {
      await this.internal.get(internalPath`/api/v1/internal/courses/${courseId}`); // 404 if bogus
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
        max_uses_per_user: dto.max_uses_per_user && dto.max_uses_per_user > 0 ? Math.floor(dto.max_uses_per_user) : null,
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
    const unavailable = couponUnavailable(coupon);
    if (unavailable || !coupon) throw new BadRequestException(unavailable);
    // Open checkouts count too, but only under the coupon lock at checkout (PaymentService).
    if (coupon.max_uses != null && coupon.uses >= coupon.max_uses) throw new BadRequestException('This coupon has been fully used.');
    if (coupon.course_id && coupon.course_id !== courseId) throw new BadRequestException('This coupon is for a different course');

    const value = Number(coupon.value);
    const discount = coupon.kind === 'percent' ? (list * value) / 100 : Math.min(list, value);
    const due = Math.max(0, Number((list - discount).toFixed(2)));
    return { coupon, list_price_etb: list, discount_etb: Number((list - due).toFixed(2)), amount_due_etb: due };
  }

  /** Public-facing quote for the checkout UI (no coupon internals leaked). */
  async previewCoupon(code: string, courseId: string) {
    const course = await this.internal.get<{ price_etb: number | null; pricing_type: string }>(internalPath`/api/v1/internal/courses/${courseId}`);
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

  /**
   * Locks the coupon row (SELECT … FOR UPDATE) in the caller's transaction.
   * Checkouts and confirmations of one coupon take it first, so they queue
   * here and always lock in the same order (coupon, then payment).
   */
  lockCoupon(m: EntityManager, code: string): Promise<Coupon | null> {
    return m.getRepository(Coupon).findOne({ where: { code }, lock: { mode: 'pessimistic_write' } });
  }

  /**
   * Called once per CONFIRMED payment, inside its confirmation. A checkout
   * holds a use while it is open (PaymentService), but `uses` only counts
   * confirmations.
   */
  async recordCouponUse(code: string | null, manager?: EntityManager) {
    if (!code) return;
    await (manager ? manager.getRepository(Coupon) : this.coupons).increment({ code }, 'uses', 1);
  }

  private couponView(c: Coupon) {
    return {
      id: c.id,
      code: c.code,
      kind: c.kind,
      value: Number(c.value),
      course_id: c.course_id,
      max_uses: c.max_uses,
      max_uses_per_user: c.max_uses_per_user,
      uses: c.uses,
      expires_at: c.expires_at,
      active: c.active && !(c.expires_at && c.expires_at.getTime() < Date.now()) && !(c.max_uses != null && c.uses >= c.max_uses),
      note: c.note,
      created_at: c.created_at,
    };
  }

  // ---- Wallet ------------------------------------------------------------

  /** The owner's wallet, after releasing their matured credits in the same transaction. */
  async wallet(userId: string) {
    return this.dataSource.transaction(async (m) => {
      await this.releaseMatured(m, userId);
      const w = await m.getRepository(Wallet).findOne({ where: { user_id: userId } });
      const tx = await m.getRepository(WalletTransaction).find({ where: { user_id: userId }, order: { created_at: 'DESC' }, take: 50 });
      // Over every pending row, not just the 50 listed; a pending row whose purchase has a refund request still counts.
      const [pending]: { sum: string }[] = await m.query(
        `SELECT COALESCE(SUM(amount_etb), 0) AS sum FROM ${this.table(m, WalletTransaction)} WHERE user_id = $1 AND state = 'pending'`,
        [userId],
      );
      return {
        user_id: userId,
        balance_etb: Number(w?.balance_etb ?? 0),
        pending_etb: Number(Number(pending?.sum ?? 0).toFixed(2)),
        transactions: tx.map((t) => ({
          id: t.id,
          amount_etb: Number(t.amount_etb),
          kind: t.kind,
          note: t.note,
          reference: t.reference,
          state: t.state,
          available_at: t.available_at ?? null,
          created_at: t.created_at,
        })),
        referral_reward_etb: this.referralReward(),
        cashback_percent: this.cashbackPercent(),
      };
    });
  }

  async balance(userId: string): Promise<number> {
    const w = await this.wallets.findOne({ where: { user_id: userId } });
    return Number(w?.balance_etb ?? 0);
  }

  /**
   * Credit a wallet in its own transaction and announce it. Replaying the same
   * (kind, reference) changes nothing (except admin adjustments, which reuse
   * their reference). Returns the balance.
   */
  async credit(userId: string, amount: number, kind: WalletTxKind, reference: string, note: string): Promise<number> {
    const credited = await this.dataSource.transaction((m) => this.creditWith(m, userId, amount, kind, reference, note));
    if (!credited) return this.balance(userId);
    await this.announceCredits([credited]);
    return credited.balance_etb;
  }

  /** Debit a wallet in its own transaction; throws when the balance cannot cover it. Returns the balance. */
  async debit(userId: string, amount: number, kind: WalletTxKind, reference: string, note: string): Promise<number> {
    return this.dataSource.transaction((m) => this.debitWith(m, userId, amount, kind, reference, note));
  }

  /**
   * Credit inside the caller's transaction. The movement row goes in first,
   * with ON CONFLICT DO NOTHING against the unique (kind, reference) index, so
   * a replay inserts nothing and the balance is left alone; catching 23505
   * instead would abort the caller's transaction. The balance changes in one
   * atomic UPDATE, so concurrent credits never lose each other. A `pending`
   * credit is only recorded: the balance is left alone until releaseMatured.
   * Returns null when nothing was credited; the caller announces the credit
   * after commit.
   */
  async creditWith(
    m: EntityManager,
    userId: string,
    amount: number,
    kind: WalletTxKind,
    reference: string,
    note: string,
    pending?: PendingCredit,
  ): Promise<WalletCredit | null> {
    if (amount <= 0) return null;
    const value = amount.toFixed(2);
    const inserted: { id: string }[] = await m.query(
      `INSERT INTO ${this.table(m, WalletTransaction)} (user_id, amount_etb, kind, reference, note, state, available_at, payment_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING id`,
      [userId, value, kind, reference, note, pending?.state ?? 'available', pending?.available_at ?? null, pending?.payment_id ?? null],
    );
    if (inserted.length === 0) return null;
    const balance = pending ? await this.balanceWith(m, userId) : await this.addToBalance(m, userId, value);
    return { user_id: userId, amount_etb: amount, balance_etb: balance, kind, note, ...(pending ? { available_at: pending.available_at.toISOString() } : {}) };
  }

  /**
   * Moves the owner's matured pending credits into the balance, in the
   * caller's transaction (a wallet read, or a debit before its overspend
   * check). The conditional state change is the once-only guarantee: of two
   * concurrent releases, the second finds the rows already available under
   * the row lock. A credit never releases while its purchase is marked with
   * a refund request (refund_requested_at) or is no longer confirmed. A
   * release of nothing writes nothing. Returns the amount released.
   */
  async releaseMatured(m: EntityManager, userId: string): Promise<number> {
    const [rows]: [{ amount_etb: string }[], number] = await m.query(
      `UPDATE ${this.table(m, WalletTransaction)} SET state = 'available' WHERE user_id = $1 AND state = 'pending' AND available_at <= now() AND NOT EXISTS (SELECT 1 FROM ${this.table(m, Payment)} p WHERE p.id = wallet_transactions.payment_id AND (p.refund_requested_at IS NOT NULL OR p.status <> 'confirmed')) RETURNING amount_etb`,
      [userId],
    );
    if (rows.length === 0) return 0;
    const released = rows.reduce((sum, r) => sum + Number(r.amount_etb), 0);
    await this.addToBalance(m, userId, released.toFixed(2));
    return released;
  }

  /**
   * Voids the pending cashback and referral reward a purchase earned, in the
   * caller's transaction: the refund approval that has just flipped the
   * payment to refunded, so this runs at most once per payment. Only pending
   * rows change. None has been released, since a credit never releases while
   * its payment carries a refund request, and the refund window closes before
   * any matures. Returns how many were voided.
   */
  async voidPurchaseCredits(m: EntityManager, paymentId: string): Promise<number> {
    // UPDATE through query() resolves to [rows, rowCount].
    const [, voided]: [unknown[], number] = await m.query(
      `UPDATE ${this.table(m, WalletTransaction)} SET state = 'void' WHERE payment_id = $1 AND state = 'pending' AND kind IN ('cashback', 'referral_reward')`,
      [paymentId],
    );
    return voided;
  }

  /**
   * Debit inside the caller's transaction, under the same rules as creditWith.
   * The balance check and the update are one statement; when the balance is
   * too low this throws, which rolls back the movement row with the caller's
   * transaction. Returns the balance.
   */
  async debitWith(m: EntityManager, userId: string, amount: number, kind: WalletTxKind, reference: string, note: string): Promise<number> {
    if (amount <= 0) return this.balanceWith(m, userId);
    const value = amount.toFixed(2);
    const inserted: { id: string }[] = await m.query(
      `INSERT INTO ${this.table(m, WalletTransaction)} (user_id, amount_etb, kind, reference, note) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
      [userId, (-amount).toFixed(2), kind, reference, note],
    );
    if (inserted.length === 0) return this.balanceWith(m, userId); // this purchase was already paid for
    await this.releaseMatured(m, userId); // so the spend can use credits that have matured
    const [rows]: [{ balance_etb: string }[], number] = await m.query(
      `UPDATE ${this.table(m, Wallet)} SET balance_etb = balance_etb - $2, updated_at = now() WHERE user_id = $1 AND balance_etb >= $2 RETURNING balance_etb`,
      [userId, value],
    );
    if (rows.length === 0) {
      const current = await this.balanceWith(m, userId);
      throw new BadRequestException(`Wallet balance (${current.toFixed(2)} ETB) is not enough for ${value} ETB`);
    }
    return Number(rows[0].balance_etb);
  }

  /** Tell owners about committed credits. Best effort: the money has already moved. */
  async announceCredits(credits: WalletCredit[]): Promise<void> {
    for (const credit of credits) {
      if (!ANNOUNCED_KINDS.has(credit.kind)) continue;
      try {
        await this.bus.publish<WalletCreditedPayload>('WalletCredited', { ...credit, kind: credit.kind as WalletCreditedPayload['kind'] });
      } catch (err) {
        this.logger.warn(`WalletCredited for ${credit.user_id} (${credit.kind}) not published: ${(err as Error).message}`);
      }
    }
  }

  private async balanceWith(m: EntityManager, userId: string): Promise<number> {
    const rows: { balance_etb: string }[] = await m.query(`SELECT balance_etb FROM ${this.table(m, Wallet)} WHERE user_id = $1`, [userId]);
    return Number(rows[0]?.balance_etb ?? 0);
  }

  /** Adds `value` to the balance in one atomic UPDATE, creating the wallet first if needed. Returns the balance. */
  private async addToBalance(m: EntityManager, userId: string, value: string): Promise<number> {
    const wallets = this.table(m, Wallet);
    await m.query(`INSERT INTO ${wallets} (user_id, balance_etb) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    // UPDATE through query() resolves to [rows, rowCount].
    const [rows]: [{ balance_etb: string }[], number] = await m.query(
      `UPDATE ${wallets} SET balance_etb = balance_etb + $2, updated_at = now() WHERE user_id = $1 RETURNING balance_etb`,
      [userId, value],
    );
    return Number(rows[0].balance_etb);
  }

  private table(m: EntityManager, entity: typeof Wallet | typeof WalletTransaction | typeof Payment): string {
    return m.getRepository(entity).metadata.tablePath;
  }

  /** Admin: manual balance adjustment (support credits, corrections). */
  async adminAdjust(adminId: string, userId: string, amount: number, note: string) {
    await this.internal.get(internalPath`/api/v1/internal/users/${userId}`); // 404 if no such user
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
      .where("t.state <> 'void'")
      .groupBy('t.kind')
      .getRawMany<{ kind: string; sum: string; count: string }>();
    const pending = await this.walletTx
      .createQueryBuilder('t')
      .select('COALESCE(SUM(t.amount_etb), 0)', 'sum')
      .where("t.state = 'pending'")
      .getRawOne<{ sum: string }>();
    return {
      outstanding_balance_etb: Number(liability?.sum ?? 0),
      pending_rewards_etb: Number(Number(pending?.sum ?? 0).toFixed(2)),
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

  /**
   * Invite people by email as learners / educators. Only new addresses are
   * emailed: not an existing account, not already invited by this referrer, and
   * not invited by anyone in the last 7 days. The response carries just the
   * count, so it can't be used to learn who has an account.
   */
  async invite(ctx: UserContext, emails: string[], message: string, roleHint: string) {
    const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))].slice(0, 20);
    if (!clean.length) throw new BadRequestException('Provide at least one valid email');

    // Per account: a rolling 24 h allowance, filled in request order. Checked
    // first so a caller at the cap costs no account lookups.
    const cap = envInt('REFERRAL_INVITES_PER_DAY', 20);
    const sentToday = await this.referrals.count({ where: { referrer_id: ctx.id, created_at: MoreThan(new Date(Date.now() - DAY_MS)) } });
    const remaining = cap - sentToday;
    if (remaining <= 0) {
      this.logger.warn(`Referral invite cap hit: user ${ctx.id} POST /referrals/invite`);
      throw dailyCapExceeded('referral invites');
    }

    // New addresses first: not me, not an account, not already invited by this referrer.
    const alreadyMine = new Set(
      (await this.referrals.find({ where: { referrer_id: ctx.id, referred_email: In(clean) } })).map((r) => r.referred_email),
    );
    const fresh: string[] = [];
    for (const email of clean) {
      if (email === ctx.email?.toLowerCase() || alreadyMine.has(email)) continue;
      try {
        await this.internal.get(internalPath`/api/v1/internal/users/by-email/${email}`);
        continue; // an existing account: nothing to send
      } catch {
        fresh.push(email);
      }
    }

    // Per recipient: one referral email per address per 7 days across all referrers (skipped silently).
    const recentlyEmailed = fresh.length
      ? new Set(
          (await this.referrals.find({ where: { referred_email: In(fresh), created_at: MoreThan(new Date(Date.now() - 7 * DAY_MS)) } })).map(
            (r) => r.referred_email,
          ),
        )
      : new Set<string>();
    const candidates = fresh.filter((e) => !recentlyEmailed.has(e));

    const code = await this.codeFor(ctx.id);
    const me = await this.userInfo(ctx.id);
    const signupUrl = `${env('WEB_URL', 'http://localhost:3000')}/signup?ref=${code}${roleHint ? `&role=${roleHint}` : ''}`;
    let invited = 0;
    for (const email of candidates.slice(0, remaining)) {
      await this.referrals.save(this.referrals.create({ referrer_id: ctx.id, referred_email: email, status: 'invited' }));
      await this.bus.publish<ReferralInviteSentPayload>('ReferralInviteSent', {
        referrer_id: ctx.id,
        referrer_name: me.name || 'A friend',
        to_email: email,
        message: (message ?? '').slice(0, 500),
        signup_url: signupUrl,
        existing_user: false,
        role_hint: roleHint,
      });
      invited += 1;
    }
    return { invited };
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
    try {
      await this.referrals.save(row);
    } catch (err) {
      // A concurrent claim by the same account won: one referral per account.
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.referrals.findOne({ where: { referred_user_id: ctx.id } });
      if (!existing) throw err;
      return { claimed: true, referrer_id: existing.referrer_id, status: existing.status };
    }
    return { claimed: true, referrer_id: owner.user_id, status: row.status };
  }

  /**
   * Cashback and the referral reward follow REAL-money purchases only: not
   * top-ups, and not purchases settled with wallet credits or a full coupon.
   */
  rewardsApply(payment: Payment): boolean {
    if (Number(payment.amount_etb) <= 0) return false;
    if (payment.purpose === PaymentPurpose.WALLET_TOPUP) return false;
    return payment.method === PaymentMethod.CHAPA || payment.method === PaymentMethod.BANK_TRANSFER;
  }

  /**
   * Cashback to the buyer, once per payment, inside the confirmation. Pending
   * until the refund window has passed; `confirmedAt` is the confirmation's
   * own time (the in-memory payment's is set only after commit).
   */
  async creditCashback(m: EntityManager, payment: Payment, confirmedAt: Date): Promise<WalletCredit | null> {
    if (!this.rewardsApply(payment)) return null;
    const cashback = Number(((Number(payment.amount_etb) * this.cashbackPercent()) / 100).toFixed(2));
    return this.creditWith(
      m,
      payment.learner_id,
      cashback,
      'cashback',
      payment.id,
      `${this.cashbackPercent()}% cashback on "${payment.course_title}"`,
      this.heldFor(payment, confirmedAt),
    );
  }

  /**
   * On the buyer's first purchase, reward whoever referred them. The status
   * change is conditional, so two first purchases confirming at once reward
   * the referrer once. Pending like the cashback, and tied to the same
   * purchase through payment_id (the reference is the referral).
   */
  async rewardReferrer(m: EntityManager, payment: Payment, buyerName: string, confirmedAt: Date): Promise<WalletCredit | null> {
    if (!this.rewardsApply(payment)) return null;
    const referrals = m.getRepository(Referral);
    const referral = await referrals.findOne({ where: { referred_user_id: payment.learner_id, status: 'signed_up' } });
    if (!referral) return null;
    const reward = this.referralReward();
    const won = await referrals.update(
      { id: referral.id, status: 'signed_up' },
      { status: 'rewarded', reward_etb: reward.toFixed(2), rewarded_at: new Date() },
    );
    if (won.affected !== 1) return null;
    this.logger.log(`referral ${referral.id} rewarded ${reward} ETB to ${referral.referrer_id}`);
    return this.creditWith(
      m,
      referral.referrer_id,
      reward,
      'referral_reward',
      referral.id,
      `Referral reward — ${buyerName || 'your invitee'} made their first purchase`,
      this.heldFor(payment, confirmedAt),
    );
  }

  private heldFor(payment: Payment, confirmedAt: Date): PendingCredit {
    return { state: 'pending', available_at: new Date(confirmedAt.getTime() + PURCHASE_CREDIT_HOLD_MS), payment_id: payment.id };
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
        const inst = await this.internal.get<{ id: string }>(internalPath`/api/v1/internal/institutions/by-owner/${ctx.id}`);
        ids.push(inst.id);
      } catch {
        /* no institution yet */
      }
    }
    return ids;
  }

  private async userInfo(userId: string): Promise<{ email: string; name: string }> {
    try {
      return await this.internal.get<{ email: string; name: string }>(internalPath`/api/v1/internal/users/${userId}`);
    } catch {
      return { email: '', name: '' };
    }
  }
}
