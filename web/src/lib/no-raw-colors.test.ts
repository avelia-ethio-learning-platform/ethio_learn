// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Components ask for a colour role (`text-danger`, `bg-brand-50`), never a Tailwind palette class
 * or a hex value: a role holds its value in both themes (docs/COLOR_SYSTEM.md, "Roles, not hues").
 * Each offender is named file:line so it can be fixed from the message.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const DOC = 'docs/COLOR_SYSTEM.md';

/** The files that must hold literal colours: category data, Satori images, the browser-bar colours and the error page. */
const HEX_ALLOWED = new Set([
  'lib/categories.ts',
  'lib/brand-art.tsx',
  'lib/theme-script.ts',
  'app/manifest.ts',
  'app/global-error.tsx',
  'app/(public)/courses/[id]/opengraph-image.tsx',
]);

const HUES = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|zinc|neutral|stone';
const PALETTE = new RegExp(
  `(?<![\\w-])(?:text|bg|border|from|to|via|fill|ring|ring-offset|stroke|outline|decoration|divide|placeholder|accent|caret|shadow)(?:-[trblxyse])?-(?:${HUES})-\\d{2,3}\\b`,
  'g',
);
const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

function offenders(pattern: RegExp, skip: (file: string) => boolean): string[] {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const name = relative(SRC, file);
    if (skip(name)) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.match(pattern) ?? []) found.push(`${name}:${i + 1} ${m}`);
      });
  }
  return found;
}

describe('no raw colours in web/src', () => {
  it('uses colour roles, not Tailwind palette classes', () => {
    expect(offenders(PALETTE, () => false), `palette classes; use a role from ${DOC}`).toEqual([]);
  });

  it('keeps hex values to the allowlisted files', () => {
    expect(offenders(HEX, (name) => HEX_ALLOWED.has(name)), `hex values outside the allowlist; add a token (${DOC})`).toEqual([]);
  });
});
