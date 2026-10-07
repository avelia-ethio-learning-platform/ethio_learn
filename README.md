# EthiopiaLearn

Educator-first online learning marketplace for Ethiopia — **MVP implementation** of the EthiopiaLearn build specification (v3): 7 NestJS microservices behind a single NestJS API gateway, a Next.js 14 frontend (with **English + Amharic** UI), PostgreSQL (schema-per-service), RabbitMQ, Redis and S3-compatible object storage.

## Architecture

```
Browser ──► Next.js web (SSR/ISR public pages, CSR dashboards, en/am i18n)
                │  REST /api/v1
                ▼
        API Gateway (NestJS)  ← the ONLY public entry point
   JWT verify · role headers · rate limit · helmet · route table
                │ proxies (public service URLs + internal token)
   ┌────────┬───┴────┬──────────┬──────────┬──────────┬─────────┬─────────────┐
   ▼        ▼        ▼          ▼          ▼          ▼         ▼
 Auth &   Course & Enrollment Learning  Financial  Quality & Notification
 Identity Content  & Progress Outcomes  (Chapa)    Trust     (email only)
   │        │        │          │          │          │         │
   └────────┴────────┴──── RabbitMQ fanout `ethiopialearn.events` ────┘
             (cross-service writes = events; reads = REST via gateway)
        PostgreSQL 15 — one instance, one schema per service
        Redis (refresh-token allowlist) · MinIO/S3 (video, certs, thumbnails)
```

| Service | Port | Owns |
|---|---|---|
| gateway | 4000 | routing, authn, rate limiting |
| auth | 4101 | users, verifications, resets, educator/institution profiles, audit log |
| course | 4102 | courses, sections, lessons, search, signed stream URLs |
| enrollment | 4103 | enrollments (entitlements), lesson progress |
| outcomes | 4104 | assessments (quiz / AI viva / project), certificates + public verify |
| financial | 4105 | Chapa payments, HMAC webhook, refunds, payouts (80/20) |
| quality | 4106 | QO queue, ratings/reviews, trust tiers, fraud flags |
| notification | 4107 | transactional email (Resend or dev console) |

## Features

- **Identity & access** — email/password signup with verification link, JWT + rotating-refresh-cookie login (Redis allowlist), password reset, strong-password enforcement, 5 roles (learner, educator, institution admin, quality officer, platform admin), institution instructor invitations that the user accepts (an institution admin can suspend or remove a membership, never the account), admin user management.
- **Courses & content** — draft → institution review → QO review → published lifecycle; sections/lessons; presigned video upload; signed, entitlement-gated streaming URLs; freemium free-preview sections; AI course-outline generation (Groq) with human review before applying; course cloning; catalog search/sort/categories; public educator profiles.
- **Enrollment & learning** — instant free/freemium enrollment; paid enrollment gated on a confirmed payment; per-lesson completion; **video watch-percentage tracking with resume-where-you-left-off** (high-water mark, ≥90% auto-completes); course progress; certificates on completion.
- **Payments (Chapa)** — initiate → hosted checkout → HMAC-verified webhook → server-side re-verify with amount/currency tamper checks → idempotent confirm → entitlement; browser-triggered reconcile plus a background sweep for missed webhooks (it runs while the financial service is awake); mock gateway for offline dev; manual bank-transfer fallback; admin payment ledger.
- **Refunds & payouts** — rule-based refund decisions (auto-approve/manual-review/deny), 80/20 revenue split, 7/14-day settlement holds, KYC and fraud holds, payout runs and releases, educator balance view.
- **Assessments & outcomes** — quizzes/assessments with attempts and scoring, tamper-evident HMAC-signed certificates with a public verification page, webcam proctoring assets.
- **Quality & trust** — purchase-gated reviews with rating aggregates, QA review queue, fraud flags wired to payout holds, appeals flow.
- **Community & notifications** — rate-limited community posts/replies, in-app notifications, transactional email (SMTP/Resend/console) for receipts, enrollment and verification.
- **Platform engineering** — single public API gateway with JWT auth, risk-bucketed per-route rate limiting, header-spoofing protection, internal-token service mesh; event-driven microservices over RabbitMQ; schema-per-service Postgres; English/Amharic i18n; unit + e2e test suites; GitHub Actions CI gating every merge and Render deploy; fully Dockerized.

