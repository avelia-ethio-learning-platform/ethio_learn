import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InternalGuard } from '@ethiopialearn/common';
import { EducatorProfile, Institution, InstitutionInstructor, User } from './entities';

/**
 * Service-to-service READ endpoints (reached via gateway + internal token).
 * Exposes only the minimal identity fields other services need at request time
 * (e.g. certificate rendering, payout payee email).
 */
@Controller('internal')
@UseGuards(InternalGuard)
export class InternalController {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(EducatorProfile) private readonly educatorProfiles: Repository<EducatorProfile>,
    @InjectRepository(Institution) private readonly institutions: Repository<Institution>,
    @InjectRepository(InstitutionInstructor) private readonly instructors: Repository<InstitutionInstructor>,
  ) {}

  @Get('users/:id')
  async user(@Param('id') id: string) {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return { id: user.id, name: user.name, email: user.email, role: user.role };
  }

  /** Is this educator an instructor of an institution? Used to route the review workflow. */
  @Get('users/:id/institution')
  async userInstitution(@Param('id') id: string) {
    const membership = await this.instructors.findOne({ where: { user_id: id } });
    if (!membership) return { institution_id: null, institution_admin_user_id: null, institution_name: null };
    const institution = await this.institutions.findOne({ where: { id: membership.institution_id } });
    return {
      institution_id: membership.institution_id,
      institution_admin_user_id: institution?.owner_user_id ?? null,
      institution_name: institution?.name ?? null,
    };
  }

  @Get('educators/:id')
  async educator(@Param('id') id: string) {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Educator not found');
    const profile = await this.educatorProfiles.findOne({ where: { user_id: id } });
    return { id: user.id, name: user.name, email: user.email, trust_tier: profile?.trust_tier ?? 'new' };
  }

  @Get('institutions/by-owner/:userId')
  async institutionByOwner(@Param('userId') userId: string) {
    const institution = await this.institutions.findOne({ where: { owner_user_id: userId } });
    if (!institution) throw new NotFoundException('No institution for this user');
    return { id: institution.id, name: institution.name };
  }

  @Get('institutions/:id')
  async institution(@Param('id') id: string) {
    const institution = await this.institutions.findOne({ where: { id } });
    if (!institution) throw new NotFoundException('Institution not found');
    const owner = await this.users.findOne({ where: { id: institution.owner_user_id } });
    return { id: institution.id, name: institution.name, email: owner?.email ?? '', owner_user_id: institution.owner_user_id };
  }
}
