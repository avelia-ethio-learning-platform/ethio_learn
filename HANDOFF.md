# EthiopiaLearn — deployment handoff

Context for a fresh session picking up this repo, written after getting the app
from "just code" to "live in production" on Render + Vercel. Written 2026-08-01.

**No credentials in this file, anywhere.** Every real value lives in
`.env.production.local` at the repo root (gitignored, never committed, exists
only on this machine). Read that file directly for actual secrets — this doc
only ever names variables, never values.

---

## 1. What this project is

**EthiopiaLearn** — an educator-first LMS for Ethiopia. Monorepo, two
independently-deployed halves that share nothing but this git repo:

- **`api/`** — pnpm/Turborepo workspace, package manager `pnpm@9.4.0`, Node
  `>=20`. One API gateway (`api/gateway`) + 7 NestJS microservices
  (`api/services/{auth,course,enrollment,outcomes,financial,quality,notification}`),
  plus shared packages under `api/packages/` (`common`, `contracts`, `ai`,
  `storage`). Schema-per-service on a single Postgres instance — each service
  owns exactly one Postgres schema and never queries another's tables directly.
  RabbitMQ event bus for cross-service async events (e.g. `PaymentConfirmed`).
- **`web/`** — standalone Next.js 14 App Router frontend. **Not** part of the
  api pnpm workspace — its own `package.json` and `pnpm-lock.yaml`, one level
  up from `api/`. Route groups: `(public)`, `(account)`, `(admin)`, `(learn)`,
  `(teach)`, `(verify)` under `web/src/app/`.

### Architectural rules enforced in code, not just documented

- **The gateway is the only entry point for client traffic.** Services are
  never meant to be called directly by a browser. (This assumption turned out
  to be false on Render's free plan — see §6.5, it's the most important bug
  found in this whole deployment.)
- Services never touch each other's schema. Cross-service reads go over HTTP
  through the gateway, or service→service directly, always carrying
  `x-internal-token` (`api/packages/common/src/auth/internal.guard.ts`).
- Raw S3/R2 keys and URLs never reach the client — only short-lived signed
  URLs (`api/packages/storage/src/index.ts`, 900s default expiry).
- `tx_ref` for payments is always server-generated, never client-supplied
  (`api/services/financial/src/chapa.provider.ts`).

### Request flow, gateway to service (the part that broke most often)

`api/gateway/src/main.ts` is a single Express-style middleware, not per-route
NestJS controllers:

1. Every request under `/api/v1` is matched against `ROUTES` in
   `api/gateway/src/routes.ts` — an ordered array of `{ pattern, target, auth }`,
   first match wins. `target` is a thunk like `() => withScheme(env('AUTH_SERVICE_URL', 'localhost:4101'))`.
2. `auth` is `'public' | 'jwt' | 'internal'`, or a function of `(method, path)`
   for routes that are public on GET but require a JWT to write (e.g. course
   reviews, comments).
