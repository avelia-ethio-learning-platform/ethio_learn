# Deployment

This is the one deployment document. It describes the setup that runs today:

- **Backend:** eight free Render web services (the API gateway and seven domain services), defined in [`render.yaml`](../render.yaml) and built from `api/Dockerfile`.
- **Web:** `web/` on Vercel (Root Directory = `web`).
- **Managed infrastructure:**
  - Neon for Postgres;
  - Cloudflare R2 for object storage;
  - CloudAMQP for RabbitMQ;
  - Upstash for Redis;
  - Brevo for email.

Local development is in the [README](../README.md). The variables are listed in [`api/.env.example`](../api/.env.example) and [`web/.env.example`](../web/.env.example).

## Topology

```
 browser ──▶ web (Vercel) ──NEXT_PUBLIC_API_URL──▶ gateway (Render, public)
 Chapa webhooks ─────────────────────────────────▶ gateway
                                                     │ *_SERVICE_URL: public https://ethiopialearn-<svc>.onrender.com
                                                     │ + x-internal-token
      ┌──────────┬──────────┬──────────┬──────────┬──┴───────┬──────────┐
      ▼          ▼          ▼          ▼          ▼          ▼          ▼
    auth      course   enrollment  outcomes   financial   quality  notification
      └──────────┴──────────┴─────┬────┴──────────┴──────────┴──────────┘
              Neon Postgres (schema per service) · CloudAMQP (events)
              Upstash Redis (refresh-token allowlist) · R2 (media)
```

**Every service has a public URL.** Free Render services can send private-network requests but can't receive them, so the gateway reaches each service at its public `onrender.com` address (`render.yaml`, gateway env). The service itself enforces what keeps that safe:

- every service rejects a request that doesn't carry `INTERNAL_API_TOKEN` (`REQUIRE_INTERNAL_TOKEN`, on by default when `NODE_ENV=production`);
- the gateway strips client-sent `x-internal-token` and `x-user-*` headers and sets its own.

Never turn the check off: a service trusts the `x-user-*` headers it receives. On a paid instance type, the gateway could go back to `fromService` private addresses.

The three communication rules:

1. **Clients talk only to the gateway** (`NEXT_PUBLIC_API_URL`).
2. **Synchronous service-to-service reads go back through the gateway:**
   - the call goes through `InternalHttpClient` to `GATEWAY_INTERNAL_URL`, carrying the shared token. On Render that URL is the gateway's public URL;
   - no service dials another service's host directly, so only the gateway's route table knows where a service lives.
3. **Everything asynchronous is a RabbitMQ event:**
   - `RABBITMQ_URL`, with a fanout exchange per event type;
   - the envelope is in `api/packages/contracts/src/events.ts`;
   - payloads carry the state the consumer needs, so a consumer never needs a cross-schema join.

**Data isolation:**
- each service owns one Postgres schema (`buildTypeOrmOptions('<service>', …)`);
- no service imports from another service's `src/`;
- giving a service its own `DATABASE_URL` moves it to its own database.

## Environment variables

All configuration is environment variables. `render.yaml` holds the shared group `ethiopialearn-shared` and each service's own keys. Render prompts once for every `sync: false` value, and generates `JWT_SECRET`, `CERT_SIGNING_SECRET` and `INTERNAL_API_TOKEN` once, shared by every service. Vercel holds the web's `NEXT_PUBLIC_*` values, which are inlined at build time, so redeploy after changing one.

