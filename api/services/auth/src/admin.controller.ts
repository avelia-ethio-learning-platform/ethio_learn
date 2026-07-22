import { Body, Controller, ConflictException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CurrentUser, env, EventBusService, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { Role, StaffInvitedPayload, UserStatus } from '@ethiopialearn/contracts';
import { AuditLog, appendAudit } from './audit';
import { AuthService, generateTempPassword } from './auth.service';
import { User } from './entities';
import { CreateStaffDto, UserStatusActionDto } from './dto';

/** Platform-admin user management (spec §2.1 admin console: user mgmt). */
@Controller('admin/users')
@UseGuards(RolesGuard)
@Roles(Role.PLATFORM_ADMIN)
export class AdminUsersController {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(AuditLog) private readonly audit: Repository<AuditLog>,
    private readonly bus: EventBusService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async list(@Query('q') q?: string, @Query('role') role?: Role, @Query('page') page = '1', @Query('limit') limit = '20') {
    const take = Math.min(parseInt(limit, 10) || 20, 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
    const where: Record<string, unknown> = {};
    if (q) where.email = ILike(`%${q}%`);
    if (role) where.role = role;
    const [items, total] = await this.users.findAndCount({ where, order: { created_at: 'DESC' }, take, skip });
    return {
      total,
      items: items.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        email_verified: !!u.email_verified_at,
        status: u.status,
        status_reason: u.status_reason,
        must_change_password: u.must_change_password,
        created_at: u.created_at,
      })),
    };
  }

  /** Ban / suspend / reactivate any account (platform admin, spec §10.9 admin console). */
  @Post(':id/status')
  async setStatus(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() dto: UserStatusActionDto) {
    if (id === ctx.id) throw new BadRequestException('You cannot change your own account status.');
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    user.status = dto.status;
    user.status_reason = dto.status === UserStatus.ACTIVE ? null : (dto.reason ?? null);
    await this.users.save(user);
    await appendAudit(this.audit, ctx.id, `user.${dto.status}`, id, { reason: dto.reason ?? null });
    return { id: user.id, status: user.status, status_reason: user.status_reason };
  }

  /**
   * Provision quality_officer / platform_admin accounts (no self-signup for
   * staff roles). The admin never sets a password — the account is created with
   * an unusable random hash and the invitee receives a one-time link where they
   * choose their own password (spec §0.3 invite flow).
   */
  @Post('staff')
  async createStaff(@CurrentUser() ctx: UserContext, @Body() dto: CreateStaffDto) {
    const email = dto.email.toLowerCase().trim();
    if (await this.users.findOne({ where: { email } })) throw new ConflictException('Email already in use');
    const user = await this.users.save(
      this.users.create({
        email,
        name: dto.name,
        role: dto.role,
        password_hash: await bcrypt.hash(generateTempPassword(), 10), // placeholder, replaced when they accept the invite
        email_verified_at: new Date(),
        must_change_password: true,
        phone: null,
      }),
    );
    const token = await this.auth.createInvite(user.id);
    await appendAudit(this.audit, ctx.id, 'user.staff_created', user.id, { role: dto.role });
    await this.bus.publish<StaffInvitedPayload>('StaffInvited', {
      user_id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      invite_url: `${env('WEB_URL', 'http://localhost:3000')}/accept-invite?token=${token}`,
    });
    return { user_id: user.id, invited: true };
  }

  @Post(':id/verify-email')
  async forceVerify(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    await this.users.update(id, { email_verified_at: new Date() });
    await appendAudit(this.audit, ctx.id, 'user.email_force_verified', id, {});
    return { message: 'verified' };
  }
}
