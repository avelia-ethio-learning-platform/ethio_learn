import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955690968 } from './1790955690968-Baseline';

// Every migration of the quality schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955690968];
