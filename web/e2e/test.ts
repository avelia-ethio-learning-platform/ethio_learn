import { expect, test as base } from '@playwright/test';
import { signIn, type Role } from './support';

export * from '@playwright/test';

/**
 * Every spec imports `test` from here (Phase 10). `next start` sends the
 * enforced Content Security Policy (lib/csp.mjs), and this automatic fixture
 * fails a test on any violation in its browser context: a source missing from
 * the policy shows up here instead of as a broken page in production.
 */
export const test = base.extend<{ cspViolations: string[]; loggedInAs: Role | undefined }>({
  /** `test.use({ loggedInAs: 'learner' })`: each test's page starts signed in as that role (support.ts signIn). */
  loggedInAs: [undefined, { option: true }],
  page: async ({ page, loggedInAs }, provide) => {
    if (loggedInAs) await signIn(page, loggedInAs);
    await provide(page);
  },
  cspViolations: [
    async ({ context }, use) => {
      const violations: string[] = [];
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          console.error(`CSP violation: ${e.effectiveDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile}:${e.lineNumber}`);
        });
      });
      // The event above, and the browser's own "Refused to …" messages (workers and wasm included).
      context.on('console', (msg) => {
        if (msg.type() === 'error' && /Content Security Policy|CSP violation/i.test(msg.text())) violations.push(msg.text());
      });
      await use(violations);
      expect(violations, 'Content Security Policy violations').toEqual([]);
    },
    { auto: true },
  ],
});
