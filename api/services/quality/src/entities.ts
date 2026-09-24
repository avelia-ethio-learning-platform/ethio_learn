import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import {
  FraudSignalStatus,
  FraudSubjectType,
  OwnerType,
  QaItemKind,
  QaReviewStatus,
  RevisionDiffSummary,
  TrustTier,
} from '@ethiopialearn/contracts';

@Entity({ name: 'qa_review_items' })
export class QaReviewItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  course_id: string;

  // Event-carried course snapshot so the QO queue renders without joins.
  @Column()
  course_title: string;

  @Column('uuid')
  owner_id: string;

  @Column({ type: 'enum', enum: OwnerType, enumName: 'owner_type' })
  owner_type: OwnerType;

  /** Account (user) that authored the course — target for notifications. */
  @Column({ type: 'uuid', nullable: true })
  owner_user_id: string | null;

  @Column({ default: '' })
  owner_email: string;

  @Column({ default: '' })
  owner_name: string;

  @Column({ type: 'uuid', nullable: true })
  qo_id: string | null;

  @Column({ type: 'enum', enum: QaReviewStatus, enumName: 'qa_review_status', default: QaReviewStatus.PENDING })
  status: QaReviewStatus;

  @Column({ type: 'text', default: '' })
  coaching_notes: string;

  /**
   * AI plagiarism screening result (spec §12.1). `{ pending: true }` while the screen is still
   * running: the item is saved before the screen so a withdrawal can always find it.
   */
  @Column({ type: 'jsonb', default: {} })
  plagiarism: Record<string, unknown>;

  @Column({ default: 'submission' })
  trigger: string;

  /** What is under review — decides the allowed actions, the event published and the SLA. */
  @Column({ type: 'varchar', length: 20, default: 'new_course' })
  kind: QaItemKind;

  /** Course-service revision (staged change set) this item reviews; kind 'revision' only. */
  @Column({ type: 'uuid', nullable: true })
  revision_id: string | null;

  /**
   * Fingerprint of the staged content this item was created for (CourseRevisionSubmitted),
   * echoed on the decision. The course service reuses a revision id when the educator withdraws
   * and resubmits, so without it an approval of this item could apply content nobody reviewed.
   * Null for non-revision items (and revision items queued before the column existed).
   */
  @Column({ type: 'varchar', nullable: true })
  content_hash: string | null;

  /** Event-carried change counts, rendered as chips in the queue (revisions only). */
  @Column({ type: 'jsonb', default: {} })
  diff_summary: Partial<RevisionDiffSummary>;

  @Column({ type: 'text', default: '' })
  changelog_summary: string;

  /** Queue tie-breaker after the SLA deadline (1 = low-risk revision). Never an approval signal. */
  @Column({ type: 'int', default: 0 })
  priority: number;

  /** Soft lock so two officers don't review the same item; it lapses after 30 minutes. */
  @Column({ type: 'uuid', nullable: true })
  claimed_by: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  claimed_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  reviewed_at: Date | null;
}

@Entity({ name: 'course_reviews' })
@Unique(['course_id', 'learner_id'])
export class CourseReview {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  course_id: string;

  @Column('uuid')
  learner_id: string;

  @Column({ type: 'int' })
  rating: number;

  @Column({ type: 'text', nullable: true })
  comment: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

@Entity({ name: 'fraud_signals' })
export class FraudSignal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: FraudSubjectType, enumName: 'fraud_subject_type' })
  subject_type: FraudSubjectType;

  @Column('uuid')
  subject_id: string;

  @Column()
  signal_type: string;

  @Column({ type: 'text', default: '' })
  detail: string;

  /** Payee whose payouts must be held while this signal is open. */
  @Column({ type: 'uuid', nullable: true })
  payee_id: string | null;

  @Index()
  @Column({ type: 'enum', enum: FraudSignalStatus, enumName: 'fraud_signal_status', default: FraudSignalStatus.OPEN })
  status: FraudSignalStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  resolved_by: string | null;
}

@Entity({ name: 'educator_trust_tiers' })
export class EducatorTrustTier {
  @Column('uuid', { primary: true })
  educator_id: string;

  @Column({ type: 'enum', enum: TrustTier, enumName: 'trust_tier', default: TrustTier.NEW })
  tier: TrustTier;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  computed_at: Date;
}

/** Event-carried course→owner mapping (from CourseSubmitted). */
@Entity({ name: 'course_cache' })
export class QualityCourseCache {
  @Column('uuid', { primary: true })
  course_id: string;

  @Column('uuid')
  owner_id: string;

  @Column({ type: 'enum', enum: OwnerType, enumName: 'owner_type' })
  owner_type: OwnerType;

  @Column()
  title: string;
}

/** Behavioral counters per payee for trust-tier math (spec §10.5). */
@Entity({ name: 'payee_stats' })
export class PayeeStats {
  @Column('uuid', { primary: true })
  payee_id: string;

  @Column({ type: 'int', default: 0 })
  payments: number;

  @Column({ type: 'int', default: 0 })
  refunds: number;

  @Column({ type: 'int', default: 0 })
  completions: number;
}

/** Per-learner refund history for the refund-abuse signal (spec §10.6). */
@Entity({ name: 'refund_log' })
export class RefundLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  learner_id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
