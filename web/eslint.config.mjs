// Lint for the web app (next/core-web-vitals, eslint-config-next's native flat config).
// CI fails only when the problem count rises above .github/lint-baseline.json
// (scripts/lint-check.mjs).
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

export default [
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'public/**', 'next-env.d.ts'] },
  ...nextCoreWebVitals,
];
