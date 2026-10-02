import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Post,
  Put,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response } from 'express';
import * as bcrypt from 'bcryptjs';
import { CurrentUser, EventBusService, InternalHttpClient, internalPath, Roles, RolesGuard, UserContext, UuidParam } from '@ethiopialearn/common';
import { Role, UserStatus } from '@ethiopialearn/contracts';
import { AuditLog, appendAudit } from './audit';
import { AuthService, generateTempPassword } from './auth.service';
import { EducatorProfile, Institution, User } from './entities';
import { AddInstructorDto, ChangePasswordDto, CreateEducatorProfileDto, CreateInstitutionDto, DeleteAccountDto, MembershipStatusDto, UpdateProfileDto } from './dto';
import { MembershipService } from './membership.service';
import { setRefreshCookie } from './refresh-cookie';

@Controller()
@UseGuards(RolesGuard)
export class ProfilesController {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(EducatorProfile) private readonly educatorProfiles: Repository<EducatorProfile>,
    @InjectRepository(Institution) private readonly institutions: Repository<Institution>,
    @InjectRepository(AuditLog) private readonly audit: Repository<AuditLog>,
    private readonly bus: EventBusService,
    private readonly auth: AuthService,
    private readonly internal: InternalHttpClient,
    private readonly memberships: MembershipService,
  ) {}

  /** First-login / self-service password change. */
  @Put('profiles/password')
  @Roles()
  async changePassword(
    @CurrentUser() ctx: UserContext,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { refresh_token, ...body } = await this.auth.changePassword(ctx.id, dto);
    setRefreshCookie(res, refresh_token, this.auth.refreshCookieMaxAge());
    return body;
  }

  /**
   * Self-service account deletion. Requires the current password as
   * confirmation. Personal data is anonymized in place (email, name, phone,
   * credentials) and the account is permanently locked — enrollments, payment
   * ledger rows, and issued certificates survive under the anonymized id for
   * financial/audit integrity. Educators and institutions must retire their
   * published courses first so learners aren't stranded.
   */
  @Delete('profiles/me')
  @Roles()
  async deleteMe(@CurrentUser() ctx: UserContext, @Body() dto: DeleteAccountDto) {
    const user = await this.users.findOne({ where: { id: ctx.id } });
    if (!user) throw new NotFoundException('User not found');
    // Google-only accounts have no password — they must set one first (forgot password).
    if (!user.password_hash) {
      throw new UnauthorizedException('This account signs in with Google. Set a password first to delete it.');
    }
    if (!(await bcrypt.compare(dto.password, user.password_hash))) {
      throw new UnauthorizedException('Password is incorrect.');
    }

    // Published content blocks deletion — retire it first.
    let publishedOwnerId: string | null = null;
    if (user.role === Role.EDUCATOR) publishedOwnerId = user.id;
    if (user.role === Role.INSTITUTION_ADMIN) {
      const inst = await this.institutions.findOne({ where: { owner_user_id: user.id } });
      publishedOwnerId = inst?.id ?? null;
    }
    if (publishedOwnerId) {
      try {
        const res = await this.internal.get<{ published_count: number }>(internalPath`/api/v1/internal/owners/${publishedOwnerId}/published-count`);
        if (res.published_count > 0) {
          throw new BadRequestException(
            `You still have ${res.published_count} published course(s). Unpublish or archive them before deleting your account.`,
          );
        }
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        // course service unreachable — fail closed rather than orphan learners
        throw new BadRequestException('Could not verify your published courses right now. Try again shortly.');
      }
    }

    // Anonymize in place: unlink every piece of personal data, lock the account.
    user.email = `deleted-${user.id}@removed.invalid`;
    user.name = 'Deleted User';
    user.phone = null;
    user.password_hash = await bcrypt.hash(generateTempPassword(), 10); // unusable
    user.status = UserStatus.BANNED;
    user.status_reason = 'account deleted by owner';
    user.must_change_password = false;
    await this.users.save(user);

    const profile = await this.educatorProfiles.findOne({ where: { user_id: user.id } });
    if (profile) {
      profile.bio = '';
      profile.expertise_area = '';
      profile.photo_url = null;
      profile.sample_video_url = null;
      await this.educatorProfiles.save(profile);
    }

    // Kill every live session so the just-deleted account can't keep acting.
    await this.auth.revokeAllSessions(ctx.id);
    await appendAudit(this.audit, ctx.id, 'user.self_deleted', ctx.id, {});
    return { deleted: true, message: 'Your account has been deleted. Personal data was removed.' };
  }

  @Get('profiles/me')
  @Roles()
  async me(@CurrentUser() ctx: UserContext) {
    const user = await this.users.findOne({ where: { id: ctx.id } });
    if (!user) throw new NotFoundException('User not found');
    const educatorProfile =
      user.role === Role.EDUCATOR ? await this.educatorProfiles.findOne({ where: { user_id: user.id } }) : null;
    const institution =
      user.role === Role.INSTITUTION_ADMIN ? await this.institutions.findOne({ where: { owner_user_id: user.id } }) : null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      email_verified: !!user.email_verified_at,
      has_password: !!user.password_hash,
      created_at: user.created_at,
      educator_profile: educatorProfile,
      institution,
    };
  }

  /**
   * People directory for starting a direct message: search by name (partial)
   * or email (exact). Returns id/name/role only — no emails or phone numbers
   * are exposed unless the caller already typed the exact address.
   */
  @Get('profiles/directory')
  @Roles()
  async directory(@CurrentUser() ctx: UserContext, @Query('q') q?: string) {
    const term = (q ?? '').trim();
    if (term.length < 2) return [];
    const qb = this.users
      .createQueryBuilder('u')
      .select(['u.id', 'u.name', 'u.role'])
      .where('u.id != :me', { me: ctx.id })
      .andWhere("u.status = 'active'")
      .andWhere('(u.name ILIKE :like OR lower(u.email) = lower(:exact))', { like: `%${term}%`, exact: term })
      .orderBy('u.name', 'ASC')
      .take(20);
    const rows = await qb.getMany();
    return rows.map((u) => ({ id: u.id, name: u.name, role: u.role }));
  }

  @Put('profiles/me')
  @Roles()
  async updateMe(@CurrentUser() ctx: UserContext, @Body() dto: UpdateProfileDto) {
    const user = await this.users.findOne({ where: { id: ctx.id } });
    if (!user) throw new NotFoundException('User not found');
    if (dto.name) user.name = dto.name;
    if (dto.phone !== undefined) user.phone = dto.phone || null;
    await this.users.save(user);

    if (user.role === Role.EDUCATOR && (dto.bio !== undefined || dto.expertise_area !== undefined || dto.photo_url !== undefined)) {
      const profile = await this.educatorProfiles.findOne({ where: { user_id: user.id } });
      if (profile) {
        if (dto.bio !== undefined) profile.bio = dto.bio;
        if (dto.expertise_area !== undefined) profile.expertise_area = dto.expertise_area;
        if (dto.photo_url !== undefined) profile.photo_url = dto.photo_url;
        await this.educatorProfiles.save(profile);
      }
    }
    await this.bus.publish('ProfileUpdated', { user_id: user.id, role: user.role });
    return this.me(ctx);
  }

  @Post('profiles/educator')
  @Roles(Role.EDUCATOR)
  async createEducatorProfile(@CurrentUser() ctx: UserContext, @Body() dto: CreateEducatorProfileDto) {
    const existing = await this.educatorProfiles.findOne({ where: { user_id: ctx.id } });
    if (existing) throw new BadRequestException('Educator profile already exists');
    const profile = await this.educatorProfiles.save(
      this.educatorProfiles.create({
        user_id: ctx.id,
        bio: dto.bio,
        expertise_area: dto.expertise_area,
        photo_url: dto.photo_url ?? null,
        sample_video_url: dto.sample_video_url ?? null,
      }),
    );
    await this.bus.publish('ProfileCreated', { user_id: ctx.id, role: Role.EDUCATOR });
    return profile;
  }

  @Post('profiles/institution')
  @Roles(Role.INSTITUTION_ADMIN)
  async createInstitution(@CurrentUser() ctx: UserContext, @Body() dto: CreateInstitutionDto) {
    const existing = await this.institutions.findOne({ where: { owner_user_id: ctx.id } });
    if (existing) throw new BadRequestException('Institution already exists for this account');
    const institution = await this.institutions.save(
      this.institutions.create({ name: dto.name, logo_url: dto.logo_url ?? null, owner_user_id: ctx.id }),
    );
    await this.bus.publish('ProfileCreated', { user_id: ctx.id, role: Role.INSTITUTION_ADMIN });
    return institution;
  }

  /** Invite someone to teach; nothing changes on their account until they accept. */
  @Post('institutions/:id/instructors')
  @Roles(Role.INSTITUTION_ADMIN)
  addInstructor(@CurrentUser() ctx: UserContext, @UuidParam('id') institutionId: string, @Body() dto: AddInstructorDto) {
    return this.memberships.invite(ctx, institutionId, dto);
  }

  @Get('institutions/:id/instructors')
  @Roles(Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  listInstructors(@CurrentUser() ctx: UserContext, @UuidParam('id') institutionId: string) {
    return this.memberships.list(ctx, institutionId);
  }

  /** Suspend, reactivate or remove a membership. Platform suspend/ban stays admin-only. */
  @Post('institutions/:id/instructors/:membershipId/status')
  @Roles(Role.INSTITUTION_ADMIN)
  setInstructorStatus(
    @CurrentUser() ctx: UserContext,
    @UuidParam('id') institutionId: string,
    @UuidParam('membershipId') membershipId: string,
    @Body() dto: MembershipStatusDto,
  ) {
    return this.memberships.setStatus(ctx, institutionId, membershipId, dto);
  }

  @Get('profiles/me/institution-invites')
  @Roles()
  myInstitutionInvites(@CurrentUser() ctx: UserContext) {
    return this.memberships.myInvites(ctx.id);
  }

  @Post('profiles/me/institution-invites/:id/accept')
  @Roles()
  acceptInstitutionInvite(@CurrentUser() ctx: UserContext, @UuidParam('id') membershipId: string) {
    return this.memberships.accept(ctx.id, membershipId);
  }

  @Post('profiles/me/institution-invites/:id/decline')
  @Roles()
  declineInstitutionInvite(@CurrentUser() ctx: UserContext, @UuidParam('id') membershipId: string) {
    return this.memberships.decline(ctx.id, membershipId);
  }
}
