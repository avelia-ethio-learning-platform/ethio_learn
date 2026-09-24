// Copies the pdf.js worker into public/ so the browser loads it from our own
// origin as /pdf.worker.min.mjs (see src/lib/extract-text.ts). It runs before
// `next dev` / `next build` on purpose: the worker must be the exact version of
// the installed pdfjs-dist API — a stale copy fails at runtime with
// 'The API version "x" does not match the Worker version "y"'. Next 14's
// minifier cannot bundle the worker via `new URL(..., import.meta.url)`, so a
// static file is the reliable path.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(webRoot, 'package.json'));

let pkgDir;
try {
  pkgDir = dirname(require.resolve('pdfjs-dist/package.json'));
} catch {
  console.error('copy-pdf-worker: pdfjs-dist is not installed — run `pnpm install` in web/ first.');
  process.exit(1);
}

const from = join(pkgDir, 'legacy', 'build', 'pdf.worker.min.mjs');
const to = join(webRoot, 'public', 'pdf.worker.min.mjs');
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
