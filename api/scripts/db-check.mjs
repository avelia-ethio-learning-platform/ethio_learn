#!/usr/bin/env node
// Schema drift gate: `pnpm -C api db:check` (builds first, then runs this).
//
// For every service, asks TypeORM which DDL would bring the database in line
// with the compiled entities, and fails if there is any: an entity change was
// merged without its migration, or the database drifted from the code.
// Read-only (no migrations, no synchronize, no extension install), so it is
// also the pre-deploy check against production:
//   DATABASE_URL=<url> pnpm -C api db:check
//
// It reads the compiled dist/ of each service, i.e. exactly what deploys.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSchemaCheckOptions, pendingSchemaChanges } = require('../packages/common/dist');

const SERVICES = ['auth', 'course', 'enrollment', 'financial', 'notification', 'outcomes', 'quality'];

let drift = false;
let errors = false;
for (const service of SERVICES) {
  const { SCHEMA, entities, migrations } = require(`../services/${service}/dist/database`);
  try {
    const pending = await pendingSchemaChanges(buildSchemaCheckOptions(SCHEMA, entities, migrations));
    if (pending.length === 0) {
      console.log(`${service.padEnd(13)} ok`);
      continue;
    }
    drift = true;
    console.log(`${service.padEnd(13)} ${pending.length} pending statement(s):`);
    for (const sql of pending) console.log(`  ${sql};`);
  } catch (err) {
    errors = true;
    console.log(`${service.padEnd(13)} check failed: ${err instanceof Error ? err.message : err}`);
  }
}

if (drift) console.log('\nSchema drift: add a migration for these changes (README: "Changing the schema").');
if (errors) console.log('\nThe check could not complete for every service.');
if (drift || errors) process.exit(1);
console.log('\nNo drift: every schema matches its entities.');
