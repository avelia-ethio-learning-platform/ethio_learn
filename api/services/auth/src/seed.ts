import 'reflect-metadata';
import '@ethiopialearn/common'; // side-effect: load api/.env so DATABASE_URL is set (seed runs standalone, not via a service bootstrap)
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Role, TrustTier } from '@ethiopialearn/contracts';
import { EducatorProfile, EmailVerification, Institution, InstitutionInstructor, PasswordReset, User } from './entities';
import { AuditLog } from './audit';

/**
 * Dev/demo seed: creates one account per role, all email-verified.
 * Staff roles (quality_officer, platform_admin) can only be provisioned this
 * way or via the admin console — never via public signup.
 */
async function main() {
  const ds = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL ?? 'postgres://ethiopialearn:ethiopialearn@localhost:5432/ethiopialearn',
    schema: 'auth',
    entities: [User, EmailVerification, PasswordReset, EducatorProfile, Institution, InstitutionInstructor, AuditLog],
    synchronize: true,
    uuidExtension: 'pgcrypto',
  });
  await ds.initialize();
  const users = ds.getRepository(User);

  const accounts: Array<{ email: string; name: string; role: Role }> = [
    { email: 'admin@ethiopialearn.et', name: 'Platform Admin', role: Role.PLATFORM_ADMIN },
    { email: 'qo@ethiopialearn.et', name: 'Quality Officer', role: Role.QUALITY_OFFICER },
    { email: 'educator@ethiopialearn.et', name: 'Abebe Kebede', role: Role.EDUCATOR },
    { email: 'learner@ethiopialearn.et', name: 'Sara Tesfaye', role: Role.LEARNER },
    { email: 'institution@ethiopialearn.et', name: 'Addis Coding Academy Admin', role: Role.INSTITUTION_ADMIN },
  ];

  const password_hash = await bcrypt.hash(process.env.SEED_PASSWORD ?? 'Password123!', 10);
  const created: Record<string, User> = {};

  for (const account of accounts) {
    let user = await users.findOne({ where: { email: account.email } });
    if (!user) {
      user = await users.save(
        users.create({ ...account, password_hash, email_verified_at: new Date(), phone: null }),
      );
      console.log(`created ${account.role}: ${account.email}`);
    }
    created[account.role] = user;
  }

  const profiles = ds.getRepository(EducatorProfile);
  if (!(await profiles.findOne({ where: { user_id: created[Role.EDUCATOR].id } }))) {
    await profiles.save(
      profiles.create({
        user_id: created[Role.EDUCATOR].id,
        bio: 'Full-stack engineer and instructor based in Addis Ababa.',
        expertise_area: 'Web Development',
        trust_tier: TrustTier.NEW,
        photo_url: null,
        sample_video_url: null,
      }),
    );
  }

  const institutions = ds.getRepository(Institution);
  if (!(await institutions.findOne({ where: { owner_user_id: created[Role.INSTITUTION_ADMIN].id } }))) {
    await institutions.save(
      institutions.create({ name: 'Addis Coding Academy', owner_user_id: created[Role.INSTITUTION_ADMIN].id, logo_url: null }),
    );
  }

  await ds.destroy();
  console.log('seed complete — password for all demo accounts:', process.env.SEED_PASSWORD ?? 'Password123!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
