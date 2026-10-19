import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Post, Put, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { CurrentUser, Roles, RolesGuard, UserContext, UuidParam } from '@ethiopialearn/common';
import { COURSE_CATEGORIES, Role } from '@ethiopialearn/contracts';
import { EMAIL_PROVIDER, EmailProvider } from './email.provider';
import { InboxNotification, InboxNotificationRead, NotificationLog, NotificationPreference } from './entities';

const CATEGORY_VALUES = COURSE_CATEGORIES as string[];
/** Instructors one learner can follow for new-course alerts. */
const FOLLOWS_MAX = 500;

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
  @ArrayMaxSize(CATEGORY_VALUES.length)
  @IsIn(CATEGORY_VALUES, { each: true })
  new_course_categories?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FOLLOWS_MAX)
  @IsUUID('all', { each: true })
  new_course_instructor_ids?: string[];

  @IsOptional()
  @IsBoolean()
  new_course_email?: boolean;

  @IsOptional()
  @IsBoolean()
  new_course_in_app?: boolean;

  @IsOptional()
  @IsBoolean()
  course_updates_email?: boolean;

  @IsOptional()
  @IsBoolean()
  progress_emails?: boolean;

  @IsOptional()
  @IsBoolean()
  inactivity_emails?: boolean;
}

/** Platform announcement: new feature, maintenance, campaign. In-app only (see notes in docs/history/FEATURES_ADDED.md). */
class BroadcastDto {
  @IsString()
  @MaxLength(120)
  title: string;

  @IsString()
  @MaxLength(1000)
  body: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  link?: string;

  /** Target one role, or omit for everyone. */
  @IsOptional()
  @IsIn(['learner', 'educator', 'institution_admin', 'quality_officer', 'platform_admin'])
  role?: string;
}

function prefView(row: NotificationPreference | null, userId: string) {
  return {
    user_id: userId,
    marketing_opt_out: row?.marketing_opt_out ?? false,
    new_course_categories: row?.new_course_categories ?? [],
    new_course_instructor_ids: row?.new_course_instructor_ids ?? [],
    new_course_email: row?.new_course_email ?? true,
    new_course_in_app: row?.new_course_in_app ?? true,
    course_updates_email: row?.course_updates_email ?? true,
    progress_emails: row?.progress_emails ?? true,
    inactivity_emails: row?.inactivity_emails ?? true,
  };
}

