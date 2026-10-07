import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955681997 } from './1790955681997-Baseline';
import { IndexTuning1790956071059 } from './1790956071059-IndexTuning';
import { LessonVideoDuration1791030000002 } from './1791030000002-LessonVideoDuration';
import { ProcessedEvents1791049973876 } from './1791049973876-ProcessedEvents';
import { Outbox1791054790074 } from './1791054790074-Outbox';

// Every migration of the course schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955681997, IndexTuning1790956071059, LessonVideoDuration1791030000002, ProcessedEvents1791049973876, Outbox1791054790074];