## Quick start (local dev)

Requirements: Node 22 (see `.nvmrc`), pnpm 9 (`corepack enable`), Docker.

The repo is split into two independent workspaces: [api/](api/) (gateway + 7 services, pnpm workspace) and [web/](web/) (standalone Next.js app).

```bash
cp api/.env.example api/.env

# 1. infrastructure
docker compose up -d postgres redis rabbitmq minio minio-init
# Existing clone? If `minio` exits with "file access denied", its volume was
# created by the old root image. Fix it once (keeps your files):
#   docker run --rm -v ethiopialearn_miniodata:/data alpine chown -R 65532:65532 /data

# 2. install + build
pnpm -C api install && pnpm -C api build
pnpm -C web install

# 3. seed demo accounts (one per role, password Password123!)
pnpm -C api seed

# 4. run the backend (gateway + 7 services, hot reload) and the web
pnpm -C api dev
pnpm -C web dev
```

> **Low-RAM machines:** `pnpm -C api dev` runs 8 ts-node processes that type-check
> in memory and can exhaust a machine with little free RAM. If it gets OOM-killed,
> use the compiled build instead — far lighter:
> ```bash
> pnpm -C api build                 # compile all services to dist/
> bash scripts/start-backend.sh     # runs the 8 services + gateway from dist (detached)
> bash scripts/start-web.sh         # next dev, detached (prod build uses `output: standalone`)
> # stop later with: bash scripts/stop-backend.sh / scripts/stop-web.sh
> ```

Open http://localhost:3000. Toggle **English / አማርኛ** from the header. Optionally run the end-to-end demo flow (educator → QO approval → learner enrollment):

```bash
node scripts/demo-seed.mjs
```

## Testing

| Layer | What it covers | Command |
|---|---|---|
| Backend unit (jest) | payment webhook HMAC + idempotency, refund rules, 80/20 payout + holds, video progress + auto-complete, certificate tamper check, review eligibility, gateway route table + rate-limit buckets, auth guards | `pnpm -C api test` |
| Frontend unit/component (vitest) | i18n en/am key parity, `api()` error/refresh handling, `<PasswordStrength />` | `pnpm -C web test` |
| End-to-end (against a running stack) | full business flow: educator → QO approval → publish → enroll → complete → certificate | `node scripts/demo-seed.mjs` |
| E2E smoke assertions | security envelope (401/403/404, header spoofing, internal token), video watch-progress flow, optional brute-force 429 | `node scripts/e2e-smoke.mjs` (add `E2E_CHECK_RATE_LIMIT=1` to include the 429 check — throttles your IP for ~1 min) |
| Lint | ESLint (`typescript-eslint` in api, `next/core-web-vitals` in web); fails only when a rule's count rises above `.github/lint-baseline.json` | `pnpm -C api build && node scripts/lint-check.mjs` (api's package types come from its build) |
| Schema drift | every entity matches the database, i.e. no entity change shipped without its migration (read-only) | `pnpm -C api db:check` |

