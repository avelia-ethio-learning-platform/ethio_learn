import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955683895 } from './1790955683895-Baseline';

// Every migration of the enrollment schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955683895];
