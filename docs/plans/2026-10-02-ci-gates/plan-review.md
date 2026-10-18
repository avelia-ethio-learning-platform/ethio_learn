# Plan review: Phase 11a, CI/CD gates and repo hygiene

## Round 1 (2026-10-03) · Verdict: APPROVED (three should-fixes to fold in before handoff)
Reviewed: `plan.md` (status "in review (round 1)").

The split of Phase 11 into 11a, 11b and 11c is sensible. A ruleset as reviewed JSON that the user applies, `autoDeployTrigger`, Dependabot with groups, and a lint baseline are the right, boring choices. Leaving the license and the support mailbox to the user is correct.

### Blockers
None.

### Should-fix
- **S1. The admin bypass lets direct pushes skip the ruleset, so Risks' "blocks direct pushes, including the agents'" is wrong** at decision 1 ("bypass: the repository admin role")
  Scenario: every session pushes as the user, who is the repository admin. With the default bypass mode (`always`), a `git push origin main` from any session or terminal lands without a PR or checks. Under `checksPass`, Render then deploys it once CI goes green. Nothing reaches production unreviewed is then true only by convention.
  Suggested: give the bypass actor `"bypass_mode": "pull_request"`. Emergencies then go through a PR the admin can merge despite the rules, and direct pushes are refused for everyone. Correct the Risks line to match.
  Response: **fixed.** The bypass actor has `"bypass_mode": "pull_request"`, so direct pushes to `main` are refused for everyone, the admin included. The acceptance criterion, decision 1, step 6's check and the Risks line now say so.
- **S2. Make `lint` a required check; otherwise a PR can raise the baseline, and a red lint on `main` freezes Render deploys** at decision 4 and the required-checks list
  - **Not enforced:** the required checks are `api`, `web`, `e2e` and `secret-scan`. So "a baseline count that a PR can't increase" isn't enforced: with 0 required approvals, a PR merges with `lint` red.
  - **Deploy freeze:** once that commit is on `main`, its `lint` check fails there too, and Render's "after checks pass" (which Risks says waits for every check on the commit) never deploys it, or anything after it, until lint is fixed.
  - **Safe to require:** the job fails only when the count rises.

  Suggested: add `lint` to the ruleset's required checks. Keep `audit` (`continue-on-error`) and the path-filtered `docker-build` out of the list, since a path-filtered job never reports on PRs that don't touch Dockerfiles. Confirm in step 6 that Render treats a `continue-on-error` job as passed.
  Response: **fixed.** `lint` is a required check, and the acceptance criterion, decision 4 and the Non-goals now say so: it blocks only a rising count, not warnings. I went one step further on `audit`. It no longer relies on job-level `continue-on-error`: its steps use step-level `continue-on-error` and a last step writes the summary, so the check always concludes `success` and can't hold up `checksPass`. Step 5 confirms that on the draft PR. `docker-build` stays unrequired and doesn't run on `main` pushes.
- **S3. Say that web now deploys well before the API** at decision 2 and docs ("Gates")
  - **The skew:** Vercel deploys the web on the merge commit at once, while Render now waits for CI, with `e2e` alone allowed 40 minutes. Every merge that changes an API contract therefore runs new web against the old API for most of an hour, instead of the few minutes of a Render build today. 9e's `{ items, has_more }` change is the next example.
  - **Why it matters:** the phases so far handle "web before API" case by case. With `checksPass` it becomes the norm.

  Suggested:
  - document the skew in `docs/DEPLOYMENT.md` ("Gates");
  - add a line to the PR template: "Does the web work against the previous API until Render deploys?";
  - optionally gate Vercel's production deploy on the same checks, if the plan allows it; say which.

  Response: **fixed.** The skew is documented in DEPLOYMENT.md "Gates" (up to about 45 minutes of new web against the old API after each merge), it's in the acceptance and Risks, and the PR template asks "Does the web still work against the previous API until Render deploys?". Vercel isn't gated: that needs a Vercel token in GitHub and a deploy workflow replacing the Git integration. It's listed in the Non-goals with that reason.

  Nits: N1 taken (Dependabot's `docker` ecosystem for `/api` and `/web`). N2 taken (`integration_id: 15368` on each required check). N3 taken (links updated on the `docs/history/` move).

### Nits (optional, max 3)
- **N1.** Base images pinned by digest never get security patches unless something bumps the digests. Add Dependabot's `docker` ecosystem for `/api` and `/web`, so the pins stay pinned and current.
- **N2.** In the ruleset's `required_status_checks`, set each check's `integration_id` to GitHub Actions (15368). Then only Actions can satisfy `api`, `web`, `e2e`, `secret-scan` and `lint`, not a status posted under the same name.
- **N3.** Moving `HANDOFF.md`, `FEATURES_ADDED.md` and the rest to `docs/history/` should update any links to them in README and docs (`git grep -n` the names), so the move leaves no dead links.
