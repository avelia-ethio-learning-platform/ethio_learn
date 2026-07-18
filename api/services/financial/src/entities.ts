import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { OwnerType, PaymentMethod, PaymentStatus, PayoutStatus, RefundStatus } from '@ethiopialearn/contracts';

@Entity({ name: 'payments' })
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  learner_id: string;

  @Index()
  @Column('uuid')
  course_id: string;

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
