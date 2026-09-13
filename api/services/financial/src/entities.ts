import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { OwnerType, PaymentMethod, PaymentPurpose, PaymentStatus, PayoutStatus, RefundStatus, SponsorshipSource } from '@ethiopialearn/contracts';

/**
 * Payee id used on ledger rows that are NOT course revenue (wallet top-ups).
 * Never matches a real educator/institution, and payouts skip it explicitly.
 */
export const PLATFORM_PAYEE_ID = '00000000-0000-0000-0000-000000000000';

@Entity({ name: 'payments' })
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Who paid. For gifts / pay-requests / bulk this is the SPONSOR, not the learner who gets access. */
  @Index()
  @Column('uuid')
  learner_id: string;

  @Index()
  @Column('uuid')
  course_id: string;

  /** What was actually charged (after coupon). Payout math uses this. */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  amount_etb: string;

  @Column({ type: 'enum', enum: PaymentMethod, enumName: 'payment_method' })
  method: PaymentMethod;

  @Column({ type: 'enum', enum: PaymentStatus, enumName: 'payment_status', default: PaymentStatus.PENDING })
  status: PaymentStatus;

  /** EthiopiaLearn-generated UUID — the idempotency key for Chapa webhooks. */
  @Index({ unique: true })
  @Column()
  chapa_tx_ref: string;

  @Column({ type: 'varchar', nullable: true })
  chapa_checkout_url: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  webhook_received_at: Date | null;

  // Payee snapshot (event-carried state from Course & Content at initiation).
  @Index()
  @Column('uuid')
  payee_id: string;

  @Column({ type: 'enum', enum: OwnerType, enumName: 'owner_type' })
  payee_type: OwnerType;

  @Column({ default: '' })
  course_title: string;

  /** Set when this payment has been included in a payout. */
  @Column({ type: 'uuid', nullable: true })
  payout_id: string | null;

  /** course | gift | pay_request | bulk | wallet_topup — decides what confirmation triggers. */
  @Index()
  @Column({ type: 'varchar', default: PaymentPurpose.COURSE })
  purpose: PaymentPurpose;

  /** Purpose-specific pointers (sponsorship_id, bulk_purchase_id, …). */
  @Column({ type: 'jsonb', nullable: true })
  meta: Record<string, any> | null;

  /** Catalog price before any coupon (null on top-ups). */
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  list_price_etb: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  discount_etb: string;

  @Column({ type: 'varchar', nullable: true })
  coupon_code: string | null;

  /** Abandoned-checkout reminder sent at (one reminder per payment, ever). */
  @Column({ type: 'timestamptz', nullable: true })
  nudged_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

@Entity({ name: 'payouts' })
export class Payout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  payee_id: string;

  @Column({ type: 'enum', enum: OwnerType, enumName: 'owner_type' })
  payee_type: OwnerType;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  gross_amount_etb: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  platform_fee_etb: string;

  /** net = gross × 0.80 — computed at payout time (spec §0.4). */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  net_amount_etb: string;

  @Column({ type: 'enum', enum: PayoutStatus, enumName: 'payout_status', default: PayoutStatus.PENDING })
  status: PayoutStatus;

  @Column({ type: 'varchar', nullable: true })
  hold_reason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  scheduled_for: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

@Entity({ name: 'refund_requests' })
export class RefundRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  payment_id: string;

  @Column('uuid')
  learner_id: string;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'enum', enum: RefundStatus, enumName: 'refund_status', default: RefundStatus.PENDING })
  status: RefundStatus;

  /** Decision detail: which §10.4 rule fired. */
  @Column({ default: '' })
  decision_rule: string;

  @Column({ type: 'timestamptz', nullable: true })
  decided_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  decided_by: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

/** Active fraud holds per payee (from FraudFlagRaised/Resolved events). */
@Entity({ name: 'payout_holds' })
export class PayoutHold {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  payee_id: string;

  @Index({ unique: true })
  @Column()
  flag_id: string;

