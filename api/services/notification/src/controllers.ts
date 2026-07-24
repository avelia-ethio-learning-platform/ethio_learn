import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { CurrentUser, Roles, RolesGuard, UserContext } from '@ethiopialearn/common';
import { COURSE_CATEGORIES, Role } from '@ethiopialearn/contracts';
import { InboxNotification, NotificationLog, NotificationPreference } from './entities';

const CATEGORY_VALUES = COURSE_CATEGORIES as string[];

/** De-dupe while preserving order. */
function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

/** Partial update — any omitted field keeps its stored value. */
class PreferencesDto {
  @IsOptional()
  @IsBoolean()
  marketing_opt_out?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(CATEGORY_VALUES, { each: true })
  new_course_categories?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  new_course_instructor_ids?: string[];

  @IsOptional()
  @IsBoolean()
  new_course_email?: boolean;

  @IsOptional()
  @IsBoolean()
  new_course_in_app?: boolean;
}

function prefView(row: NotificationPreference | null, userId: string) {
  return {
    user_id: userId,
    marketing_opt_out: row?.marketing_opt_out ?? false,
    new_course_categories: row?.new_course_categories ?? [],
    new_course_instructor_ids: row?.new_course_instructor_ids ?? [],
    new_course_email: row?.new_course_email ?? true,
    new_course_in_app: row?.new_course_in_app ?? true,
  };
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
    return prefView(row, userId);
  }

  /** Partial update: only the fields present in the body change. */
  @Put('notification-preferences/:userId')
  @Roles()
  async putPrefs(@CurrentUser() ctx: UserContext, @Param('userId') userId: string, @Body() dto: PreferencesDto) {
    this.assertSelfOrAdmin(ctx, userId);
    const current = (await this.prefs.findOne({ where: { user_id: userId } })) ?? this.prefs.create({ user_id: userId });
    if (dto.marketing_opt_out !== undefined) current.marketing_opt_out = dto.marketing_opt_out;
    if (dto.new_course_categories !== undefined) current.new_course_categories = uniq(dto.new_course_categories);
    if (dto.new_course_instructor_ids !== undefined) current.new_course_instructor_ids = uniq(dto.new_course_instructor_ids);
    if (dto.new_course_email !== undefined) current.new_course_email = dto.new_course_email;
    if (dto.new_course_in_app !== undefined) current.new_course_in_app = dto.new_course_in_app;
    const saved = await this.prefs.save(current);
    return prefView(saved, userId);
  }

  // ---- Follow / unfollow an instructor (new-course alerts) ----

  /** Follow: add the instructor to my new-course-alert list. Returns follow state. */
  @Post('notifications/follow/:instructorId')
  @Roles()
  async follow(@CurrentUser() ctx: UserContext, @Param('instructorId', ParseUUIDPipe) instructorId: string) {
    const row = (await this.prefs.findOne({ where: { user_id: ctx.id } })) ?? this.prefs.create({ user_id: ctx.id });
    row.new_course_instructor_ids = uniq([...(row.new_course_instructor_ids ?? []), instructorId]);
    await this.prefs.save(row);
    return { following: true, instructor_id: instructorId };
  }

  @Post('notifications/unfollow/:instructorId')
  @Roles()
  async unfollow(@CurrentUser() ctx: UserContext, @Param('instructorId') instructorId: string) {
    const row = await this.prefs.findOne({ where: { user_id: ctx.id } });
    if (row) {
      row.new_course_instructor_ids = (row.new_course_instructor_ids ?? []).filter((id) => id !== instructorId);
      await this.prefs.save(row);
    }
    return { following: false, instructor_id: instructorId };
  }

  /** Is the current user following this instructor? (drives the follow button) */
  @Get('notifications/following/:instructorId')
  @Roles()
  async isFollowing(@CurrentUser() ctx: UserContext, @Param('instructorId') instructorId: string) {
    const row = await this.prefs.findOne({ where: { user_id: ctx.id } });
    return { following: (row?.new_course_instructor_ids ?? []).includes(instructorId) };
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
