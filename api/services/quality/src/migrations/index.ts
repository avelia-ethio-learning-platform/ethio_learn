import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955690968 } from './1790955690968-Baseline';
import { IndexTuning1790956088164 } from './1790956088164-IndexTuning';
import { ProcessedEvents1791049972025 } from './1791049972025-ProcessedEvents';
import { Outbox1791054805346 } from './1791054805346-Outbox';

// Every migration of the quality schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955690968, IndexTuning1790956088164, ProcessedEvents1791049972025, Outbox1791054805346];