| Deployable | Needs | Notes |
|---|---|---|
| gateway | `JWT_SECRET`, `INTERNAL_API_TOKEN`, `CORS_ORIGINS`/`WEB_URL`, one `*_SERVICE_URL` per service | The only place service addresses exist. `CORS_ORIGINS` replaces the `WEB_URL` default rather than extending it. The rate limiter (`RATE_LIMIT_*`) is in memory, per instance. |
| every service | `DATABASE_URL`, `RABBITMQ_URL`, `JWT_SECRET`, `INTERNAL_API_TOKEN`, `GATEWAY_INTERNAL_URL` | `PORT` is injected by Render. |
| auth | + `REDIS_URL`, `WEB_URL`, `COOKIE_SAMESITE=none` | |
| course | + `S3_*`, `GROQ_API_KEY` | |
| outcomes | + `S3_*`, `GROQ_API_KEY`, `CERT_SIGNING_SECRET` | |
| financial | + `CHAPA_MODE`, `CHAPA_SECRET_KEY`, `CHAPA_WEBHOOK_SECRET`, `CHAPA_FALLBACK_EMAIL`, `GATEWAY_PUBLIC_URL`, `WEB_URL` | Register `<GATEWAY_PUBLIC_URL>/api/v1/payments/webhook/chapa` in the Chapa dashboard. `CHAPA_WEBHOOK_SECRET` is the dashboard's webhook secret hash, not a `CHAPUBK_…` public key. |
| quality | + `GROQ_API_KEY` | |
| notification | + `SMTP_*` (or `BREVO_API_KEY`/`RESEND_API_KEY`), `EMAIL_FROM`, `PLATFORM_ADMIN_EMAIL`, `SUPPORT_EMAIL`, `WEB_URL` | `EMAIL_FROM` must be a Brevo-verified sender. |
| web (Vercel) | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_S3_PUBLIC_URL`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_WAKE_URLS` | |

**Secrets.** `JWT_SECRET`, `CERT_SIGNING_SECRET`, `INTERNAL_API_TOKEN` and `CHAPA_WEBHOOK_SECRET` are long random values, at least 32 characters. With `NODE_ENV=production`, every service and the gateway refuse to boot when:
- a secret they need is missing, shorter than 32 characters or a value from the repo;
- `REQUIRE_INTERNAL_TOKEN` is turned off;
- `WEB_URL` or `GATEWAY_PUBLIC_URL` points at localhost.

The log names each variable, never its value, so a failed boot says what to set.

## Render and Vercel: what's easy to miss

- **The refresh cookie is cross-site.** `*.vercel.app` and `*.onrender.com` are different registrable domains, so a `SameSite=Lax` cookie is never sent on the refresh call. Every session would then die at the 15-minute access-token expiry. `COOKIE_SAMESITE=none` (set in `render.yaml`) forces `Secure` on.
- **CORS is an explicit allowlist,** and the localhost escape hatch is off in production. Vercel preview deployments get random hostnames, so they're blocked unless added to `CORS_ORIGINS`.
- **Neon needs TLS and small pools.** `buildTypeOrmOptions` turns SSL on when the connection string carries `sslmode=require`; `DB_SSL` overrides that either way. Use the pooled (`…-pooler.…`) host. `render.yaml` sets `DB_POOL_MAX=3` and `DB_POOL_MIN=0`, because eight pools add up against Neon's connection cap.
- **Outbound SMTP:** Render's free instances block ports 25, 465 and 587. `render.yaml` uses Brevo on port 2525 (plain connect, then STARTTLS); `BREVO_API_KEY` (HTTPS) is the alternative.
- **R2:** signed URLs are signed against the S3 API endpoint (`S3_ENDPOINT`), not the public `r2.dev` host. Keep `videos/` private; `thumbnails/` is public-read.
- **Before the first boot** of a new database, run `docker/postgres-init.sql` once to create the seven schemas and `pgcrypto`. Migrations create the tables, never the schemas.

## Cold starts and waking

- **Sleep:** free Render services sleep after 15 idle minutes, and only outside traffic wakes them. A sleeping service answers the gateway with an immediate `429` (`x-render-routing: hibernate-rate-limited`) and stays asleep.
- **Waking:** a request to the service's own public `/health` from outside Render wakes it in about 25 s. The web app does this from the browser when it meets a sleeping service. Set `NEXT_PUBLIC_WAKE_URLS` on Vercel (Production) to the eight public `/health` URLs, comma-separated: `https://ethiopialearn-gateway.onrender.com/health`, and the same for `auth`, `course`, `enrollment`, `outcomes`, `financial`, `quality` and `notification`. Up to eight `ERR_BLOCKED_BY_RESPONSE` console errors per wake are expected: Helmet's `Cross-Origin-Resource-Policy` blocks the opaque responses, and the requests still reach Render.
- **Scheduled work runs only while a service is awake.** The `@Cron` jobs live inside the services:
  - financial: the pending-payment sweep and the pending-effects re-publish every 2 minutes, the abandoned-checkout nudge hourly, the payout run at 02:00;
  - enrollment: the inactivity nudges at 06:00.

  A sleeping instance runs none of them. A missed Chapa webhook is still settled by the return page's reconcile, and by the sweep once the financial service is awake. The payout run can also be started by hand with `POST /api/v1/payouts/run` as a platform admin.
