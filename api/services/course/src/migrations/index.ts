import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955681997 } from './1790955681997-Baseline';
import { IndexTuning1790956071059 } from './1790956071059-IndexTuning';

// Every migration of the course schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955681997, IndexTuning1790956071059];
