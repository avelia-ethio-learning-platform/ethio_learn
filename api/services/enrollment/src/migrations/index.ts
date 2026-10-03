import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955683895 } from './1790955683895-Baseline';
import { IndexTuning1790956074361 } from './1790956074361-IndexTuning';
import { VideoProgressStartedAt1791030000001 } from './1791030000001-VideoProgressStartedAt';

// Every migration of the enrollment schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955683895, IndexTuning1790956074361, VideoProgressStartedAt1791030000001];