@Controller()
@UseGuards(RolesGuard)
export class NotificationController {
  constructor(
    @InjectRepository(NotificationPreference) private readonly prefs: Repository<NotificationPreference>,
    @InjectRepository(NotificationLog) private readonly log: Repository<NotificationLog>,
    @InjectRepository(InboxNotification) private readonly inbox: Repository<InboxNotification>,
    @InjectRepository(InboxNotificationRead) private readonly reads: Repository<InboxNotificationRead>,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  // ---- In-app inbox (any authenticated user) ----

  /**
   * Notifications addressed to me directly OR to my role (e.g. QO queue). A user
   * row is read when its read_at is set; a role row is shared, so it is read per
   * person through inbox_notification_reads (or read_at, set before that table).
   */
  @Get('notifications')
  @Roles()
  async list(@CurrentUser() ctx: UserContext) {
    const rows = await this.myQuery(ctx).orderBy('n.created_at', 'DESC').limit(50).getMany();
    const roleIds = rows.filter((n) => !n.read_at && !n.user_id).map((n) => n.id);
    const readIds = new Set(
      roleIds.length ? (await this.reads.find({ where: { user_id: ctx.id, notification_id: In(roleIds) } })).map((r) => r.notification_id) : [],
    );
    return rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      read: !!n.read_at || readIds.has(n.id),
      created_at: n.created_at,
    }));
  }

  @Get('notifications/unread-count')
  @Roles()
  async unreadCount(@CurrentUser() ctx: UserContext) {
    const count = await this.myQuery(ctx)
      .andWhere('n.read_at IS NULL')
      .andWhere('NOT EXISTS (SELECT 1 FROM notification.inbox_notification_reads r WHERE r.notification_id = n.id AND r.user_id = :uid)')
      .getCount();
    return { count };
  }

  @Post('notifications/:id/read')
  @Roles()
  async markRead(@CurrentUser() ctx: UserContext, @UuidParam('id') id: string) {
    await this.markMine(ctx, id);
    return { ok: true };
  }

  @Post('notifications/read-all')
  @Roles()
  async markAllRead(@CurrentUser() ctx: UserContext) {
    await this.markMine(ctx);
    return { ok: true };
  }

  /**
   * Marks one notification (or every unread one) read for the caller only: a user
   * row through its read_at, a role row through a row of its own in the reads table.
   */
  private async markMine(ctx: UserContext, id?: string) {
    const ids = id ? [id] : [];
    await this.inbox.query(
      `UPDATE notification.inbox_notifications SET read_at = now()
       WHERE user_id = $1 AND read_at IS NULL${id ? ' AND id = $2' : ''}`,
      [ctx.id, ...ids],
    );
    await this.inbox.query(
      `INSERT INTO notification.inbox_notification_reads (notification_id, user_id)
       SELECT id, $1 FROM notification.inbox_notifications
       WHERE target_role = $2 AND read_at IS NULL${id ? ' AND id = $3' : ''}
       ON CONFLICT DO NOTHING`,
      [ctx.id, ctx.role, ...ids],
    );
  }

  private myQuery(ctx: UserContext) {
    return this.inbox
      .createQueryBuilder('n')
      .where(new Brackets((w) => w.where('n.user_id = :uid', { uid: ctx.id }).orWhere('n.target_role = :role', { role: ctx.role })));
  }

  // ---- Preferences ----

  @Get('notification-preferences/:userId')
  @Roles()
  async getPrefs(@CurrentUser() ctx: UserContext, @UuidParam('userId') userId: string) {
    this.assertSelfOrAdmin(ctx, userId);
    const row = await this.prefs.findOne({ where: { user_id: userId } });
    return prefView(row, userId);
  }

  /** Partial update: only the fields present in the body change. */
  @Put('notification-preferences/:userId')
  @Roles()
  async putPrefs(@CurrentUser() ctx: UserContext, @UuidParam('userId') userId: string, @Body() dto: PreferencesDto) {
    this.assertSelfOrAdmin(ctx, userId);
    const current = (await this.prefs.findOne({ where: { user_id: userId } })) ?? this.prefs.create({ user_id: userId });
    if (dto.marketing_opt_out !== undefined) current.marketing_opt_out = dto.marketing_opt_out;
    if (dto.new_course_categories !== undefined) current.new_course_categories = uniq(dto.new_course_categories);
    if (dto.new_course_instructor_ids !== undefined) current.new_course_instructor_ids = uniq(dto.new_course_instructor_ids);
    if (dto.new_course_email !== undefined) current.new_course_email = dto.new_course_email;
    if (dto.new_course_in_app !== undefined) current.new_course_in_app = dto.new_course_in_app;
    if (dto.course_updates_email !== undefined) current.course_updates_email = dto.course_updates_email;
    if (dto.progress_emails !== undefined) current.progress_emails = dto.progress_emails;
    if (dto.inactivity_emails !== undefined) current.inactivity_emails = dto.inactivity_emails;
    const saved = await this.prefs.save(current);
    return prefView(saved, userId);
  }

  // ---- Follow / unfollow an instructor (new-course alerts) ----

  /** Follow: add the instructor to my new-course-alert list. Returns follow state. */
  @Post('notifications/follow/:instructorId')
  @Roles()
  async follow(@CurrentUser() ctx: UserContext, @UuidParam('instructorId') instructorId: string) {
    const row = (await this.prefs.findOne({ where: { user_id: ctx.id } })) ?? this.prefs.create({ user_id: ctx.id });
    row.new_course_instructor_ids = uniq([...(row.new_course_instructor_ids ?? []), instructorId]);
    await this.prefs.save(row);
    return { following: true, instructor_id: instructorId };
  }

  @Post('notifications/unfollow/:instructorId')
  @Roles()
  async unfollow(@CurrentUser() ctx: UserContext, @UuidParam('instructorId') instructorId: string) {
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
  async isFollowing(@CurrentUser() ctx: UserContext, @UuidParam('instructorId') instructorId: string) {
    const row = await this.prefs.findOne({ where: { user_id: ctx.id } });
    return { following: (row?.new_course_instructor_ids ?? []).includes(instructorId) };
  }

  @Get('admin/notifications')
  @Roles(Role.PLATFORM_ADMIN)
  recent() {
    return this.log.find({ order: { sent_at: 'DESC' }, take: 100 });
  }

  /**
   * Announcement to a role or to everyone (one inbox row per targeted role —
   * the inbox query already matches on target_role, so no per-user fan-out).
   */
  @Post('admin/notifications/broadcast')
  @Roles(Role.PLATFORM_ADMIN)
  async broadcast(@Body() dto: BroadcastDto) {
    const roles = dto.role ? [dto.role] : Object.values(Role);
    await this.inbox.save(
      roles.map((role) =>
        this.inbox.create({ user_id: null, target_role: role, type: 'announcement', title: dto.title, body: dto.body, link: dto.link ?? null, read_at: null }),
      ),
    );
    return { sent_to_roles: roles };
  }

  /**
   * Sends one test email to the calling admin through the configured provider
   * and reports the provider's answer — the quickest way to confirm email
   * works on a deployment (the result is also written to notification_log).
   */
  @Post('admin/notifications/test-email')
  @Roles(Role.PLATFORM_ADMIN)
  async testEmail(@CurrentUser() ctx: UserContext) {
    if (!ctx.email) throw new BadRequestException('Your account has no email address to send the test to.');
    const subject = 'EthiopiaLearn test email';
    try {
      const { message_id } = await this.email.send({
        to: ctx.email,
        subject,
        html: '<p>This is a test email from EthiopiaLearn. If you can read it, email notifications are working.</p>',
      });
      await this.log.save(this.log.create({ user_id: ctx.id, event_type: 'TestEmail', channel: 'email', recipient: ctx.email, subject, status: 'sent', provider_message_id: message_id }));
      return { ok: true, provider: this.email.name, to: ctx.email, message_id };
    } catch (err) {
      const error = ((err as Error).message || String(err)).slice(0, 500);
      await this.log.save(this.log.create({ user_id: ctx.id, event_type: 'TestEmail', channel: 'email', recipient: ctx.email, subject, status: 'failed', provider_message_id: null, error }));
      return { ok: false, provider: this.email.name, to: ctx.email, error };
    }
  }

  private assertSelfOrAdmin(ctx: UserContext, userId: string) {
    if (ctx.id !== userId && ctx.role !== Role.PLATFORM_ADMIN) throw new ForbiddenException();
  }
}
