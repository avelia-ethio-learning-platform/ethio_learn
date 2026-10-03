import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Role, TrustTier, UserStatus } from '@ethiopialearn/contracts';

@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: Role, enumName: 'user_role' })
  role: Role;

  @Column()
  name: string;

  @Index({ unique: true })
  @Column()
  email: string;

  // Nullable: accounts created via Google sign-in have no password until the
  // user sets one via "forgot password". Password login checks for a hash first.
  @Column({ type: 'varchar', nullable: true })
  password_hash: string | null;

  /** Google account subject id (`sub`) when the user linked Google sign-in. */
  @Index({ unique: true, where: 'google_id IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  google_id: string | null;

  /** Profile picture from the OAuth provider, if any. */
  @Column({ type: 'varchar', nullable: true })
  avatar_url: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  email_verified_at: Date | null;

  @Column({ type: 'varchar', nullable: true })
  phone: string | null;

  /** Staff invited by an admin must change their one-time password on first login. */
  @Column({ default: false })
  must_change_password: boolean;

  /** Moderation status — suspended/banned users cannot authenticate. */
  @Column({ type: 'enum', enum: UserStatus, enumName: 'user_status', default: UserStatus.ACTIVE })
  status: UserStatus;

  @Column({ type: 'varchar', nullable: true })
  status_reason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

@Entity({ name: 'email_verifications' })
export class EmailVerification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  user_id: string;

  @Index({ unique: true })
  @Column()
  token: string;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  used_at: Date | null;
}

@Entity({ name: 'password_resets' })
export class PasswordReset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  user_id: string;

  @Index({ unique: true })
  @Column()
  token: string;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  used_at: Date | null;
}

@Entity({ name: 'educator_profiles' })
export class EducatorProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Unique through the @OneToOne join column's constraint; a separate unique
  // @Index here built a second identical index.
  @Column('uuid')
  user_id: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'text', default: '' })
  bio: string;

  @Column({ default: '' })
  expertise_area: string;

  @Column({ type: 'varchar', nullable: true })
  photo_url: string | null;

  @Column({ type: 'enum', enum: TrustTier, enumName: 'trust_tier', default: TrustTier.NEW })
  trust_tier: TrustTier;

  @Column({ type: 'varchar', nullable: true })
  sample_video_url: string | null;
}

@Entity({ name: 'institutions' })
export class Institution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'varchar', nullable: true })
  logo_url: string | null;

  @Column('uuid')
  owner_user_id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}

/**
 * A membership is an invitation until the user accepts it in their own
 * session; only an accepted (active) membership routes courses to the
 * institution. Admins suspend or remove the membership, never the account.
 */
export const MEMBERSHIP_STATUSES = ['invited', 'active', 'suspended', 'removed', 'declined'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

@Entity({ name: 'institution_instructors' })
@Check('CHK_institution_instructors_status', `status IN ('invited', 'active', 'suspended', 'removed', 'declined')`)
@Index('IDX_institution_instructors_institution_id_user_id', ['institution_id', 'user_id'], { unique: true })
// One routing institution per instructor; also serves the internal lookup.
@Index('IDX_institution_instructors_active_user_id', ['user_id'], { unique: true, where: `status = 'active'` })
// Invite cap: invitations per institution per day.
@Index('IDX_institution_instructors_institution_id_invited_at', ['institution_id', 'invited_at'])
export class InstitutionInstructor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  institution_id: string;

  @Column('uuid')
  user_id: string;

  @Column({ default: 'instructor' })
  role_in_org: string;

  @Column({ type: 'varchar', length: 16, default: 'invited' })
  status: MembershipStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  status_reason: string | null;

  @Column({ type: 'uuid', nullable: true })
  invited_by: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  /** Set on every invite and re-invite; the daily cap counts it. Defaults to now() for new rows. */
  @Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
  invited_at: Date | null;

  /** Set when the user accepts; null for an invitation never accepted. */
  @Column({ type: 'timestamptz', nullable: true })
  accepted_at: Date | null;
}
