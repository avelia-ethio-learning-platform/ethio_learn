// Lint for the api workspace. CI fails only when the problem count rises above
// .github/lint-baseline.json (scripts/lint-check.mjs), not on existing findings.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'jest.config.js'] },
  ...tseslint.configs.recommended,
  {
    // Type-aware: an unawaited promise in service code is a lost error or a race.
    files: ['gateway/src/**/*.ts', 'services/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/testing/**'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: { '@typescript-eslint/no-floating-promises': 'error' },
  },
);
