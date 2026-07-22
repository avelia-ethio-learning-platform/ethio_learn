import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { AssessmentType, TrustTier } from '@ethiopialearn/contracts';

@Entity({ name: 'assessments' })
export class Assessment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  course_id: string;

  @Column({ type: 'enum', enum: AssessmentType, enumName: 'assessment_type' })
  type: AssessmentType;

  @Column({ default: true })
  is_required: boolean;

  /** quiz: {questions:[{prompt,options,correct_index}]} · ai_viva: {topic_context} · project: {instructions} */
  @Column({ type: 'jsonb', default: {} })
  config: Record<string, any>;

  @Column({ type: 'int', default: 60 })
  pass_score: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

@Entity({ name: 'assessment_attempts' })
export class AssessmentAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  assessment_id: string;

  @Index()
  @Column('uuid')
  learner_id: string;

  @Column('uuid')
  enrollment_id: string;

  @Column({ type: 'int', nullable: true })
  score: number | null;

  /** null = not yet graded (project awaiting educator review). */
  @Column({ type: 'boolean', nullable: true })
  passed: boolean | null;

  /** viva question, submitted answers, project file key, feedback, … */
  @Column({ type: 'jsonb', default: {} })
  detail: Record<string, any>;

  /** true once any proctoring violation was recorded — surfaces in educator views. */
  @Column({ default: false })
  flagged: boolean;

  /** true when the exam was force-ended (3rd violation of one type) — fails regardless of score. */
  @Column({ default: false })
  terminated: boolean;

  /** Proctoring violations: [{type, description, at, screenshot_key|null}]. */
  @Column({ type: 'jsonb', default: [] })
  proctor_log: { type: string; description: string; at: string; screenshot_key: string | null }[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  submitted_at: Date | null;
}

@Entity({ name: 'certificates' })
export class Certificate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column('uuid')
  enrollment_id: string;

  /** Public identifier embedded in the QR code. */
  @Index({ unique: true })
  @Column()
  certificate_uid: string;

  /** HMAC-SHA256 over certificate_uid — tamper resistance (spec §10.2). */
  @Column()
  signature: string;

  @Column()
  pdf_s3_key: string;

  @Column()
  qr_code_url: string;

  // Event-carried denormalized display fields (no cross-schema joins).
  @Column('uuid')
  learner_id: string;

  @Column()
  learner_name: string;

  @Column('uuid')
  course_id: string;

  @Column()
  course_title: string;

  @Column({ default: '' })
  educator_name: string;

  @Column({ type: 'jsonb', default: [] })
  assessment_badges: string[];

  @Column({ type: 'enum', enum: TrustTier, enumName: 'trust_tier', default: TrustTier.NEW })
  trust_tier_snapshot: TrustTier;

  @CreateDateColumn({ type: 'timestamptz' })
  issued_at: Date;

  @Column({ default: false })
  invalidated: boolean;
}

/** Event-carried cache of educator trust tiers (from TrustTierChanged). */
@Entity({ name: 'educator_tier_cache' })
export class EducatorTierCache {
  @Column('uuid', { primary: true })
  educator_id: string;

  @Column({ type: 'enum', enum: TrustTier, enumName: 'trust_tier', default: TrustTier.NEW })
  tier: TrustTier;
}
