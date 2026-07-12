import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { config } from 'dotenv';

/**
 * Side-effect module: load the nearest `.env` walking up from the current
 * working directory. In the pnpm/turbo monorepo each service's cwd is its own
 * package dir, so a bare `dotenv/config` would miss the repo-root `.env`.
 * Imported first from the package index so env vars are present before any
 * module reads them (TypeORM options, Redis URL, JWT secret, …).
 *
 * In Docker/production, env vars are injected by the orchestrator and no `.env`
 * file exists — this is a no-op there.
 */
let dir = process.cwd();
for (let i = 0; i < 8; i++) {
  const candidate = join(dir, '.env');
  if (existsSync(candidate)) {
    config({ path: candidate });
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
