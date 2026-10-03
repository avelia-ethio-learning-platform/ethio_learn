import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955680203 } from './1790955680203-Baseline';
import { IndexTuning1790956067652 } from './1790956067652-IndexTuning';
import { MembershipStatus1790964028395 } from './1790964028395-MembershipStatus';
import { MembershipIndexes1790964028396 } from './1790964028396-MembershipIndexes';
import { InvitedAt1790964028397 } from './1790964028397-InvitedAt';
import { InvitedAtIndex1790964028398 } from './1790964028398-InvitedAtIndex';
import { EmailVerificationCreatedAt1791018655934 } from './1791018655934-EmailVerificationCreatedAt';
import { EmailVerificationCreatedAtIndex1791018655935 } from './1791018655935-EmailVerificationCreatedAtIndex';
import { Outbox1791054783695 } from './1791054783695-Outbox';

// Every migration of the auth schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [
  Baseline1790955680203,
  IndexTuning1790956067652,
  MembershipStatus1790964028395,
  MembershipIndexes1790964028396,
  InvitedAt1790964028397,
  InvitedAtIndex1790964028398,
  EmailVerificationCreatedAt1791018655934,
  EmailVerificationCreatedAtIndex1791018655935,
  Outbox1791054783695,
];
