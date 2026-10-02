import type { MigrationClass } from '@ethiopialearn/common';

// Every migration of the course schema, oldest first. A new migration only runs
// once it is listed here.
export const migrations: MigrationClass[] = [];
