import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955687490 } from './1790955687490-Baseline';

// Every migration of the notification schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955687490];
