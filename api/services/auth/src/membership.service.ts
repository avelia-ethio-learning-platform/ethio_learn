import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { env, EventBusService, UserContext } from '@ethiopialearn/common';
import { InstructorInvitedPayload, InstructorLinkedPayload, Role, StaffInvitedPayload } from '@ethiopialearn/contracts';
import { AuditLog, appendAudit } from './audit';
import { AuthService, generateTempPassword } from './auth.service';
import { AddInstructorDto, MembershipStatusDto } from './dto';
import { EducatorProfile, Institution, InstitutionInstructor, MembershipStatus, User } from './entities';

/** Roles that can never teach for an institution (acceptance refuses them). */
const CANNOT_JOIN = new Set<string>([Role.PLATFORM_ADMIN, Role.QUALITY_OFFICER, Role.INSTITUTION_ADMIN]);

/** What an institution admin may do to a membership, by target status. */
const ALLOWED_FROM: Record<MembershipStatusDto['status'], MembershipStatus[]> = {
  suspended: ['active'],
  active: ['suspended'], // never invited → active: only the user accepts an invitation
  removed: ['invited', 'active', 'suspended', 'declined'],
};

const ACTIVE_ELSEWHERE = "You're already an active instructor with another institution.";

function isUniqueViolation(err: unknown): boolean {
  return err instanceof QueryFailedError && (err.driverError as { code?: string } | undefined)?.code === '23505';
}

/**
 * Institution membership is consent-based (P0-03). An institution admin can
 * only invite, and suspend or remove a membership; a user's role changes only
 * when they accept an invitation in their own session. Nothing here ever
 * writes users.status or revokes sessions: platform bans stay admin-only.
 */