3. Client-presented `x-user-*` / `x-internal-token` headers are stripped
   ([main.ts:163-167](api/gateway/src/main.ts#L163)) before anything else runs,
   so a client can never forge identity by just setting a header.
4. If `mode === 'jwt'`, the gateway verifies the bearer token itself and sets
   `x-user-id` / `x-user-role` / `x-user-email` from the verified claims.
5. **The gateway always attaches its own `INTERNAL_API_TOKEN` as
   `x-internal-token`** on every proxied request now (added in `0d4bf1a`, see
   §6.5) — not just on `mode === 'internal'` routes.
6. The request is proxied via `http-proxy-middleware`. There are **two** proxy
   instances now, one per protocol (`makeProxy(keepAliveAgent)` for `http://`,
   `makeProxy(keepAliveHttpsAgent)` for `https://`), dispatched by the scheme of
   the resolved target — see §6.6 for why.
7. On the receiving service, `bootstrapService()`
   (`api/packages/common/src/bootstrap.ts`) optionally installs a
   pre-controller middleware that rejects anything without a valid
   `x-internal-token`, when `REQUIRE_INTERNAL_TOKEN=true`. `/health` is always
   exempt (Render's health check hits it with no headers).

### S3/R2 upload-download flow

Nothing binary passes through NestJS. `api/services/course/src/course.controller.ts`:
- `POST /uploads` ([course.controller.ts:294](api/services/course/src/course.controller.ts#L294)) —
  backend builds a key `{kind}s/{educatorId}/{uuid}-{filename}`, asks R2 for a
  signed PUT URL (15 min), returns `{ upload_url, key }`. **The browser PUTs
  directly to R2** — the server never sees file bytes.
- Frontend then saves that `key` as a plain string column on the lesson row
  (`video_s3_key`) — metadata lives in Postgres, bytes live in R2.
- `GET /lessons/:id/stream-url` ([course.controller.ts:306](api/services/course/src/course.controller.ts#L306)) —
  checks JWT + entitlement (calls enrollment-service internally unless the
  requester owns the course or it's a free-preview section), only then returns
  a signed GET URL.
- Two S3 clients exist (`api/packages/storage/src/index.ts`): one against
  `S3_ENDPOINT` (used to sign), one against `S3_PUBLIC_ENDPOINT` (what the
  signature is valid against from a browser). In production both point at the
  same R2 URL — the split only matters for local MinIO, where the in-Docker
  hostname isn't browser-reachable.

### Chapa payment flow

`api/services/financial/src/chapa.provider.ts` — two implementations behind
one `ChapaProvider` interface, selected by `chapaMode()`:
- `LiveChapaProvider` — wraps the real `chapa-nestjs` SDK, calls `api.chapa.co`.
  Selected whenever `CHAPA_MODE=live` (or unset with a `CHAPA_SECRET_KEY`
  present). **Works identically with a test key (`CHASECK_TEST-…`) or a real
  one** — Chapa's API itself doesn't distinguish, so `CHAPA_MODE=live` +
  test key = real Chapa hosted checkout, real test cards, no real money.
- `MockChapaProvider` — fully offline fake, only selected when
  `CHAPA_MODE=mock`. No Chapa account involved at all.
- Webhook verification: `payment.service.ts` `verifyHmac()`
  ([payment.service.ts:356](api/services/financial/src/payment.service.ts#L356))
  computes `HMAC-SHA256(rawBody, CHAPA_WEBHOOK_SECRET)` and compares to the
  signature header Chapa sends. **This must be the dashboard's "secret hash"
  from Settings → Webhooks, not the `CHAPUBK_…` public key** — using the public
  key makes every webhook fail silently (checkout succeeds, payment never
  flips to confirmed).

---

## 2. Where it is deployed

| Piece | Platform | Notes |
|---|---|---|
| `web/` | **Vercel** | Root Directory = `web`. Framework preset pinned by `web/vercel.json`. Production `https://ethio-learn.vercel.app`, tracks `main`. |
| `api/` (all 8) | **Render** | Blueprint from `render.yaml`, free plan, region `ohio`. Gateway at `https://ethiopialearn-gateway.onrender.com`, each service also has its own public `https://ethiopialearn-<name>.onrender.com`. |
| Postgres | **Neon** | Pooled host (`…-pooler…`), `sslmode=require` → auto-detected by `api/packages/common/src/typeorm/typeorm.ts` (regex on the connection string, `DB_SSL` overrides). Region us-east-2 — why Render is pinned to `ohio`. |
| Redis | **Upstash** | `rediss://` wire protocol via ioredis. The REST API token shown by default in the Upstash console is a **different, incompatible** credential — the wire password is under the "Connect"/`redis-cli --tls` section. |
| RabbitMQ | **CloudAMQP** | `amqps://user:pass@host/vhost` — vhost equals the username on CloudAMQP's free tier. |
| Object storage | **Cloudflare R2** | S3-compatible, `forcePathStyle: true`. Bucket `ethio-learn`. |
| Email | **Brevo SMTP** | Port 587, STARTTLS (`SMTP_SECURE=false`). `SMTP_HOST` being set is literally what makes `api/services/notification/src/email.provider.ts` select SMTP over Resend — Resend is now dead code, key unused. `EMAIL_FROM` must be a Brevo-**verified** sender or every send is rejected. |
| AI | **Groq** | `llama-3.3-70b-versatile`. `api/packages/ai/src/index.ts` `groqConfigured()` requires the key to literally start with `gsk_`; anything else (including empty) silently falls back to `MockAiAssessor` — deterministic fake grading, no error, no warning. |
| Payments | **Chapa** | Test secret key, real Chapa API (see §1 Chapa flow above). |

Both halves deploy from the **same GitHub repo**
(`avelia-ethio-learning-platform/ethio_learn`), split by root directory —
`render.yaml` at repo root points Docker builds at `./api`, Vercel's Root
Directory is `web`. No repo split is needed for this to work. (Splitting into
two separate GitHub repos was discussed early on as a *possible future* step,
never executed, not currently planned.)

---

## 3. Deployment mechanics — how to actually operate this

### Render

**Always use New → Blueprint, never "New → Web Service".** The Blueprint reads
`render.yaml` at repo root and creates all 8 services in one pass with the
correct Dockerfile/context already wired. A manual Web Service asks you for
Root Directory + Dockerfile path by hand and only ever creates one service —
this was tried once and failed (`Dockerfile: no such file or directory`,
because there's no Dockerfile at repo root, only `api/Dockerfile` and
`web/Dockerfile`).

- All 8 services build from `api/Dockerfile` with `dockerContext: ./api`. The
  `PKG` build arg (e.g. `@ethiopialearn/auth-service`) selects which workspace
  package gets built and shipped — same Dockerfile for all 8, different `PKG`.
  Render exposes a service's env vars as Docker build args automatically,
  which is how `ARG PKG` receives it with zero extra Render-specific config.
- Config lives in one shared env group, `ethiopialearn-shared`, referenced by
  all 8 services via `fromGroup`. Change a value once, it applies everywhere.
  Full list of keys (names only, see `.env.production.local` for values):

  **`sync: false`** (Render prompts once at Blueprint creation, or edit later
  in the group):
  `DATABASE_URL`, `REDIS_URL`, `RABBITMQ_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
  `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, `SMTP_USER`, `SMTP_PASS`,
  `EMAIL_FROM`, `PLATFORM_ADMIN_EMAIL`, `CHAPA_SECRET_KEY`,
  `CHAPA_WEBHOOK_SECRET`, `GROQ_API_KEY`, `GOOGLE_CLIENT_ID`, `WEB_URL`,
  `CORS_ORIGINS`, `GATEWAY_PUBLIC_URL`

  **`generateValue: true`** (Render generates once, shares verbatim across all
  8 — this is what lets the service mesh trust each other):
  `JWT_SECRET`, `CERT_SIGNING_SECRET`, `INTERNAL_API_TOKEN`

  **Static literals already correct, no action needed:**
  `NODE_ENV=production`, `DB_POOL_MAX=3`, `DB_POOL_MIN=0`, `DB_SYNC=true`,
  `S3_REGION=auto`, `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`,
  `SMTP_SECURE=false`, `SUPPORT_EMAIL`, `COOKIE_SAMESITE=none`,
  `GROQ_MODEL=llama-3.3-70b-versatile`, `REQUIRE_INTERNAL_TOKEN=true`,
  `CHAPA_MODE=live`, `KYC_PAYOUT_THRESHOLD_ETB=10000`

  **Per-service, not in the shared group:** `PKG` (one value per service) and,
  on the gateway only, the 7 `*_SERVICE_URL` vars — currently literal
  `https://ethiopialearn-<name>.onrender.com` values (see §6.5 for why these
  aren't `fromService` references despite that being the "correct" pattern).

- Redeploy = push to `main` (auto-deploys), or Blueprint dashboard →
  **Manual sync** (re-applies `render.yaml`, useful after editing the file
  without a code change, or to force all 8 to rebuild).
- Free-tier specifics: all 8 sleep after 15 min idle; first request through a
  cold chain (Vercel → gateway → N services, all asleep) can take 50s+ per hop.
  `WEB_CONCURRENCY=1` is Render's own default on the free instance size.

### Vercel

Root Directory `web`. `NEXT_PUBLIC_*` vars are baked in at **build** time —
changing one requires a redeploy, not just a dashboard save.
`GATEWAY_INTERNAL_URL` (used server-side, `web/src/lib/server-api.ts`) and
`NEXT_PUBLIC_API_URL` (used client-side, `web/src/lib/api.ts`) currently point
at the same public gateway URL, since Vercel has no private network peering
with Render.

### First-time production database setup

`docker/postgres-init.sql` creates the 7 Postgres **schemas**
(`auth, course, enrollment, outcomes, financial, quality, notification`) plus
the `pgcrypto` extension. **TypeORM (`DB_SYNC=true`) creates tables, but never
schemas** — this has to be run once against Neon before any service can boot
successfully. It was missing on the first deploy attempt, which is why the
gateway (no DB dependency) went live while all 7 domain services failed.

```bash
psql "$DATABASE_URL" -f docker/postgres-init.sql
```

### Seeding demo accounts

`api/services/auth/src/seed.ts`, run as a plain Node script against
`DATABASE_URL` — **not** something Render runs automatically, not a Render
job, just a manual one-off:

```bash
cd api
export PATH="$HOME/.local/opt/node22/bin:$PATH"   # see §7
DATABASE_URL="<neon url>" SEED_PASSWORD="<a real password>" node services/auth/dist/seed.js
```

Idempotent — re-running skips accounts that already exist. Creates one account
per role (`platform_admin`, `quality_officer`, `educator`, `learner`,
`institution_admin`), all pre-verified, plus one demo institution owned by the
institution_admin account. **No course/content seed exists anywhere in the
repo** — courses, sections, lessons are created through the app itself
(log in as the educator account → Teach → New course).

---

## 4. Bugs found and fixed this session (all committed, chronological)

Branch `deploy/render-vercel`, merged to `main` via PRs #4 and #5 so far, with
further commits (`aafd55e`, `0d4bf1a`, `35f95ab`) still on the branch as of
this handoff, not yet merged.

1. **`5aa0416`** — `web/src/app/(public)/home-client.tsx:199` requests
   `/hero-student.jpg`. The actual file lived in a leftover `apps/web/public/`
   directory from an old workspace restructure (`git log`: commit `36165d5`),
   never in `web/public/`. With Vercel's root pointed at `web`, the image
   404'd. **Fix:** `git mv`'d into `web/public/`, deleted the stray `apps/`
   directory entirely.

2. **`bfd4bca`** — `output: 'standalone'` had been added to
   `web/next.config.mjs` to support `web/Dockerfile`'s multi-stage build
   (`COPY --from=build /app/.next/standalone`). Standalone is a **self-hosting**
   output mode — it replaces the normal `.next/` layout Vercel's builder needs
   to generate serverless functions with a bundled `server.js`. Vercel does not
   error on this; the build goes green and **every route, including `/`,
   returns 404 NOT_FOUND** at request time — a silent failure mode, the build
   log gives zero indication anything is wrong. **Fix:** made it opt-in via
   `BUILD_STANDALONE=1`, set only in `web/Dockerfile`'s `ENV`, never present on
   Vercel. Verified both build paths locally (with/without the flag) before
   pushing.

3. **`15603cc`** — Vercel's Framework Preset had been silently set to "Other"
   during the *first* failed build attempt (when Root Directory was
   misconfigured and no `package.json` was found — Vercel's detection failure
   sticks even after you fix Root Directory later; it does not re-run
   automatically). Preset "Other" means Vercel builds the app but never
   generates the Next.js routing manifest — again, green build, dead site
   (404 on every route, same symptom as #2 but a different root cause, which is
   why fixing #2 alone didn't resolve it). **Fix:** `web/vercel.json` with
   `{"framework": "nextjs"}`, which per Vercel's docs overrides the dashboard
   setting outright, so detection can never drift again regardless of what the
   dashboard shows.

4. **`aafd55e`** — `api/packages/common/src/typeorm/typeorm.ts` and
   `api/packages/common/src/events/event-bus.service.ts` both fell back to a
   hardcoded `localhost` connection string whenever `DATABASE_URL` /
   `RABBITMQ_URL` were unset. In a Render container nothing listens on
   localhost, so a simply-forgotten env var manifested as nine rounds of
   `[TypeOrmModule] Unable to connect to the database. Retrying (n)...` /
   `AggregateError [ECONNREFUSED]` with **no mention of which variable was
   actually missing** — genuinely hard to diagnose from the log alone. **Fix:**
   new `envOrLocalDefault()` helper in
   `api/packages/common/src/config/env.ts` — keeps the localhost default for
   local dev, but throws a named, explicit error
   (`Missing required environment variable DATABASE_URL...`) whenever
   `NODE_ENV=production` and the var is absent. Verified by booting the actual
   compiled service both ways (unset in prod → named throw; unset in dev →
   silent localhost fallback, unchanged behavior).

5. **`0d4bf1a`** — Two problems discovered together, both in the gateway↔service
   wiring:
   - The gateway pointed at each service using
     `fromService: { property: hostport }` in `render.yaml` — Render's private
     network address, auto-resolved on every deploy. This is the objectively
     "correct" pattern per Render's own docs (no manual URL-copying, can't go
     stale). It does not work on the free plan: per Render's private-networking
     docs, **"Free web services can send private network requests, but they
     can't receive them."** Every gateway→service call 502'd
     (`{"statusCode":502,"message":"Upstream service unavailable"}`).
     Confirmed no `fromService` property (`host`, `port`, `hostport`,
     `connectionString`) yields a public address — there is no way to make
     this pattern work at all on the free tier, not just a config tweak.
     **Fix:** replaced with literal `https://ethiopialearn-<name>.onrender.com`
     values per service. Left an explicit comment in `render.yaml` explaining
     to switch back to `fromService` if these services ever move to a paid
     instance type (paid tiers can receive private traffic).
   - **This is the important one.** Because Render free web services are
     *always* publicly reachable — there is no way to make one private-only —
     and `RolesGuard` (`api/packages/common/src/auth/roles.guard.ts`) trusts
     `x-user-role` / `x-user-id` headers with **no cryptographic check**, the
     original design (services are "never internet-exposed", so trusting
     gateway-set headers is safe) was flatly false on this platform. Any
     service's public URL could be hit directly with a forged
     `x-user-role: platform_admin` header and be granted full admin access,
     completely bypassing the gateway, JWT verification, and login. This was
     confirmed by reading the code and reasoning through the header flow
     (the actual exploit request against the live deployment was not run — the
     sandbox blocked it — but the guard logic leaves no ambiguity). **Fix:**
     `bootstrapService()` in `api/packages/common/src/bootstrap.ts` now
     installs a pre-controller middleware, gated by `REQUIRE_INTERNAL_TOKEN`,
     rejecting any request without a valid `x-internal-token` — on every route
     except `/health` (which Render's own health probe hits with no headers).
     The gateway now attaches `INTERNAL_API_TOKEN` from its own env to
     **every** proxied request, not just ones already marked `auth: 'internal'`
     in `routes.ts`. Verified against a real booted service: `/health` with no
     token → 200 (probe still passes); forged admin header with no internal
     token → 401; same forged header **with** the correct internal token
     (the gateway's actual path) → 200, guard doesn't block legitimate mesh
     traffic.

6. **`35f95ab`** — Latent bug that #5's URL change activated: the proxy's
   keep-alive agent (`api/gateway/src/main.ts`) was constructed as a plain
   `http.Agent`. Node throws `TypeError [ERR_INVALID_PROTOCOL]: Protocol
   "https:" not supported. Expected "http:"` the instant that agent is handed
   an `https://` target — which every target became once #5 switched from
   private `http://host:port` to public `https://*.onrender.com` addresses.
   Every proxied request died at socket creation, again surfacing as a 502.
   **Fix:** build two proxy instances, one per protocol (`http.Agent` /
   `https.Agent`), dispatch by the scheme of the resolved target at request
   time. `http://` targets (docker-compose) keep their original code path
   untouched. Verified by running the actual compiled gateway locally, pointed
   at the real live `https://ethiopialearn-auth.onrender.com` — confirmed the
   `ERR_INVALID_PROTOCOL` no longer occurs and the request reaches the service
   (returns its own 401, from #5's guard, using a deliberately-wrong test
   token — proving both fixes work together).

Also fixed earlier, before this deploy work started, from a bad PR #3 merge on
`main`: `web/src/app/(public)/signup/page.tsx` was missing the
`GoogleSignInButton` import (hard build failure); `login/page.tsx` had lost
the component's usage entirely (silent feature regression, no build error).
Both restored. Unrelated to deployment infra, found only because I ran the
actual production build rather than trusting the diff.

---

## 5. Production state as of this handoff — verified, not assumed

Everything below was actually tested against live infrastructure, not just
read from code:

- Neon reachable; ran `psql` directly against it. **All 7 schemas + `pgcrypto`
  extension created** via `docker/postgres-init.sql` (they did not exist
  before — confirmed by the `CREATE SCHEMA` output, not `already exists`).
- **Seeded.** `node services/auth/dist/seed.js` run against production Neon.
  Five accounts exist, all `email_verified_at` set:
  `admin@ethiopialearn.et` (platform_admin), `qo@ethiopialearn.et`
  (quality_officer), `educator@ethiopialearn.et` (educator),
  `learner@ethiopialearn.et` (learner), `institution@ethiopialearn.et`
  (institution_admin). Password in `.env.production.local` under the seed
  section — deliberately not the script's own default (`Password123!`), which
  would be a real vulnerability on a public admin account.
- **No migrations exist.** `DB_SYNC=true` — every service creates/updates its
  own tables at boot via TypeORM `synchronize`. Proven working by booting the
  real compiled auth service against production Neon and confirming 7 tables
  appeared in the `auth` schema.
- Groq key verified with a live completion request against
  `api.groq.com/openai/v1/chat/completions` using `llama-3.3-70b-versatile`.
- Upstash Redis password verified by sending a raw `AUTH` command over TLS
  directly to the Upstash host and confirming `+OK` — this specifically caught
  that the user had two similar-looking candidate values and only one was the
  actual wire-protocol password (the other, visually near-identical, was a
  different Upstash token entirely and returned `WRONGPASS`).
- CORS confirmed via a real `curl -i` against the live gateway login endpoint
  with `Origin: https://ethio-learn.vercel.app` — response carried
  `access-control-allow-origin: https://ethio-learn.vercel.app`. Note
  `api/gateway/src/main.ts` reads `CORS_ORIGINS` with `WEB_URL` only as its
  **fallback** — setting `CORS_ORIGINS` **replaces** the allowlist rather than
  extending it, so it must list every allowed origin including the one in
  `WEB_URL`. Vercel preview deployments get random `*-git-*.vercel.app`
  hostnames and will be CORS-blocked unless added individually.
- Gateway→service https proxying and the new internal-token guard verified
  together by running the real gateway binary locally against the real live
  auth service (see item 6 above).

---

## 6. Known-open items, in priority order

1. **`CHAPA_WEBHOOK_SECRET` is currently a weak placeholder value** (see
   `.env.production.local`) — fine for Chapa test mode, but must be rotated to
   a long random value on **both** sides at once (Chapa dashboard + Render env
   group) before any real money moves through this.
2. **Google OAuth is deliberately unconfigured.** `GOOGLE_CLIENT_ID` is
   intentionally blank — explicitly deferred by the user to "next stage after
   this deployment." Do not implement or configure it unless asked again.
3. **`DB_SYNC=true` should become `false`** once the schema stabilizes, backed
   by real generated TypeORM migrations instead of `synchronize`. This was
   raised as an open question early in the deploy process and never actioned —
   still `true` as of this handoff, which is fine for an actively-changing
   schema but is a production-safety risk once real user data exists
   (`synchronize` can silently drop/alter columns on a schema change).
4. **Credentials were pasted into this chat's transcript** at multiple points
   — Neon, R2, CloudAMQP, Brevo, Groq, Chapa. All were kept out of git, but
   they exist in plaintext in the session log. Rotating them post-launch is
   recommended, not yet done.
5. **Free-tier constraints, not bugs, but worth remembering:** all 8 backend
   services sleep after 15 min idle. First request through a fully-cold chain
   (Vercel → asleep gateway → asleep target service) can take 50s+. Gateway↔
   service traffic now crosses the public internet rather than Render's
   private network (§4 item 5) — acceptable for now, but upgrading the 7
   domain services to a paid instance type would both restore private
   networking (better latency, removes the public-exposure requirement for
   `REQUIRE_INTERNAL_TOKEN`) and remove the sleep behavior. Worth doing before
   real traffic.
6. Long-standing, not part of this session's work: eventually splitting
   `api/` and `web/` into two separate GitHub repos was discussed as a
   possible future step (fresh git history, user creates the repos). Not
   started, not currently blocking anything — the current single-repo,
   split-by-root-directory setup works fine indefinitely.

---

## 7. Local dev gotchas on this machine

- `node` is not on PATH in non-interactive tool shells:
  `export PATH="/home/kal/.local/opt/node22/bin:$PATH"` before any
  `node`/`pnpm` command.
- pnpm's store-dir is pinned to a VS Code snap revision path that goes stale
  after snap updates. Use the `current` symlink, not a hardcoded revision
  number: `--store-dir /home/kal/snap/code/current/.local/share/pnpm/store/v3`.
  Changing store-dir triggers an interactive "wipe and reinstall
  node_modules?" prompt — pipe `yes |` in non-interactive shells or it
  half-deletes `node_modules` and aborts partway through.
- `docker compose up --build` only starts infra (postgres, redis, rabbitmq,
  minio) — the 9 app services are behind `profiles: [full]` in
  `docker-compose.yml`. Use `docker compose --profile full up --build` to
  actually build and run the full stack locally.
- Git commits in this repo omit any `Co-Authored-By` trailer.
- `HANDOFF.md` (this file) is listed in `.gitignore` — check whether that's
  intentional before relying on it surviving a fresh clone; it currently only
  exists on disk in this working directory, not in the committed history.

---

## 8. Immediate next step, as of this handoff

Branch `deploy/render-vercel` is ahead of `main`, currently at `35f95ab`,
containing commits `aafd55e` (env var fail-fast), `0d4bf1a` (public URLs +
internal-token guard), and `35f95ab` (https proxy fix) — none yet merged.

1. Merge `deploy/render-vercel` → `main`.
2. Render → Blueprint → **Manual sync** (picks up the new
   `REQUIRE_INTERNAL_TOKEN` var and rebuilds the gateway with the https-proxy
   fix; no env values need to change by hand for this step).
3. Test login at `https://ethio-learn.vercel.app` with
   `admin@ethiopialearn.et` / (password in `.env.production.local`).
4. If a 502 still occurs at this point, the gateway's Render log will show a
   **different** error than the two already fixed (`Upstream service
   unavailable` from missing URLs, or `ERR_INVALID_PROTOCOL` from the http
   agent) — that new message is the next thing to chase, not a repeat of
   either of those two.
