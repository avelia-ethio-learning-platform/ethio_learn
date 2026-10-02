import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955680203 } from './1790955680203-Baseline';
import { IndexTuning1790956067652 } from './1790956067652-IndexTuning';
import { MembershipStatus1790964028395 } from './1790964028395-MembershipStatus';
import { MembershipIndexes1790964028396 } from './1790964028396-MembershipIndexes';

// Every migration of the auth schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [
  Baseline1790955680203,
  IndexTuning1790956067652,
  MembershipStatus1790964028395,
  MembershipIndexes1790964028396,
];
