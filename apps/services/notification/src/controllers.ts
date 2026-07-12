import { Body, Controller, ForbiddenException, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, Repository } from 'typeorm';
import { CurrentUser, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { Role } from '@ethiopialearn/contracts';
import { InboxNotification, NotificationLog, NotificationPreference } from './entities';

class PreferencesDto {
  @IsBoolean()
  marketing_opt_out: boolean;
}

@Controller()
@UseGuards(RolesGuard)
export class NotificationController {
  constructor(
    @InjectRepository(NotificationPreference) private readonly prefs: Repository<NotificationPreference>,
    @InjectRepository(NotificationLog) private readonly log: Repository<NotificationLog>,
    @InjectRepository(InboxNotification) private readonly inbox: Repository<InboxNotification>,
  ) {}

  // ---- In-app inbox (any authenticated user) ----

  /** Notifications addressed to me directly OR to my role (e.g. QO queue). */
  @Get('notifications')
  @Roles()
  async list(@CurrentUser() ctx: UserContext) {
    const rows = await this.myQuery(ctx).orderBy('n.created_at', 'DESC').limit(50).getMany();
    return rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: !!n.read_at, created_at: n.created_at }));
  }

  @Get('notifications/unread-count')
  @Roles()
  async unreadCount(@CurrentUser() ctx: UserContext) {
    const count = await this.myQuery(ctx).andWhere('n.read_at IS NULL').getCount();
    return { count };
  }

  @Post('notifications/:id/read')
  @Roles()
  async markRead(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    await this.inbox
      .createQueryBuilder()
      .update(InboxNotification)
      .set({ read_at: () => 'now()' })
      .where('id = :id', { id })
      .andWhere(new Brackets((w) => w.where('user_id = :uid', { uid: ctx.id }).orWhere('target_role = :role', { role: ctx.role })))
      .execute();
    return { ok: true };
  }

  @Post('notifications/read-all')
  @Roles()
  async markAllRead(@CurrentUser() ctx: UserContext) {
    await this.inbox
      .createQueryBuilder()
      .update(InboxNotification)
      .set({ read_at: () => 'now()' })
      .where('read_at IS NULL')
      .andWhere(new Brackets((w) => w.where('user_id = :uid', { uid: ctx.id }).orWhere('target_role = :role', { role: ctx.role })))
      .execute();
    return { ok: true };
  }

  private myQuery(ctx: UserContext) {
    return this.inbox
      .createQueryBuilder('n')
      .where(new Brackets((w) => w.where('n.user_id = :uid', { uid: ctx.id }).orWhere('n.target_role = :role', { role: ctx.role })));
  }

  // ---- Preferences ----

  @Get('notification-preferences/:userId')
  @Roles()
  async getPrefs(@CurrentUser() ctx: UserContext, @Param('userId') userId: string) {
    this.assertSelfOrAdmin(ctx, userId);
    const row = await this.prefs.findOne({ where: { user_id: userId } });
    return { user_id: userId, marketing_opt_out: row?.marketing_opt_out ?? false };
  }

  @Put('notification-preferences/:userId')
  @Roles()
  async putPrefs(@CurrentUser() ctx: UserContext, @Param('userId') userId: string, @Body() dto: PreferencesDto) {
    this.assertSelfOrAdmin(ctx, userId);
    await this.prefs.save(this.prefs.create({ user_id: userId, marketing_opt_out: dto.marketing_opt_out }));
    return { user_id: userId, marketing_opt_out: dto.marketing_opt_out };
  }

  @Get('admin/notifications')
  @Roles(Role.PLATFORM_ADMIN)
  recent() {
    return this.log.find({ order: { sent_at: 'DESC' }, take: 100 });
  }

  private assertSelfOrAdmin(ctx: UserContext, userId: string) {
    if (ctx.id !== userId && ctx.role !== Role.PLATFORM_ADMIN) throw new ForbiddenException();
  }
}