  @Column({ default: '' })
  reason: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

// ---- Growth & commerce ----------------------------------------------------

export type CouponKind = 'percent' | 'amount';

/**
 * Promo / scholarship codes. Educators create codes for their OWN courses;
 * platform admins can create platform-wide codes (course_id = null).
 * Uses are counted on CONFIRMED payments, never on checkout starts.
 */
@Entity({ name: 'coupons' })
export class Coupon {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ length: 32 })
  code: string;

  @Column({ type: 'varchar' })
  kind: CouponKind;

  /** percent: 1–100 · amount: ETB off */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  value: string;

  /** null = valid on every paid course (platform coupon). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  course_id: string | null;

  @Column('uuid')
  created_by: string;

  @Column({ default: '' })
  creator_role: string;

  @Column({ type: 'int', nullable: true })
  max_uses: number | null;

  @Column({ type: 'int', default: 0 })
  uses: number;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date | null;

  @Column({ default: true })
  active: boolean;

  @Column({ default: '' })
  note: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

/** Prepaid credits (ETB-denominated). Funded by top-ups, referral rewards and cashback. */
@Entity({ name: 'wallets' })
export class Wallet {
  @Column('uuid', { primary: true })
  user_id: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  balance_etb: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

export type WalletTxKind = 'topup' | 'purchase' | 'referral_reward' | 'cashback' | 'gift_sent' | 'admin_adjust';

@Entity({ name: 'wallet_transactions' })
export class WalletTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  user_id: string;

  /** Signed: credits positive, debits negative. */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  amount_etb: string;

  @Column({ type: 'varchar' })
  kind: WalletTxKind;

  /** payment id / referral id / admin note — whatever explains the movement. */
  @Column({ default: '' })
  reference: string;

  @Column({ default: '' })
  note: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

export type SponsorshipStatus = 'requested' | 'pending_payment' | 'pending_claim' | 'granted' | 'cancelled';

/**
 * Course access paid for by someone other than the learner: gifts, "pay for
 * me" requests, and corporate bulk seats. Also the parent's view of a child's
 * progress — a sponsor can see how far each recipient has got.
 */
@Entity({ name: 'sponsorships' })
export class Sponsorship {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  source: SponsorshipSource;

  @Column({ type: 'varchar', default: 'pending_payment' })
  status: SponsorshipStatus;

  /** Who pays (null until someone accepts a pay request). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  sponsor_id: string | null;

  @Column({ default: '' })
  sponsor_name: string;

  /** Who gets access. Null while the email has no account yet. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  recipient_user_id: string | null;

  @Index()
  @Column()
  recipient_email: string;

  @Column('uuid')
  course_id: string;

  @Column({ default: '' })
  course_title: string;

  @Column({ type: 'text', default: '' })
  message: string;

  @Column({ type: 'uuid', nullable: true })
  payment_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  bulk_purchase_id: string | null;

  @Column({ type: 'varchar', nullable: true })
  organization_name: string | null;

  /** Public handle for pay-request / gift landing pages. */
  @Index({ unique: true })
  @Column({ length: 48 })
  token: string;

  @Column({ type: 'timestamptz', nullable: true })
  granted_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

/** One corporate order: N seats of one course, assigned to employee emails over time. */
@Entity({ name: 'bulk_purchases' })
export class BulkPurchase {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  buyer_id: string;

  @Column({ default: '' })
  buyer_role: string;

  @Column({ default: '' })
  organization_name: string;

  @Column('uuid')
  course_id: string;

  @Column({ default: '' })
  course_title: string;

  @Column({ type: 'int' })
  seats: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  unit_price_etb: string;

  @Column({ type: 'int', default: 0 })
  discount_percent: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  total_etb: string;

  @Column({ type: 'varchar', default: 'pending_payment' })
  status: 'pending_payment' | 'active' | 'cancelled';

  @Column({ type: 'uuid', nullable: true })
  payment_id: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

@Entity({ name: 'referral_codes' })
export class ReferralCode {
  @Column('uuid', { primary: true })
  user_id: string;

  @Index({ unique: true })
  @Column({ length: 16 })
  code: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

export type ReferralStatus = 'invited' | 'signed_up' | 'rewarded';

@Entity({ name: 'referrals' })
export class Referral {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  referrer_id: string;

  /** Set once the invitee has an account and claimed the code. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  referred_user_id: string | null;

  @Index()
  @Column({ default: '' })
  referred_email: string;

  @Column({ type: 'varchar', default: 'invited' })
  status: ReferralStatus;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  reward_etb: string;

  @Column({ type: 'timestamptz', nullable: true })
  rewarded_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
