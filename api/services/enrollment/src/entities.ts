import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import { EntitlementStatus, PricingType } from '@ethiopialearn/contracts';

/** Root of access control (spec §7): the ONLY source of content entitlement. */
@Entity({ name: 'enrollments' })
@Unique(['learner_id', 'course_id'])
export class Enrollment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  learner_id: string;

  @Index()
  @Column('uuid')
  course_id: string;

  @Column({ type: 'enum', enum: EntitlementStatus, enumName: 'entitlement_status', default: EntitlementStatus.NONE })
  entitlement_status: EntitlementStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  enrolled_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;

  /** payment | sponsorship | free — how access was obtained. */
  @Column({ type: 'varchar', default: 'payment' })
  source: string;

  /** Who paid, when not the learner (gift / pay request / bulk seat). Drives the sponsor's progress view. */
  @Column({ type: 'uuid', nullable: true })
  sponsor_id: string | null;

  /** Last lesson completion / video heartbeat — the inactivity clock. */
  @Column({ type: 'timestamptz', nullable: true })
  last_activity_at: Date | null;

  /** Inactivity escalation already sent: 0 none · 1 in-app · 2 email. Reset on any activity. */
  @Column({ type: 'int', default: 0 })
  nudge_level: number;

  /** Progress milestones (25/50/75) already announced — each fires once per enrollment. */
  @Column({ type: 'int', array: true, default: () => "'{}'" })
  milestones_sent: number[];

  /** When the learner last opened the course change log (drives the "Updated" badge). */
  @Column({ type: 'timestamptz', nullable: true })
  changelog_seen_at: Date | null;
}

@Entity({ name: 'lesson_progress' })
@Unique(['enrollment_id', 'lesson_id'])
export class LessonProgress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  enrollment_id: string;

  @Column('uuid')
  lesson_id: string;

  @Column({ type: 'timestamptz' })
  completed_at: Date;
}

/** Per-lesson video watch state so learners resume where they left off. */
@Entity({ name: 'video_progress' })
@Unique(['enrollment_id', 'lesson_id'])
export class VideoProgress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  enrollment_id: string;

  @Column('uuid')
  lesson_id: string;

  /** Last playhead position — the resume point (rewinds move it back). */
  @Column({ type: 'float', default: 0 })
  position_seconds: number;

  @Column({ type: 'float', default: 0 })
  duration_seconds: number;

  /** High-water mark: furthest percent ever reached, never decreases. */
  @Column({ type: 'int', default: 0 })
  percent_watched: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}

/**
 * Event-carried course snapshot (from CoursePublished) so dashboards render
 * titles without cross-schema joins (spec §7 note).
 */
@Entity({ name: 'course_cache' })
export class CourseCache {
  @Column('uuid', { primary: true })
  course_id: string;

  @Column()
  title: string;

  @Column({ type: 'enum', enum: PricingType, enumName: 'pricing_type' })
  pricing_type: PricingType;

  @Column('uuid')
  owner_id: string;

  @Column()
  owner_type: string;
}
