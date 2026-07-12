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