- **Instances:** each free service runs one instance. That's why the crons and the migrations (below) need no lock.

## Gates

**On GitHub:**
- **The ruleset** on `main` ([`.github/rulesets/main.json`](../.github/rulesets/main.json)) requires a pull request, an up-to-date branch, and the `api`, `web`, `e2e`, `secret-scan` and `lint` checks from GitHub Actions.
- It blocks force-pushes and deletion.
- The admin bypasses only through a pull request (`bypass_mode: pull_request`), so nobody pushes to `main` directly.
- Renaming one of those CI jobs needs the ruleset updated in the same PR.
- **`audit`** reports advisories as a warning and never fails.
- **`docker-build`** runs only on PRs that touch a Dockerfile, a `.dockerignore` or a lockfile.
- Neither is required.

**Render deploys after checks pass:**
- every service has `autoDeployTrigger: checksPass`;
- Render waits for every GitHub check on the commit. `success`, `neutral` and `skipped` count as passed. A commit with a failed check, or with no checks at all, isn't deployed ([Render: deploys](https://render.com/docs/deploys)).

**The web runs ahead of the API after every merge:**
- Vercel deploys the web from the merge commit at once. Render waits for CI on that commit, and `e2e` alone may take 40 minutes.
- So for up to about 45 minutes after each merge, the new web runs against the old API.
- Every API change must keep the previous web working, and every web change must work against the previous API. The [PR template](../.github/pull_request_template.md) asks the second question.

**Lint:**
- the `lint` job fails only when a rule's problem count rises above [`.github/lint-baseline.json`](../.github/lint-baseline.json);
- when a PR lowers it, run `pnpm -C api build && node scripts/lint-check.mjs --update` and commit the new baseline. Without the build, type-aware rules can't see the api packages' types, and the counts come out lower.

## Environments

**There is one environment: production.**
- The eight free services already use the shared monthly instance-hour budget, so a second copy doesn't fit the free tier.
- The pre-production checks are local `docker compose` and CI's `e2e` job, which boots every service against real Postgres, RabbitMQ, Redis and MinIO.

