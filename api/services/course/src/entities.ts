import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { CourseCategory, CourseStatus, OwnerType, PricingType } from '@ethiopialearn/contracts';

// NOTE: the spec's data dictionary lists a `course_categories` table; the
// authoritative creation payload (§7.2) fixes categories to a closed enum, so
// we model it as an enum column instead of a lookup table.
@Entity({ name: 'courses' })
// Composite index for the catalog query (status = published ORDER BY published_at DESC).
@Index(['status', 'published_at'])
export class Course {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Educator user id or institution id, depending on owner_type. */
  @Index()
  @Column('uuid')
  owner_id: string;

  @Column({ type: 'enum', enum: OwnerType, enumName: 'owner_type' })
  owner_type: OwnerType;

  /** The user account that authored the course (permission checks). */
  @Index()
  @Column('uuid')
  created_by: string;

  /** Set when the author is an institution instructor — drives the internal
   *  institution-review step before platform QO review. Null for solo educators. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  institution_id: string | null;

  @Column({ length: 120 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  // Stored as a plain string (not a Postgres enum) so new categories never need
  // a DB migration; the CourseCategory enum + @IsEnum on the DTO still validate.
  @Column({ type: 'varchar', default: CourseCategory.OTHER })
  category: CourseCategory;

  @Column({ default: 'en' })
  language: string;

  @Column({ type: 'varchar', nullable: true })
  thumbnail_url: string | null;

  @Column({ type: 'enum', enum: PricingType, enumName: 'pricing_type' })
  pricing_type: PricingType;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  price_etb: string | null;

  @Index()
  @Column({ type: 'enum', enum: CourseStatus, enumName: 'course_status', default: CourseStatus.DRAFT })
  status: CourseStatus;

  @OneToMany(() => Section, (s) => s.course)
  sections: Section[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  published_at: Date | null;

  // Rating aggregates cached from the quality service's CourseRated events
  // (event-carried state — catalog ranking never joins across schemas).
  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true })
  rating_avg: string | null;

  @Column({ type: 'int', default: 0 })
  rating_count: number;

  /** Sum of all star values — input to educator "total rating" ranking. */
  @Column({ type: 'int', default: 0 })
  rating_points: number;

  /** Enrollment counter from EnrollmentCreated events — popularity signal. */
  @Column({ type: 'int', default: 0 })
  enrolled_count: number;

  // Latest reviewer feedback (QO coaching/flag or institution send-back), shown
  // to the course owner on their authoring page — not exposed to the public.
  @Column({ type: 'varchar', nullable: true })
  last_review_action: string | null;

  @Column({ type: 'text', nullable: true })
  last_review_notes: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_reviewed_at: Date | null;
}

@Entity({ name: 'sections' })
export class Section {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  course_id: string;

  @ManyToOne(() => Course, (c) => c.sections, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'course_id' })
  course: Course;

  @Column({ length: 160 })
  title: string;

  @Column({ type: 'int' })
  order_index: number;

  /** true = accessible without payment (freemium first section, spec §7.2). */
  @Column({ default: false })
  is_free_preview: boolean;

  @OneToMany(() => Lesson, (l) => l.section)
  lessons: Lesson[];
}

@Entity({ name: 'lessons' })
export class Lesson {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  section_id: string;

  @ManyToOne(() => Section, (s) => s.lessons, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'section_id' })
  section: Section;

  @Column({ length: 160 })
  title: string;

  /** One-line lesson description (AI course-structure generator fills this in). */
  @Column({ type: 'text', nullable: true })
  summary: string | null;

  /** NEVER exposed to clients — playback goes through signed URLs only (spec §0 rule 5). */
  @Column({ type: 'varchar', nullable: true })
  video_s3_key: string | null;

  @Column({ type: 'int', default: 0 })
  duration_seconds: number;

  @Column({ type: 'int' })
  order_index: number;
}
