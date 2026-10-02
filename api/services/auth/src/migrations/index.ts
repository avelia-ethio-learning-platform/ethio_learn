import type { MigrationClass } from '@ethiopialearn/common';
import { Baseline1790955680203 } from './1790955680203-Baseline';

// Every migration of the auth schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [Baseline1790955680203];
