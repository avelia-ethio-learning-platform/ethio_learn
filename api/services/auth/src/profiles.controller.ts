import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { CurrentUser, env, EventBusService, InternalHttpClient, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { InstructorLinkedPayload, Role, StaffInvitedPayload, UserStatus } from '@ethiopialearn/contracts';
import { AuditLog, appendAudit } from './audit';
import { AuthService, generateTempPassword } from './auth.service';
import { EducatorProfile, Institution, InstitutionInstructor, User } from './entities';
import { AddInstructorDto, ChangePasswordDto, CreateEducatorProfileDto, CreateInstitutionDto, DeleteAccountDto, UpdateProfileDto, UserStatusActionDto } from './dto';

@Controller()
@UseGuards(RolesGuard)
export class ProfilesController {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(EducatorProfile) private readonly educatorProfiles: Repository<EducatorProfile>,
    @InjectRepository(Institution) private readonly institutions: Repository<Institution>,
    @InjectRepository(InstitutionInstructor) private readonly instructors: Repository<InstitutionInstructor>,
    @InjectRepository(AuditLog) private readonly audit: Repository<AuditLog>,
    private readonly bus: EventBusService,
    private readonly auth: AuthService,
    private readonly internal: InternalHttpClient,
  ) {}

  /** First-login / self-service password change. */
  @Put('profiles/password')
  @Roles()
  changePassword(@CurrentUser() ctx: UserContext, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(ctx.id, dto.new_password);
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
        const res = await this.internal.get<{ published_count: number }>(`/api/v1/internal/owners/${publishedOwnerId}/published-count`);
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

  /**
   * Add an instructor to an institution. Three cases, resolved safely so the
   * same email is never duplicated and no one is silently absorbed:
   *  - No account yet → create an educator account + email a one-time
   *    set-password link (no password is ever generated by the admin).
   *  - Existing LEARNER → upgraded to educator so they can author. Their
   *    enrollments/learning survive (playback is entitlement-based). They keep
   *    their password and are told to sign in again.
   *  - Existing independent EDUCATOR → affiliated. Courses they already own stay
   *    independent (institution_id null); only NEW courses route through the
   *    institution's review + payout. Platform staff / institution owners are
   *    rejected — they can't double as an instructor.
   */
  @Post('institutions/:id/instructors')
  @Roles(Role.INSTITUTION_ADMIN)
  async addInstructor(@CurrentUser() ctx: UserContext, @Param('id') institutionId: string, @Body() dto: AddInstructorDto) {
    const institution = await this.institutions.findOne({ where: { id: institutionId } });
    if (!institution) throw new NotFoundException('Institution not found');
    if (institution.owner_user_id !== ctx.id) throw new ForbiddenException('Not your institution');

    const email = dto.email.toLowerCase().trim();
    let user = await this.users.findOne({ where: { email } });
    let invited = false;
    let upgraded = false;

    if (!user) {
      if (!dto.name) throw new BadRequestException('Provide the instructor’s name to invite a new account.');
      user = await this.users.save(
        this.users.create({
          email,
          name: dto.name,
          role: Role.EDUCATOR, // instructors are educators linked to an institution
          password_hash: await bcrypt.hash(generateTempPassword(), 10), // placeholder until they accept the invite
          email_verified_at: new Date(),
          must_change_password: true,
          phone: null,
        }),
      );
      await this.educatorProfiles.save(
        this.educatorProfiles.create({ user_id: user.id, bio: '', expertise_area: '', photo_url: null, sample_video_url: null }),
      );
      const token = await this.auth.createInvite(user.id);
      await this.bus.publish<StaffInvitedPayload>('StaffInvited', {
        user_id: user.id,
        email: user.email,
        name: user.name,
        role: 'instructor',
        invite_url: `${env('WEB_URL', 'http://localhost:3000')}/accept-invite?token=${token}`,
      });
      invited = true;
    } else {
      // Existing account: upgrade or affiliate rather than create a duplicate.
      if (user.role === Role.PLATFORM_ADMIN || user.role === Role.QUALITY_OFFICER || user.role === Role.INSTITUTION_ADMIN) {
        throw new BadRequestException(
          'This email belongs to a platform-staff or institution-owner account and cannot be added as an instructor. Use a different email.',
        );
      }
      if (user.role === Role.LEARNER) {
        user.role = Role.EDUCATOR; // a learner becomes an educator so they can author courses
        await this.users.save(user);
        upgraded = true;
      }
      // Ensure they have an educator profile to author under.
      const hasProfile = await this.educatorProfiles.findOne({ where: { user_id: user.id } });
      if (!hasProfile) {
        await this.educatorProfiles.save(
          this.educatorProfiles.create({ user_id: user.id, bio: '', expertise_area: '', photo_url: null, sample_video_url: null }),
        );
      }
      await this.bus.publish<InstructorLinkedPayload>('InstructorLinked', {
        user_id: user.id,
        email: user.email,
        name: user.name,
        institution_id: institutionId,
        institution_name: institution.name,
        upgraded_from_learner: upgraded,
      });
    }

    const dup = await this.instructors.findOne({ where: { institution_id: institutionId, user_id: user.id } });
    if (dup) throw new BadRequestException('Already an instructor of this institution');
    const row = await this.instructors.save(
      this.instructors.create({ institution_id: institutionId, user_id: user.id, role_in_org: dto.role_in_org ?? 'instructor' }),
    );
    return { ...row, invited, upgraded, instructor_email: user.email };
  }

  @Get('institutions/:id/instructors')
  @Roles(Role.INSTITUTION_ADMIN, Role.PLATFORM_ADMIN)
  async listInstructors(@CurrentUser() ctx: UserContext, @Param('id') institutionId: string) {
    await this.assertOwnsInstitution(ctx, institutionId);
    const rows = await this.instructors.find({ where: { institution_id: institutionId } });
    const result = [];
    for (const row of rows) {
      const user = await this.users.findOne({ where: { id: row.user_id } });
      result.push({ id: row.id, user_id: row.user_id, role_in_org: row.role_in_org, name: user?.name, email: user?.email, status: user?.status });
    }
    return result;
  }

  /** Institution moderates its own instructors: suspend / ban / reactivate. */
  @Post('institutions/:id/instructors/:userId/status')
  @Roles(Role.INSTITUTION_ADMIN)
  async setInstructorStatus(
    @CurrentUser() ctx: UserContext,
    @Param('id') institutionId: string,
    @Param('userId') userId: string,
    @Body() dto: UserStatusActionDto,
  ) {
    await this.assertOwnsInstitution(ctx, institutionId);
    const membership = await this.instructors.findOne({ where: { institution_id: institutionId, user_id: userId } });
    if (!membership) throw new NotFoundException('Not an instructor of this institution');
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    user.status = dto.status;
    user.status_reason = dto.status === 'active' ? null : (dto.reason ?? null);
    await this.users.save(user);
    return { user_id: userId, status: user.status };
  }

  private async assertOwnsInstitution(ctx: UserContext, institutionId: string) {
    if (ctx.role === Role.PLATFORM_ADMIN) return;
    const institution = await this.institutions.findOne({ where: { id: institutionId } });
    if (!institution) throw new NotFoundException('Institution not found');
    if (institution.owner_user_id !== ctx.id) throw new ForbiddenException('Not your institution');
  }
}
