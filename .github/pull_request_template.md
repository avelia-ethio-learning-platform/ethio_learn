## What and why

<!-- What changes, and the plan or issue it comes from. -->

## How it was tested

<!-- Commands run and their results; screenshots for UI changes. -->

## Deploy checks

- [ ] **Does the web still work against the previous API until Render deploys?** Vercel deploys the web at merge; Render deploys the API only after CI passes, up to about 45 minutes later (docs/DEPLOYMENT.md, "Gates").
- [ ] Does the previous web still work against this API?
- [ ] New environment variables are in the `.env.example` files and listed for the owner to set before the merge.
- [ ] Schema changes ship as migrations (`pnpm -C api db:check` passes).
