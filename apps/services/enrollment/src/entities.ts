import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
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
