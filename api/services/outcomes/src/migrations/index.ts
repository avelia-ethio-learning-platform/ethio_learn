import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955689247 } from './1790955689247-Baseline';

// Every migration of the outcomes schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955689247];
