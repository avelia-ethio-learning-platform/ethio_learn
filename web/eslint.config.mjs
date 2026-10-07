// Lint for the web app (next/core-web-vitals). CI fails only when the problem
// count rises above .github/lint-baseline.json (scripts/lint-check.mjs).
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'public/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals'),
];
