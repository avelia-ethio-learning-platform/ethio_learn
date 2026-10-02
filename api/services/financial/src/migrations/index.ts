import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955685613 } from './1790955685613-Baseline';

// Every migration of the financial schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955685613];