@Injectable()
export class MembershipService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Institution) private readonly institutions: Repository<Institution>,
    @InjectRepository(InstitutionInstructor) private readonly memberships: Repository<InstitutionInstructor>,
    @InjectRepository(AuditLog) private readonly audit: Repository<AuditLog>,
    private readonly dataSource: DataSource,
    private readonly bus: EventBusService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Invite someone by email. Every address gets the same 201 and an `invited`
   * row, staff and owners included, so the endpoint can't be used to learn who
   * has an account; the response only echoes the email the admin typed.
   */
  async invite(ctx: UserContext, institutionId: string, dto: AddInstructorDto) {
    const institution = await this.ownedInstitution(ctx, institutionId);
    const email = dto.email.toLowerCase().trim();
    let user = await this.users.findOne({ where: { email } });
    if (!user) {
      // A placeholder LEARNER: the role only changes on acceptance, as for anyone.
      user = await this.users.save(
        this.users.create({
          email,
          name: dto.name?.trim() || email.split('@')[0],
          role: Role.LEARNER,
          password_hash: await bcrypt.hash(generateTempPassword(), 10), // replaced on the setup link
          email_verified_at: new Date(),
          must_change_password: true,
          phone: null,
        }),
      );
    }

    let membership = await this.memberships.findOne({ where: { institution_id: institutionId, user_id: user.id } });
    if (membership?.status === 'active') throw new ConflictException('Already an instructor of this institution.');
    if (membership?.status === 'suspended') throw new ConflictException('This instructor is suspended here. Reactivate them instead.');
    if (membership) {
      // invited (re-send), declined or removed (re-invite): back to a fresh invitation.
      membership.status = 'invited';
      membership.status_reason = null;
      membership.accepted_at = null;
      membership.invited_by = ctx.id;
      membership = await this.memberships.save(membership);
    } else {
      try {
        membership = await this.memberships.save(
          this.memberships.create({
            institution_id: institutionId,
            user_id: user.id,
            status: 'invited',
            invited_by: ctx.id,
            role_in_org: dto.role_in_org ?? 'instructor',
          }),
        );
      } catch (err) {
        // A concurrent invite of the same person won the insert; theirs stands.
        if (!isUniqueViolation(err)) throw err;
        membership = await this.memberships.findOneOrFail({ where: { institution_id: institutionId, user_id: user.id } });
      }
    }
    await appendAudit(this.audit, ctx.id, 'institution.member_invited', membership.id, { institution_id: institutionId, user_id: user.id });

    if (CANNOT_JOIN.has(user.role)) {
      // Same response as anyone else, but no email they couldn't act on.
    } else if (user.must_change_password) {
      // Never set their own password (a placeholder from an earlier invite):
      // a fresh setup link, naming the institution.
      const token = await this.auth.createInvite(user.id);
      await this.bus.publish<StaffInvitedPayload>('StaffInvited', {
        user_id: user.id,
        email: user.email,
        name: user.name,
        role: 'instructor',
        invite_url: `${env('WEB_URL', 'http://localhost:3000')}/accept-invite?token=${token}`,
        institution_name: institution.name,
      });
    } else {
      await this.bus.publish<InstructorInvitedPayload>('InstructorInvited', {
        user_id: user.id,
        email: user.email,
        name: user.name,
        institution_id: institutionId,
        institution_name: institution.name,
      });
    }
    return { membership: { id: membership.id, status: membership.status, email } };
  }

  /** Name and role appear only once the person has accepted; invitations show the typed email. */
  async list(ctx: UserContext, institutionId: string) {
    await this.ownedInstitution(ctx, institutionId);
    const rows = await this.memberships.find({ where: { institution_id: institutionId }, order: { created_at: 'ASC' } });
    const users = rows.length ? await this.users.find({ where: { id: In(rows.map((r) => r.user_id)) } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((row) => {
      const user = byId.get(row.user_id);
      const accepted = row.status !== 'invited' && row.accepted_at !== null;
      return {
        membership_id: row.id,
        status: row.status,
        status_reason: row.status_reason,
        email: user?.email ?? null,
        ...(accepted && user ? { user: { id: user.id, name: user.name, role: user.role } } : {}),
      };
    });
  }

  /** Suspend, reactivate or remove a membership. The user's account is untouched. */
  async setStatus(ctx: UserContext, institutionId: string, membershipId: string, dto: MembershipStatusDto) {
    await this.ownedInstitution(ctx, institutionId);
    const reason = dto.status === 'active' ? null : (dto.reason?.trim() || null);
    let affected: number | undefined;
    try {
      // Conditional on the current status, so two admins clicking at once can't skip a rule.
      ({ affected } = await this.memberships.update(
        { id: membershipId, institution_id: institutionId, status: In(ALLOWED_FROM[dto.status]) },
        { status: dto.status, status_reason: reason },
      ));
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('This instructor is active with another institution now.');
      throw err;
    }
    const membership = await this.memberships.findOne({ where: { id: membershipId, institution_id: institutionId } });
    if (!membership) throw new NotFoundException('Not a member of this institution.');
    if (!affected) throw new BadRequestException(`A ${membership.status} membership can't be set to ${dto.status}.`);
    await appendAudit(this.audit, ctx.id, 'institution.member_status', membership.id, {
      institution_id: institutionId,
      user_id: membership.user_id,
      status: dto.status,
      reason,
    });
    return { membership_id: membership.id, status: membership.status, status_reason: membership.status_reason };
  }

  /** The signed-in user's pending invitations, with the inviting institution named. */
  async myInvites(userId: string) {
    const rows = await this.memberships.find({ where: { user_id: userId, status: 'invited' }, order: { created_at: 'ASC' } });
    if (!rows.length) return [];
    const institutions = await this.institutions.find({ where: { id: In(rows.map((r) => r.institution_id)) } });
    const byId = new Map(institutions.map((i) => [i.id, i]));
    return rows
      .filter((r) => byId.has(r.institution_id))
      .map((r) => ({ id: r.id, institution: { id: r.institution_id, name: byId.get(r.institution_id)!.name }, invited_at: r.created_at }));
  }

  /**
   * The user accepts in their own session: the membership becomes active and a
   * learner becomes an educator, in one transaction. The web then refreshes
   * its token, which re-reads the role.
   */
  async accept(userId: string, membershipId: string): Promise<{ role: Role }> {
    let outcome: { user: User; membership: InstitutionInstructor; upgraded: boolean };
    try {
      outcome = await this.dataSource.transaction(async (m) => {
        const memberships = m.getRepository(InstitutionInstructor);
        const res = await memberships.update(
          { id: membershipId, user_id: userId, status: 'invited' },
          { status: 'active', accepted_at: new Date(), status_reason: null },
        );
        if (!res.affected) throw new NotFoundException('No pending invitation with this id.');
        const users = m.getRepository(User);
        const user = await users.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('User not found');
        if (CANNOT_JOIN.has(user.role)) {
          throw new ForbiddenException("Platform staff and institution owners can't join an institution as instructors.");
        }
        const upgraded = user.role === Role.LEARNER;
        if (upgraded) {
          await users.update({ id: userId }, { role: Role.EDUCATOR });
          user.role = Role.EDUCATOR;
        }
        const profiles = m.getRepository(EducatorProfile);
        if (!(await profiles.findOne({ where: { user_id: userId } }))) {
          await profiles.save(profiles.create({ user_id: userId, bio: '', expertise_area: '', photo_url: null, sample_video_url: null }));
        }
        const membership = await memberships.findOneOrFail({ where: { id: membershipId } });
        await appendAudit(m.getRepository(AuditLog), userId, 'institution.member_accepted', membershipId, {
          institution_id: membership.institution_id,
          upgraded_from_learner: upgraded,
        });
        return { user, membership, upgraded };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException(ACTIVE_ELSEWHERE);
      throw err;
    }

    const { user, membership, upgraded } = outcome;
    const institution = await this.institutions.findOne({ where: { id: membership.institution_id } });
    await this.bus.publish<InstructorLinkedPayload>('InstructorLinked', {
      user_id: user.id,
      email: user.email,
      name: user.name,
      institution_id: membership.institution_id,
      institution_name: institution?.name ?? 'your institution',
      upgraded_from_learner: upgraded,
    });
    return { role: user.role };
  }

  async decline(userId: string, membershipId: string) {
    const res = await this.memberships.update({ id: membershipId, user_id: userId, status: 'invited' }, { status: 'declined' });
    if (!res.affected) throw new NotFoundException('No pending invitation with this id.');
    await appendAudit(this.audit, userId, 'institution.member_declined', membershipId, {});
    return { status: 'declined' as const };
  }

  private async ownedInstitution(ctx: UserContext, institutionId: string): Promise<Institution> {
    const institution = await this.institutions.findOne({ where: { id: institutionId } });
    if (!institution) throw new NotFoundException('Institution not found');
    if (ctx.role !== Role.PLATFORM_ADMIN && institution.owner_user_id !== ctx.id) throw new ForbiddenException('Not your institution');
    return institution;
  }
}
