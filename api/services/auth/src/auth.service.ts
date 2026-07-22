import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'crypto';
import Redis from 'ioredis';
import { env, EventBusService } from '@ethiopialearn/common';
import { PasswordResetRequestedPayload, UserRegisteredPayload, UserStatus } from '@ethiopialearn/contracts';
import { EmailVerification, PasswordReset, User } from './entities';
import { LoginDto, SignupDto } from './dto';

/** Generate a strong one-time password for invited staff / instructors. */
export function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%*?';
  const all = upper + lower + digits + symbols;
  const pick = (set: string) => set[Math.floor((randomBytes(1)[0] / 256) * set.length)];
  // Guarantee all 4 categories, then fill to length 12.
  let pw = pick(upper) + pick(lower) + pick(digits) + pick(symbols);
  while (pw.length < 12) pw += pick(all);
  return pw
    .split('')
    .sort(() => (randomBytes(1)[0] < 128 ? -1 : 1))
    .join('');
}

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 min (spec §0.3)
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7 days (spec §0.3)
const VERIFY_TOKEN_TTL_HOURS = 24;
const RESET_TOKEN_TTL_MINUTES = 30;
const INVITE_TOKEN_TTL_DAYS = 7; // invited staff / instructors set their own password within a week

@Injectable()
export class AuthService {
  private readonly redis = new Redis(env('REDIS_URL', 'redis://localhost:6379'));
  private readonly webUrl = env('WEB_URL', 'http://localhost:3000');

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(EmailVerification) private readonly verifications: Repository<EmailVerification>,
    @InjectRepository(PasswordReset) private readonly resets: Repository<PasswordReset>,
    private readonly bus: EventBusService,
  ) {}

  async signup(dto: SignupDto): Promise<{ user_id: string }> {
    const email = dto.email.toLowerCase().trim();
    const existing = await this.users.findOne({ where: { email } });
    if (existing) throw new ConflictException('Email already in use');

    const user = await this.users.save(
      this.users.create({
        email,
        name: dto.name.trim(),
        role: dto.role,
        password_hash: await bcrypt.hash(dto.password, 10),
        email_verified_at: null,
        phone: null, // optional profile field only — never required (spec §0.3)
      }),
    );

    const token = randomBytes(32).toString('hex');
    await this.verifications.save(
      this.verifications.create({
        user_id: user.id,
        token,
        expires_at: new Date(Date.now() + VERIFY_TOKEN_TTL_HOURS * 3600 * 1000),
        used_at: null,
      }),
    );

    await this.bus.publish<UserRegisteredPayload>('UserRegistered', {
      user_id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      verification_url: `${this.webUrl}/verify-email?token=${token}`,
    });

    return { user_id: user.id };
  }

  async verifyEmail(token: string): Promise<{ message: string }> {
    if (!token) throw new BadRequestException('Missing token');
    const record = await this.verifications.findOne({ where: { token } });
    if (!record || record.used_at || record.expires_at < new Date()) {
      throw new BadRequestException('Invalid or expired verification link');
    }
    record.used_at = new Date();
    await this.verifications.save(record);
    await this.users.update(record.user_id, { email_verified_at: new Date() });
    return { message: 'Email verified. You can now log in.' };
  }

  async login(dto: LoginDto): Promise<{ access_token: string; expires_in: number; refresh_token: string; user: object }> {
    const user = await this.users.findOne({ where: { email: dto.email.toLowerCase().trim() } });
    if (!user || !(await bcrypt.compare(dto.password, user.password_hash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    this.assertActive(user);
    if (!user.email_verified_at) {
      throw new UnauthorizedException('Email not verified. Check your inbox for the verification link.');
    }
    const refreshToken = await this.issueRefreshToken(user.id);
    return {
      access_token: this.signAccessToken(user),
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      user: this.publicUser(user),
    };
  }

  async refresh(refreshToken: string | undefined): Promise<{ access_token: string; expires_in: number; refresh_token: string; user: object }> {
    if (!refreshToken) throw new UnauthorizedException('No refresh token');
    const key = `refresh:${refreshToken}`;
    const userId = await this.redis.get(key);
    if (!userId) throw new UnauthorizedException('Invalid refresh token');
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Invalid refresh token');
    this.assertActive(user); // suspended/banned users are locked out within one token TTL
    // Rotate: single-use refresh tokens (allowlist lives in Redis, spec §1 stack table).
    await this.redis.del(key);
    const next = await this.issueRefreshToken(user.id);
    return {
      access_token: this.signAccessToken(user),
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: next,
      user: this.publicUser(user),
    };
  }

  async requestPasswordReset(email: string): Promise<{ message: string }> {
    const user = await this.users.findOne({ where: { email: email.toLowerCase().trim() } });
    // Same response either way — never leak account existence.
    if (user) {
      const token = randomBytes(32).toString('hex');
      await this.resets.save(
        this.resets.create({
          user_id: user.id,
          token,
          expires_at: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
          used_at: null,
        }),
      );
      await this.bus.publish<PasswordResetRequestedPayload>('PasswordResetRequested', {
        user_id: user.id,
        email: user.email,
        name: user.name,
        reset_url: `${this.webUrl}/reset-password?token=${token}`,
      });
    }
    return { message: 'Reset email sent if account exists' };
  }

  /** Authenticated password change (used for first-login and normal changes). */
  async changePassword(userId: string, newPassword: string): Promise<{ message: string }> {
    await this.users.update(userId, { password_hash: await bcrypt.hash(newPassword, 10), must_change_password: false });
    return { message: 'Password changed.' };
  }

  /**
   * Create a one-time invite link for a freshly-provisioned account (staff or
   * institution instructor). The admin never sets or sees a password — the
   * invitee opens this link and chooses their own. Reuses the reset-token table
   * with a longer TTL.
   */
  async createInvite(userId: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.resets.save(
      this.resets.create({
        user_id: userId,
        token,
        expires_at: new Date(Date.now() + INVITE_TOKEN_TTL_DAYS * 24 * 3600 * 1000),
        used_at: null,
      }),
    );
    return token;
  }

  /** Show whose invite a token belongs to (so the accept page can greet them). */
  async inviteInfo(token: string): Promise<{ email: string; name: string; role: string }> {
    const record = await this.resets.findOne({ where: { token } });
    if (!record || record.used_at || record.expires_at < new Date()) {
      throw new BadRequestException('This invite link is invalid or has expired. Ask your administrator to re-send it.');
    }
    const user = await this.users.findOne({ where: { id: record.user_id } });
    if (!user) throw new BadRequestException('Invite is no longer valid');
    return { email: user.email, name: user.name, role: user.role };
  }

  /**
   * Accept an invite: the invitee sets their own password. Marks the account
   * verified + active, clears must_change_password, and logs them straight in.
   */
  async acceptInvite(token: string, newPassword: string): Promise<{ access_token: string; expires_in: number; refresh_token: string; user: object }> {
    const record = await this.resets.findOne({ where: { token } });
    if (!record || record.used_at || record.expires_at < new Date()) {
      throw new BadRequestException('This invite link is invalid or has expired. Ask your administrator to re-send it.');
    }
    const user = await this.users.findOne({ where: { id: record.user_id } });
    if (!user) throw new BadRequestException('Invite is no longer valid');
    record.used_at = new Date();
    await this.resets.save(record);
    user.password_hash = await bcrypt.hash(newPassword, 10);
    user.must_change_password = false;
    if (!user.email_verified_at) user.email_verified_at = new Date();
    await this.users.save(user);
    const refreshToken = await this.issueRefreshToken(user.id);
    return {
      access_token: this.signAccessToken(user),
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      user: this.publicUser(user),
    };
  }

  async confirmPasswordReset(token: string, newPassword: string): Promise<{ message: string }> {
    const record = await this.resets.findOne({ where: { token } });
    if (!record || record.used_at || record.expires_at < new Date()) {
      throw new BadRequestException('Invalid or expired reset link');
    }
    record.used_at = new Date();
    await this.resets.save(record);
    await this.users.update(record.user_id, { password_hash: await bcrypt.hash(newPassword, 10) });
    return { message: 'Password updated. You can now log in.' };
  }

  refreshCookieMaxAge(): number {
    return REFRESH_TOKEN_TTL_SECONDS;
  }

  private async issueRefreshToken(userId: string): Promise<string> {
    const token = randomUUID() + randomBytes(16).toString('hex');
    await this.redis.set(`refresh:${token}`, userId, 'EX', REFRESH_TOKEN_TTL_SECONDS);
    return token;
  }

  private signAccessToken(user: User): string {
    return jwt.sign({ sub: user.id, role: user.role, email: user.email, name: user.name }, env('JWT_SECRET'), {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      issuer: 'ethiopialearn',
    });
  }

  private assertActive(user: User) {
    if (user.status === UserStatus.BANNED) {
      throw new UnauthorizedException('This account has been banned. Contact support if you believe this is a mistake.');
    }
    if (user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException('This account is suspended. Contact support for help.');
    }
  }

  private publicUser(user: User) {
    return { id: user.id, name: user.name, email: user.email, role: user.role, must_change_password: user.must_change_password };
  }
}
