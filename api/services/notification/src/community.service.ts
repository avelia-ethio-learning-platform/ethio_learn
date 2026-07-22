import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InternalHttpClient, UserContext } from '@ethiopialearn/common';
import { EntitlementStatus, Role } from '@ethiopialearn/contracts';
import { CourseComment, DmMessage, DmThread, InboxNotification } from './entities';

const COMMENT_MAX = 4000;
const MESSAGE_MAX = 4000;
const PREVIEW_LEN = 80;

/**
 * Community: threaded course comments + 1:1 direct messages.
 * Lives in the notification service — it already owns "communication with
 * users" (inbox, email) and the user-name resolution path.
 */
@Injectable()
export class CommunityService {
  private readonly logger = new Logger(CommunityService.name);

  constructor(
    @InjectRepository(CourseComment) private readonly comments: Repository<CourseComment>,
    @InjectRepository(DmThread) private readonly threads: Repository<DmThread>,
    @InjectRepository(DmMessage) private readonly messages: Repository<DmMessage>,
    @InjectRepository(InboxNotification) private readonly inbox: Repository<InboxNotification>,
    private readonly internal: InternalHttpClient,
  ) {}

  // ============================ Course comments ============================

  /** Public read: flat list ordered oldest→newest; the client builds the tree. */
  async listComments(courseId: string) {
    const rows = await this.comments.find({ where: { course_id: courseId }, order: { created_at: 'ASC' } });
    return rows.map((c) => ({
      id: c.id,
      parent_id: c.parent_id,
      author_id: c.author_id,
      author_name: c.deleted ? '' : c.author_name,
      author_role: c.author_role,
      body: c.deleted ? '' : c.body,
      deleted: c.deleted,
      created_at: c.created_at,
    }));
  }

  async addComment(ctx: UserContext, courseId: string, body: string, parentId?: string) {
    const text = body?.trim();
    if (!text) throw new BadRequestException('Comment body is required');
    if (text.length > COMMENT_MAX) throw new BadRequestException(`Comment too long (max ${COMMENT_MAX} chars)`);

    // Course must exist (also fetches metadata for the notification link).
    let course: { title: string; owner_id: string; created_by: string };
    try {
      course = await this.internal.get(`/api/v1/internal/courses/${courseId}`);
    } catch {
      throw new NotFoundException('Course not found');
    }

    // Posting rights: learners need an active enrollment; educators/staff may
    // always post (the course educator answering their learners is the point).
    if (ctx.role === Role.LEARNER) {
      const ent = await this.internal.get<{ entitlement_status: string }>(
        `/api/v1/internal/entitlements?learner_id=${ctx.id}&course_id=${courseId}`,
      );
      if (ent.entitlement_status !== EntitlementStatus.ACTIVE) {
        throw new ForbiddenException('Enroll in the course to join the discussion');
      }
    }

    let parent: CourseComment | null = null;
    if (parentId) {
      parent = await this.comments.findOne({ where: { id: parentId, course_id: courseId } });
      if (!parent) throw new BadRequestException('Parent comment not found on this course');
    }

    const name = await this.userName(ctx.id);
    const comment = await this.comments.save(
      this.comments.create({
        course_id: courseId,
        parent_id: parent?.id ?? null,
        author_id: ctx.id,
        author_name: name,
        author_role: ctx.role,
        body: text,
      }),
    );

    // Notify the person being answered (reply) or the course author (new thread).
    const preview = text.slice(0, PREVIEW_LEN);
    if (parent && parent.author_id !== ctx.id) {
      await this.inbox.save(
        this.inbox.create({
          user_id: parent.author_id,
          target_role: null,
          type: 'comment_reply',
          title: `${name} replied to your comment on "${course.title}"`,
          body: preview,
          link: `/courses/${courseId}#comments`,
        }),
      );
    } else if (!parent && course.created_by && course.created_by !== ctx.id) {
      await this.inbox.save(
        this.inbox.create({
          user_id: course.created_by,
          target_role: null,
          type: 'course_comment',
          title: `${name} commented on "${course.title}"`,
          body: preview,
          link: `/courses/${courseId}#comments`,
        }),
      );
    }

    return comment;
  }