**A staging environment would need:**
- a second set of services (another Blueprint, or Render's paid preview environments) with `CHAPA_MODE=mock`;
- a separate Neon branch;
- its own secrets;
- a Vercel environment pointing at it.

## Database migrations

Each service runs its pending TypeORM migrations on boot, inside `DataSource.initialize()` and before it listens, so a health check only passes once the schema is current. `synchronize` is off and can't be switched back on: `DB_SYNC` is ignored with a warning. Migrations live in `api/services/<svc>/src/migrations/`; the README's "Changing the schema" section has the developer workflow.

- **Baselines.** The first migration of each service is the schema `synchronize` used to build. On a database that already has those tables (production) it records itself and runs no DDL. On an empty one it creates everything. On a half-built schema it fails the boot and lists the missing tables.
- **One migrator per service.** There is no migration lock, because each free-plan service runs one instance. Add one (`pg_advisory_xact_lock`; session locks don't survive Neon's pooler) before running a service on more than one instance.
- **Logs.** Each executed migration prints `Migration <Name> has been executed successfully`.
- **Drift check.** `pnpm -C api db:check` compares a database with the compiled entities and exits 1 on any difference. It is read-only (no migrations, no `synchronize`, no extension installs), so it's safe against production: `DATABASE_URL='<url>' pnpm -C api db:check`.

### First rollout: from `synchronize` to migrations

In this order. Steps 1, 2, 4 and 5 touch Neon or Render and are for the owner to run.

1. **Before merging, rehearse on a copy of production.** `db:check` can't run against production directly yet: the branch's entities already include the `IndexTuning` index changes, so it would list those 13 statements (7 `DROP INDEX`, 6 `CREATE INDEX`) as drift. Instead, create a Neon branch from the production branch at the current point in time, copy its connection string, and run the migrations there from the feature branch:
   ```bash
   REHEARSAL='<rehearsal branch connection string>'
   pnpm -C api build
   for s in auth course enrollment financial notification outcomes quality; do
     DATABASE_URL="$REHEARSAL" pnpm -C api/services/$s migration:run || break
   done
   DATABASE_URL="$REHEARSAL" pnpm -C api db:check
   ```
   Expect `Migration Baseline… has been executed successfully` and `Migration IndexTuning… has been executed successfully` for each service, then "No drift". Anything else means production differs from the entities. Stop and add a corrective migration first, because the baseline would otherwise record a schema it doesn't match. Delete the rehearsal branch afterwards.
2. **Branch the Neon database** right before merging (Neon console → Branches → new branch from the production branch at the current point in time). That branch is the rollback point for data.
3. **Merge.** Render redeploys every service. On boot each one records its baseline (no DDL) and runs its `IndexTuning` migration (`CREATE`/`DROP INDEX CONCURRENTLY`, which blocks no writes). Each service log shows `Migration Baseline… has been executed successfully` and `Migration IndexTuning… has been executed successfully`.
4. **After the deploy:**
   - `DATABASE_URL='<production url>' pnpm -C api db:check` → "No drift".
   - `SELECT name FROM "<schema>"."migrations"` → a `Baseline…` and an `IndexTuning…` row in each of the 7 schemas.
   - `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid` → no rows.
5. If `DB_SYNC` still shows in the `ethiopialearn-shared` env group or in any service's environment (a Blueprint sync can leave a removed key behind), delete it. It's ignored, with a warning at boot.

**Rolling back:** revert the merge and redeploy. The previous code synchronizes again, which only undoes the index changes; the `migrations` tables stay behind, unused. Restore from the Neon branch only if data itself went wrong. **Before deploying the migrations again**, delete the `IndexTuning` rows (`DELETE FROM "<schema>"."migrations" WHERE name LIKE 'IndexTuning%'` in each of the 7 schemas). Otherwise they still read as done, nothing reruns, and production keeps the old indexes. The baselines stay recorded, which is correct, since every table is still there.

### Phase 6c: money integrity checks and rollback

Every part is for the owner to run against production (the Neon SQL editor, or `psql '<production url>'`). Production is off-limits to development sessions.

**Before merging: read-only checks.** Every statement only selects. They use only columns that exist before 6c, so they run against production as it is now. Nothing acts on the results: each list is for you to decide on.

```sql
-- 1. Refunded purchases that kept their cashback or referral reward (history).
--    A referral reward belongs to the purchase whose confirmation granted it.
SELECT p.id AS payment_id, p.learner_id, p.course_title, p.amount_etb,
       t.kind, t.user_id AS credited_to, t.amount_etb AS credit_etb, t.created_at AS credited_at
FROM financial.payments p
JOIN financial.wallet_transactions t ON t.kind = 'cashback' AND t.reference = p.id::text
WHERE p.status = 'refunded'
UNION ALL
SELECT p.id, p.learner_id, p.course_title, p.amount_etb, t.kind, t.user_id, t.amount_etb, t.created_at
FROM financial.payments p
JOIN financial.referrals r ON r.referred_user_id = p.learner_id AND r.status = 'rewarded'
JOIN financial.wallet_transactions t ON t.kind = 'referral_reward' AND t.reference = r.id::text
WHERE p.status = 'refunded'
  AND r.rewarded_at BETWEEN p.webhook_received_at - interval '1 minute' AND p.webhook_received_at + interval '1 minute'
ORDER BY credited_at;

-- 2. Payments with a pending refund that are already in a payout (support cases).
SELECT r.id AS refund_request_id, r.created_at AS requested_at, p.id AS payment_id, p.payout_id, p.amount_etb
FROM financial.refund_requests r
JOIN financial.payments p ON p.id = r.payment_id
WHERE r.status = 'pending' AND p.payout_id IS NOT NULL
ORDER BY r.created_at;

-- 3. Pending refunds: the payments the migration marks with refund_requested_at.
SELECT count(*) AS pending_refunds FROM financial.refund_requests WHERE status = 'pending';

-- 4. (A1) Chapa course payments still pending after 48 h whose learner has the course.
--    Each may be a confirmation the abandoned-checkout reminder reverted. The
--    likeliest have nudged_at set and no other confirmed payment for the course.
SELECT p.id AS payment_id, p.chapa_tx_ref, p.learner_id, p.course_id, p.amount_etb, p.created_at, p.nudged_at,
       EXISTS (SELECT 1 FROM financial.payments q
               WHERE q.learner_id = p.learner_id AND q.course_id = p.course_id AND q.status = 'confirmed') AS has_confirmed_payment
FROM financial.payments p
JOIN enrollment.enrollments e ON e.learner_id = p.learner_id AND e.course_id = p.course_id
WHERE p.method = 'chapa' AND p.purpose = 'course' AND p.status = 'pending'
  AND p.created_at < now() - interval '48 hours'
  AND e.entitlement_status = 'active'
ORDER BY p.created_at;

-- 5. (A1) Coupons whose uses exceed their confirmed payments. An inflated count
--    closes a coupon early; correcting uses is your call. A refunded purchase
--    also leaves uses above the confirmed count, since uses never goes down:
--    uses up to confirmed + refunded is most likely right, and only what is
--    above that is a use counted twice.
SELECT c.code, c.uses, c.max_uses,
       count(p.id) FILTER (WHERE p.status = 'confirmed') AS confirmed_payments,
       count(p.id) FILTER (WHERE p.status = 'refunded') AS refunded_payments
FROM financial.coupons c
LEFT JOIN financial.payments p ON p.coupon_code = c.code AND p.status IN ('confirmed', 'refunded')
GROUP BY c.id, c.code, c.uses, c.max_uses
HAVING c.uses > count(p.id) FILTER (WHERE p.status = 'confirmed')
ORDER BY c.code;
```

**After every 6c deploy: the refund-mark check.** Read-only. A confirmed payment carries `refund_requested_at` exactly while a refund for it is pending; both counts should be 0. A stale mark (a confirmed payment marked with no pending refund) is skipped by payouts and the credit release, so the educator is never paid for that sale. A missing mark (a pending refund whose payment isn't marked) lets a payout claim the payment while the refund is under review. Both come from the previous code filing or deciding refunds: during a rollback, or, rarely, in the minutes of a deploy while the old instance still serves. If either count isn't 0, run the re-sync under "Redeploying 6c after a rollback" while no one is deciding refunds in the admin, then this check again.

```sql
-- Refund marks: both should be 0. Refunded payments keep their mark by design.
SELECT
  (SELECT count(*) FROM financial.payments p
    WHERE p.refund_requested_at IS NOT NULL AND p.status = 'confirmed'
      AND NOT EXISTS (SELECT 1 FROM financial.refund_requests r WHERE r.payment_id = p.id AND r.status = 'pending')) AS stale_marks,
  (SELECT count(*) FROM financial.refund_requests r JOIN financial.payments p ON p.id = r.payment_id
    WHERE r.status = 'pending' AND p.refund_requested_at IS NULL) AS missing_marks;
```

**Rolling back:** revert the code and keep the columns; the previous code ignores them. **Before reverting**, release every pending credit into its owner's balance, because the previous code reads only `balance_etb` and the learners would lose them. That includes credits whose purchase has a refund under review, which the previous code never held back either. The transaction is safe while 6c is serving: the app releases a credit only from `pending`, under the same row lock, so each credit moves once. Run the preview, then the transaction, then revert. Once the revert is live, run both again to catch credits earned in between. A second run releases only what is still pending.

```sql
-- Preview: what the release moves.
SELECT count(*) AS pending_credits, count(DISTINCT user_id) AS owners, COALESCE(sum(amount_etb), 0) AS total_etb
FROM financial.wallet_transactions WHERE state = 'pending';

BEGIN;
WITH released AS (
  UPDATE financial.wallet_transactions SET state = 'available'
  WHERE state = 'pending'
  RETURNING user_id, amount_etb
), totals AS (
  SELECT user_id, sum(amount_etb) AS amount_etb FROM released GROUP BY user_id
)
INSERT INTO financial.wallets AS w (user_id, balance_etb)
SELECT user_id, amount_etb FROM totals
ON CONFLICT (user_id) DO UPDATE SET balance_etb = w.balance_etb + EXCLUDED.balance_etb, updated_at = now();
COMMIT;
```

`INSERT 0 <n>` is the number of wallets credited, and the preview then shows no pending credits. If the transaction fails, run it again: it is all-or-nothing, so a failed run moved nothing.

**Redeploying 6c after a rollback:** the previous code files and decides refunds without touching `refund_requested_at`, and the migration's backfill doesn't run again, so the marks drift. A refund denied during the rollback keeps its mark, and payouts never pay that sale out. A refund filed during it has none, and a payout can claim the payment while the refund is under review. Right before redeploying, while the old code still serves, re-sync the marks; once the deploy is live, run the refund-mark check. Run the re-sync while no one is deciding refunds in the admin: each UPDATE reads the refund requests as they were when it started, so a refund denied while it runs can come out marked again. With 6c serving, an admin decision is the only thing that can race it, so a rerun after the deploy is safe under the same rule.

```sql
-- Re-sync the refund marks: clear the stale ones, then set the missing ones.
BEGIN;
UPDATE financial.payments p SET refund_requested_at = NULL
WHERE p.refund_requested_at IS NOT NULL AND p.status = 'confirmed'
  AND NOT EXISTS (SELECT 1 FROM financial.refund_requests r WHERE r.payment_id = p.id AND r.status = 'pending');
UPDATE financial.payments p SET refund_requested_at = r.created_at
FROM financial.refund_requests r
WHERE r.payment_id = p.id AND r.status = 'pending' AND p.refund_requested_at IS NULL;
COMMIT;
```

The two `UPDATE <n>` counts are the stale marks cleared and the missing marks set; the check then shows 0 and 0.

### Phase 6d: past wrong revocations (any time; blocks nothing)

Read-only, for the owner, against production. Before 6d, refunding one purchase of a course revoked access even when the learner still held it another way: a second confirmed purchase of it, or a granted gift, pay request or bulk seat. 6d stops this but doesn't touch past rows. Each row below is a learner who lost access that way; re-granting it is your call. The result doesn't affect the 6d merge.

```sql
-- Learners whose course access is refunded while they still hold the course another way.
SELECT e.learner_id, e.course_id, e.enrolled_at,
       (SELECT count(*) FROM financial.payments p
         WHERE p.learner_id = e.learner_id AND p.course_id = e.course_id
           AND p.purpose = 'course' AND p.status = 'confirmed') AS confirmed_purchases,
       (SELECT count(*) FROM financial.sponsorships s
         WHERE s.recipient_user_id = e.learner_id AND s.course_id = e.course_id
           AND s.status = 'granted') AS granted_sponsorships
FROM enrollment.enrollments e
WHERE e.entitlement_status = 'refunded'
  AND (EXISTS (SELECT 1 FROM financial.payments p
               WHERE p.learner_id = e.learner_id AND p.course_id = e.course_id
                 AND p.purpose = 'course' AND p.status = 'confirmed')
       OR EXISTS (SELECT 1 FROM financial.sponsorships s
                  WHERE s.recipient_user_id = e.learner_id AND s.course_id = e.course_id
                    AND s.status = 'granted'))
ORDER BY e.enrolled_at;
```


## Images and self-hosting

- **`api/Dockerfile`** builds any one service from the `api/` context with `--build-arg PKG=@ethiopialearn/<name>`, which is what Render does for each service:
  - dependencies are fetched from the lockfile before sources are copied, so a code change doesn't reinstall them;
  - the runtime image holds only a pruned production `pnpm deploy` (`dist`, production `node_modules`, `package.json`);
  - the base is pinned by digest, and Dependabot bumps it.
- **`web/Dockerfile`** builds the Next.js standalone server, for self-hosting only; production web is on Vercel.
- **`docker compose --profile full up --build -d`** runs every container and the infrastructure on one host.

Nothing publishes images: Render builds from the repo.

## Scaling notes

- Services are stateless and can scale horizontally behind the gateway. Before running more than one instance of a service:
  - add a migration lock;
  - make sure only one instance runs the crons;
  - move the gateway's rate limiter to a shared store.
- Lesson videos are short-lived signed URLs, so a CDN in front of object storage caches renditions without exposing raw keys.
