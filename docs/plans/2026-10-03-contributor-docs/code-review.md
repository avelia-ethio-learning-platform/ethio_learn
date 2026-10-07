# Code review: Phase 11d, contributor guide, features and roadmap, color system

## Round 1 (2026-10-03) · Verdict: APPROVED (no blockers, no should-fix; N1–N3 optional)
Reviewed `git diff chore/ci-gates...docs/contributor-guide` at `a4add0e` against the plan and the round-1 plan review, in `../ethi0-11d` (read only).

**The plan-review findings are all resolved:**
- S1–S4, N1 and N2 are fixed as answered.
- N3's decline is reasoned: 7c's `color-tokens.test.ts` becomes the checker, and the doc cites the formula rather than a script path. I accept it.

**Checks I ran myself:**
- **Contrast table:** `palette.mjs` on the branch reproduces the doc's table and `palette-table.md` row for row (diffed).
- **Links:** every relative link and `#anchor` in the four docs resolves (my own script).
- **Public safety:** a grep of the added lines for email addresses, key-shaped strings and production hosts or database URLs finds nothing.
- **Facts:** a fact-check of 20 claims in FEATURES_AND_ROADMAP against the code found none false. True: 36 page routes, about 180 public endpoints, 7 services plus the gateway, 47 event types, the 80/20 split, the refund bands, the payout holds, the bulk-seat tiers, the QO SLAs and claim lock, the 20% review gate, ten admin tabs, the 4 s notice, the 7-day credit hold, the trust tiers, the catalog options, the verified-email login, and Home's ISR. Partly true: N2 below, plus two that need no change.
- **CONTRIBUTING:**
  - its commands exist (`seed`, `dev`, `typecheck`, `db:check`, `lint-check.mjs --update`);
  - Node 22 and pnpm 9 match `.nvmrc` and `packageManager`;
  - the five required checks and "up to date with main" match `.github/rulesets/main.json` (`strict_required_status_checks_policy`);
  - "CI runs all of them" matches `ci.yml`;
  - the 45-minute window matches DEPLOYMENT.md;
  - the login budget matches `playwright.config.ts` and `rate-policy.ts`;
  - `FormStatus`, `Field`'s `aria-describedby` and the i18n parity test exist.
- **COLOR_SYSTEM:** its other claims hold: the token values, the inverted scales, `el_theme`, the disabled styles, `.btn`'s fixed fill, white on dark `#ef4444` at 3.8 and white on `#60a5fa` at 2.5.

**Public safety (S4):** I read the "Stubbed, mock-only and known gaps" and "After launch" sections, the phase tables and the README's status:
- They name features and outcomes only.
- The audit's leftover items are a single line with no detail.
- Nothing points at a protection the live site lacks.
- The not-yet-deployed phases (9a–9e, 10, 11b) are worded by outcome.

**The S3 gate:** the setting is still `{"enabled":false}`. USER-ACTIONS has the 🟥 item (`gh api -X PUT …`, with the GET as its check), and it blocks the merge. Merge only after the user says "vulnerability reporting on".

### Blockers
None.

### Should-fix
None.

### Nits (optional)
- **N1.** `COLOR_SYSTEM.md:95` describes the input focus wrongly. It says "`.input` adds a 3 px `ring` glow on focus", which reads as if the outline stays. In fact `.input:focus-visible` sets `outline: none` and shows a `brand-500` border plus the 3 px glow (`globals.css:274-279`). Suggested: "`.input` replaces the outline with a `brand-500` border and a 3 px `ring` glow (`#3b82f6`, 3.68:1 on white)."
- **N2.** `FEATURES_AND_ROADMAP.md:186`: "a low rating or a high refund rate sends a course back to review". The refund rate is the educator's across their sales (above 20% once they have 5 payments), not the course's. Both triggers only fire for a course that has been reviewed before (`quality.service.ts:745-769`). Suggested: "a low course rating, or a high refund rate across the educator's sales, sends a reviewed course back for another review."
- **N3.** Two lines are slightly off:
  - `README.md:57`'s services row still says the notification service sends email through "Resend or dev console". The providers table now lists Brevo and SMTP as well.
  - `CONTRIBUTING.md:238` says "10 login calls a minute". The bucket covers all credential calls (login, signup, verify, resend, reset), which is why the suite's 8 include a signup and a resend.

### Implementer responses (round 1, ethio-planner [31d0d2], 2026-10-03)
- **N1: fixed.** The focus row now says `.input` replaces the outline with a `brand-500` border and the 3 px glow.
- **N2: fixed.** The trigger is now "a low course rating, or a high refund rate across the educator's sales", and it applies to a reviewed course.
- **N3: fixed.** The README's notification row lists Brevo, SMTP and Resend. CONTRIBUTING says "credential calls" and names them.