Watch mode while developing: `pnpm -C api test -- --watch` / `pnpm -C web exec vitest`.
CI runs all of these on every push/PR (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

### Fully containerized

```bash
docker compose --profile full up --build
```

Images are slim by design: `node:22-alpine` multi-stage builds; backend images carry only a pruned production `pnpm deploy` of one service, the web image carries only the Next.js standalone output. No heavyweight sidecars.

### Demo accounts (after `pnpm -C api seed`)

| Role | Email |
|---|---|
| Platform admin | admin@ethiopialearn.et |
| Quality officer | qo@ethiopialearn.et |
| Educator | educator@ethiopialearn.et |
| Learner | learner@ethiopialearn.et |
| Institution admin | institution@ethiopialearn.et |

Password for all: `Password123!` (override with `SEED_PASSWORD`).

## Changing the schema

Each service owns its tables through versioned TypeORM migrations in `api/services/<svc>/src/migrations/`, and runs any pending ones on boot, before it starts listening. `synchronize` is off everywhere; `DB_SYNC` is ignored. The seed runs the auth migrations too, so a fresh database needs nothing extra.

1. Change the entity.
2. With your local database up to date (boot the services once, or `pnpm -C api/services/<svc> migration:run`) and `pnpm -C api build` done, generate the migration:
   ```bash
   pnpm -C api/services/<svc> migration:generate src/migrations/<Name>
   ```
3. Read the SQL. Write these by hand instead:
   - **Enum values:** TypeORM renames the type and recreates it, which breaks the enum types two tables share (`financial.owner_type`, `quality.owner_type`, `outcomes.trust_tier`). Use `ALTER TYPE "<schema>"."<type>" ADD VALUE '<value>'`. The contracts enums are mirrored in several schemas (`owner_type`, `trust_tier`, `pricing_type`), so a new value needs a migration in each service that uses it.
   - **Renames:** generated as drop + add, which loses the data. Use `ALTER TABLE … RENAME COLUMN`.
   - **Indexes on tables with data:** `CREATE INDEX CONCURRENTLY` with `transaction = false`, one statement per `queryRunner.query()`, each preceded by `DROP INDEX CONCURRENTLY IF EXISTS` (see the `IndexTuning` migrations).
4. Add the class to the service's `src/migrations/index.ts`. The list is explicit, not a glob, so dev (ts-node) and production (`dist/`) load the same classes.
5. `pnpm -C api db:check` must say "No drift". CI runs it after the services boot.

Other commands, from `api/services/<svc>`: `pnpm migration:show`, `pnpm migration:run` and `pnpm migration:revert`. Revert undoes the latest migration and runs with `-t none`, because a `CONCURRENTLY` statement can't run inside the transaction TypeORM otherwise wraps it in. The baselines (the first migration of each service) refuse to revert unless `ALLOW_BASELINE_REVERT=1` is set: reverting one drops every table in the schema, so only do that against a disposable local database.

## Amharic (አማርኛ) support

The UI chrome (navigation, auth, catalog hero, learner-facing labels) ships in both English and Amharic, toggled from the header and persisted in `localStorage`. Strings live in [web/src/lib/i18n.tsx](web/src/lib/i18n.tsx) — add keys to both `en` and `am` dictionaries. Course content itself stays in the language the educator authored it in. The spec lists a full Amharic UI as post-MVP, so this is a lightweight starter layer rather than 100% coverage; extend the dictionaries to localize more surfaces.

## Mock-first external providers

Everything runs with **zero external credentials**; real providers switch on automatically when keys are set in `.env`:

| Provider | Without credentials | With credentials |
|---|---|---|
| **Chapa** | `CHAPA_MODE=mock` → local checkout page at `/dev/checkout` that fires a genuinely **HMAC-signed** webhook, exercising the full §6 verify path | `CHAPA_MODE=live` + `CHAPA_SECRET_KEY` |
| **Email (Resend)** | Console provider — emails (incl. the signup verification link) are printed in the notification service logs | `RESEND_API_KEY` |
| **Groq AI (viva grading, quiz/structure generation, plagiarism)** | Deterministic mock assessor | `GROQ_API_KEY` |
| **S3** | MinIO from docker-compose | unset `S3_ENDPOINT`, set AWS creds |

## Spec compliance highlights

- **Auth**: email + password only, verification **link** (no OTP), JWT access 15 min + refresh 7 days in an `httpOnly` cookie (rotated, Redis-allowlisted). Exactly 5 roles. No SMS anywhere.
- **Payments**: Chapa initialize → redirect → webhook with **HMAC-SHA256 verified on the raw body** (timing-safe) → server-side verify → `PaymentConfirmed`. `tx_ref` idempotency (duplicate webhooks are no-ops). Webhook always returns 200. A background sweep (`@Cron('*/2 * * * *')` in financial-service) re-verifies any payment still pending after a minute. It runs only while the service is awake, since a sleeping free Render instance runs no cron (docs/DEPLOYMENT.md, "Cold starts and waking").
- **Entitlement**: granted **only** by the Enrollment & Progress service, **only** from a verified `PaymentConfirmed` event (or direct enrollment for free courses).
- **Content protection**: raw S3 keys never leave the backend; playback uses signed, 15-minute URLs issued after a server-side entitlement check. Freemium preview sections are the only exception.
- **Revenue split**: 80/20 computed at payout time; 7-day settlement hold (14 days for `new`-tier educators), fraud-flag holds, pending-refund holds, `KYC_PAYOUT_THRESHOLD_ETB` gate; nightly cron + admin-triggered `POST /payouts/run`.
- **Refund rules (§10.4)**: auto-approve <20% within 7d · manual review 20–50% · deny on certificate/assessment/>7d.
- **Certificates**: PDF (pdfkit) + QR to `/verify/{uid}`, HMAC-signed `certificate_uid`, trust-tier snapshot, public tamper-checking verify endpoint.
- **Events**: exact spec registry on a fanout exchange with the spec envelope (`event_id`, `timestamp`, `producer_service`, `correlation_id`); commands on a direct exchange.
- **SEO**: SSR/ISR public catalog + course pages, per-course `generateMetadata`, schema.org `Course` JSON-LD with `AggregateRating`/`Offer`, `sitemap.xml` from published courses, `robots.txt` excluding app surfaces.

### Deliberate deviations / spec gaps (flagged in code as `TODO(spec-open-question)`)

- `PasswordResetRequested` event added: reset requires email, and only Notification may send email, but the spec's event registry has no reset event.
- Quality & Trust also subscribes to `RefundApproved`: refund-rate trust math (§10.5) and refund-abuse detection (§10.6) are unimplementable without it.
- `course_categories` is an enum column (the §7.2 payload fixes the category set), not a lookup table.
- Video transcoding is stubbed behind the `StorageProvider` interface (spec §14 open question): educators upload MP4/HLS directly via signed PUT URLs; swap in Mux/Bunny/ffmpeg later without touching services.
- Disbursement marks payouts paid and emits events; wire the Chapa split-payout call when sub-merchant availability is confirmed (§14).

## Repository layout

```
api/                  backend pnpm workspace (own lockfile + Dockerfile)
  gateway/            NestJS API gateway (route table in src/routes.ts)
  services/
    auth/ course/ enrollment/ outcomes/ financial/ quality/ notification/
  packages/
    contracts/        enums + event registry + payload types
    common/           event bus (RabbitMQ), guards, TypeORM helper, bootstrap
    storage/          S3/MinIO signed-URL provider (VideoStorageProvider)
    ai/               Groq LLM assessor (AI viva, plagiarism, generation) + offline mock
web/                  standalone Next.js 14 App Router frontend (own lockfile + Dockerfile)
docker/               postgres schema init (used by docker-compose)
scripts/demo-seed.mjs end-to-end API smoke/demo flow
```

## Testing the payment flow locally

1. Log in as the educator, create a **paid** course, submit it; approve as the QO.
2. Log in as the learner, open the course, click **Buy with Chapa** → you land on `/dev/checkout` (mock Chapa).
3. Click **Pay (simulate success)** → a signed webhook hits the Financial service → HMAC verified → `PaymentConfirmed` → entitlement granted → the return page's poll unlocks the course.

## Deployment

Production is eight Render services plus the web on Vercel: see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Changes reach `main` only through a pull request with green checks, and Render deploys after the checks pass.

## Environment variables

See [api/.env.example](api/.env.example) and [web/.env.example](web/.env.example). Set `JWT_SECRET`, `CERT_SIGNING_SECRET`, `INTERNAL_API_TOKEN` and `CHAPA_WEBHOOK_SECRET` to strong random values before any non-local deployment. In production (`NODE_ENV=production`) every service and the gateway refuse to boot when one they need is missing, shorter than 32 characters or a value from the repo, when `REQUIRE_INTERNAL_TOKEN` is turned off, or when `WEB_URL` or `GATEWAY_PUBLIC_URL` point at localhost. The log names each variable, never its value.
