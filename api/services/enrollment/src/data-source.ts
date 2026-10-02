import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from '@ethiopialearn/common';
import { entities, migrations, SCHEMA } from './database';

// Entry point for the TypeORM CLI (`pnpm migration:generate|run|show|revert`).
// The service itself never imports this file.
export default new DataSource(buildTypeOrmOptions(SCHEMA, entities, migrations));
