import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
// (Index/PrimaryGeneratedColumn used by InboxNotification below)

@Entity({ name: 'notification_log' })
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  user_id: string | null;

  @Column()
  event_type: string;

  @Column({ default: 'email' })
  channel: string;

  @Column()
  recipient: string;

  @Column()
  subject: string;

  @Column({ default: 'sent' })
  status: 'sent' | 'failed' | 'skipped';

  @Column({ type: 'varchar', nullable: true })
  provider_message_id: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  sent_at: Date;
}

@Entity({ name: 'notification_preferences' })
export class NotificationPreference {
  @Column('uuid', { primary: true })
  user_id: string;

  /** Opt-out covers marketing only — transactional email always sends (spec §4.3). */
  @Column({ default: false })
  marketing_opt_out: boolean;
}

/**
 * Threaded discussion on a course. `parent_id` points at ANY other comment
 * (top-level comment or reply), giving arbitrary-depth threads. Author name
 * and role are snapshotted at write time (event-carried style — no cross-
 * service join on every read).
 */
@Entity({ name: 'course_comments' })
export class CourseComment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  course_id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  parent_id: string | null;

  @Column('uuid')
  author_id: string;

  @Column()
  author_name: string;

  @Column({ default: 'learner' })
  author_role: string;

  @Column({ type: 'text' })
  body: string;

  /** Soft delete: thread structure survives, body shows as removed. */
  @Column({ default: false })
  deleted: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

/** 1:1 direct-message conversation. Participants ordered so (a_id,b_id) is unique. */
@Entity({ name: 'dm_threads' })
@Index(['a_id', 'b_id'], { unique: true })
export class DmThread {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  a_id: string;

  @Index()
  @Column('uuid')
  b_id: string;

  @Column({ default: '' })
  a_name: string;

  @Column({ default: '' })
  b_name: string;

  @Column({ default: '' })
  a_role: string;

  @Column({ default: '' })
  b_role: string;

  @Column({ type: 'timestamptz', nullable: true })
  last_message_at: Date | null;

  @Column({ default: '' })
  last_preview: string;

  @Column({ type: 'int', default: 0 })
  a_unread: number;

  @Column({ type: 'int', default: 0 })
  b_unread: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

@Entity({ name: 'dm_messages' })
export class DmMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  thread_id: string;

  @Column('uuid')
  sender_id: string;

  @Column({ type: 'text' })
  body: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

/**
 * In-app notification inbox. A row targets either a specific user (`user_id`)
 * or everyone with a given role (`target_role`, e.g. quality_officer for the
 * review queue), so events can notify staff without enumerating user ids.
 */
@Entity({ name: 'inbox_notifications' })
export class InboxNotification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  user_id: string | null;

  @Index()
  @Column({ type: 'varchar', nullable: true })
  target_role: string | null;

  @Column()
  type: string;

  @Column()
  title: string;

  @Column({ type: 'text', default: '' })
  body: string;

  @Column({ type: 'varchar', nullable: true })
  link: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  read_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
