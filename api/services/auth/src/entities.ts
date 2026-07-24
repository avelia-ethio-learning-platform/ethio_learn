import { Column, CreateDateColumn, Entity, Index, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
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

  @Index({ unique: true })
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

@Entity({ name: 'institution_instructors' })
export class InstitutionInstructor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  institution_id: string;

  @Column('uuid')
  user_id: string;

  @Column({ default: 'instructor' })
  role_in_org: string;
}
