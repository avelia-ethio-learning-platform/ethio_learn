import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955689247 } from './1790955689247-Baseline';
import { IndexTuning1790956084676 } from './1790956084676-IndexTuning';
import { AttemptLookupIndex1791030000003 } from './1791030000003-AttemptLookupIndex';

// Every migration of the outcomes schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955689247, IndexTuning1790956084676, AttemptLookupIndex1791030000003];
