import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955687490 } from './1790955687490-Baseline';
import { IndexTuning1790956081272 } from './1790956081272-IndexTuning';
import { EventDedupe1791050068634 } from './1791050068634-EventDedupe';

// Every migration of the notification schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955687490, IndexTuning1790956081272, EventDedupe1791050068634];