  /** Author removes their own comment; platform staff can moderate any. */
  async deleteComment(ctx: UserContext, commentId: string) {
    const comment = await this.comments.findOne({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found');
    const isStaff = [Role.PLATFORM_ADMIN, Role.QUALITY_OFFICER].includes(ctx.role as Role);
    if (comment.author_id !== ctx.id && !isStaff) throw new ForbiddenException('Not your comment');
    comment.deleted = true;
    await this.comments.save(comment);
    return { deleted: true };
  }

  // ============================ Direct messages ============================

  /** All my conversations, most recent first. */
  async myThreads(ctx: UserContext) {
    const rows = await this.threads
      .createQueryBuilder('t')
      .where('t.a_id = :id OR t.b_id = :id', { id: ctx.id })
      .orderBy('t.last_message_at', 'DESC', 'NULLS LAST')
      .getMany();
    return rows.map((t) => this.threadView(t, ctx.id));
  }

  /** Find-or-create the 1:1 thread with a recipient. */
  async openThread(ctx: UserContext, recipientId: string) {
    if (recipientId === ctx.id) throw new BadRequestException('You cannot message yourself');
    let recipient: { name: string; role: string };
    try {
      recipient = await this.internal.get(`/api/v1/internal/users/${recipientId}`);
    } catch {
      throw new NotFoundException('Recipient not found');
    }

    const [aId, bId] = [ctx.id, recipientId].sort();
    let thread = await this.threads.findOne({ where: { a_id: aId, b_id: bId } });
    if (!thread) {
      const myName = await this.userName(ctx.id);
      thread = await this.threads.save(
        this.threads.create({
          a_id: aId,
          b_id: bId,
          a_name: aId === ctx.id ? myName : recipient.name,
          b_name: bId === ctx.id ? myName : recipient.name,
          a_role: aId === ctx.id ? ctx.role : recipient.role,
          b_role: bId === ctx.id ? ctx.role : recipient.role,
        }),
      );
    }
    return this.threadView(thread, ctx.id);
  }

  /** Messages in a thread (marks my side read). */
  async threadMessages(ctx: UserContext, threadId: string) {
    const thread = await this.threadOrThrow(threadId, ctx.id);
    const rows = await this.messages.find({ where: { thread_id: thread.id }, order: { created_at: 'ASC' }, take: 500 });
    // Opening the conversation clears my unread counter.
    if (thread.a_id === ctx.id && thread.a_unread > 0) {
      thread.a_unread = 0;
      await this.threads.save(thread);
    } else if (thread.b_id === ctx.id && thread.b_unread > 0) {
      thread.b_unread = 0;
      await this.threads.save(thread);
    }
    return {
      thread: this.threadView(thread, ctx.id),
      messages: rows.map((m) => ({ id: m.id, sender_id: m.sender_id, mine: m.sender_id === ctx.id, body: m.body, created_at: m.created_at })),
    };
  }

  async sendMessage(ctx: UserContext, threadId: string, body: string) {
    const text = body?.trim();
    if (!text) throw new BadRequestException('Message body is required');
    if (text.length > MESSAGE_MAX) throw new BadRequestException(`Message too long (max ${MESSAGE_MAX} chars)`);
    const thread = await this.threadOrThrow(threadId, ctx.id);

    const message = await this.messages.save(this.messages.create({ thread_id: thread.id, sender_id: ctx.id, body: text }));
    thread.last_message_at = message.created_at ?? new Date();
    thread.last_preview = text.slice(0, PREVIEW_LEN);
    if (thread.a_id === ctx.id) thread.b_unread += 1;
    else thread.a_unread += 1;
    await this.threads.save(thread);
    return { id: message.id, sender_id: ctx.id, mine: true, body: text, created_at: message.created_at };
  }

  /** Header badge: total unread messages across all my conversations. */
  async unreadCount(ctx: UserContext) {
    const { a } = await this.threads
      .createQueryBuilder('t')
      .select('COALESCE(SUM(t.a_unread), 0)', 'a')
      .where('t.a_id = :id', { id: ctx.id })
      .getRawOne();
    const { b } = await this.threads
      .createQueryBuilder('t')
      .select('COALESCE(SUM(t.b_unread), 0)', 'b')
      .where('t.b_id = :id', { id: ctx.id })
      .getRawOne();
    return { unread: Number(a) + Number(b) };
  }

  // ============================ helpers ============================

  private threadView(t: DmThread, me: string) {
    const iAmA = t.a_id === me;
    return {
      thread_id: t.id,
      peer: { id: iAmA ? t.b_id : t.a_id, name: iAmA ? t.b_name : t.a_name, role: iAmA ? t.b_role : t.a_role },
      last_preview: t.last_preview,
      last_message_at: t.last_message_at,
      unread: iAmA ? t.a_unread : t.b_unread,
    };
  }

  private async threadOrThrow(id: string, userId: string): Promise<DmThread> {
    const thread = await this.threads.findOne({ where: { id } });
    if (!thread) throw new NotFoundException('Conversation not found');
    if (thread.a_id !== userId && thread.b_id !== userId) throw new ForbiddenException('Not your conversation');
    return thread;
  }

  private async userName(id: string): Promise<string> {
    try {
      return (await this.internal.get<{ name: string }>(`/api/v1/internal/users/${id}`)).name;
    } catch {
      return 'Member';
    }
  }
}
