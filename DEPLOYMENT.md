# Deployment guide

EthiopiaLearn is split into `api/` (a pnpm/Turborepo workspace of 8 stateless Node services — 7 domain services + 1 API gateway) and `web/` (a standalone Next.js frontend), backed by PostgreSQL, Redis, RabbitMQ and S3-compatible object storage. This document covers how to run it beyond `pnpm -C api dev`.

## Environments at a glance

| Environment | How it runs | Notes |
|---|---|---|
| **Local dev** | `docker compose up -d` for infra, then `pnpm -C api dev` + `pnpm -C web dev` (or `scripts/start-backend.sh` / `scripts/start-web.sh` on low-RAM machines) | Mock Chapa, console/SMTP email, mock or real Groq. Everything on `localhost`. |
| **Single-box / VPS** | `docker compose --profile full up --build -d` | All 9 app containers + infra on one host. Good for a staging box or a small launch. Put nginx/Caddy in front for TLS. |
| **Cloud (recommended)** | One container per service on ECS Fargate / Google Cloud Run; managed Postgres/Redis/RabbitMQ; S3 + CloudFront/Cloudflare | Each service scales independently. Frontend on Vercel or a container behind a CDN. |

## Container images

Slim multi-stage builds (`node:20-alpine`) are already defined:

- `api/Dockerfile` — build from the `api/` context; builds any one service via `--build-arg PKG=@ethiopialearn/<name>` and ships only a pruned production `pnpm deploy` (no source, no dev deps, no toolchain). Build all 8 with the same Dockerfile.
- `web/Dockerfile` — build from the `web/` context; Next.js `output: standalone`, the runtime image carries only the standalone server + static assets.

CI/CD (`.github/workflows/ci.yml`) runs on every push/PR: backend build + unit tests, frontend typecheck + tests + build, then a full **e2e job** (docker-compose infra, all 8 services booted, the demo business flow, and API smoke assertions including rate limiting). On merge to `main` it additionally **builds and pushes every image to GHCR** (`ghcr.io/<repo>/<service>:latest` and `:sha`) — point your host's deploy hook at those tags.

## Free-tier launch path (Render + Neon + R2 + CloudAMQP + Upstash + Brevo)

A zero-budget way to get a real deployment live, one Render web service per app (gateway, 7 services, web):

| Piece | Provider | Env var(s) |
|---|---|---|
| Backend services | Render free web services | `PORT` (Render-injected), `*_SERVICE_URL` per service, `GATEWAY_INTERNAL_URL`, `GATEWAY_PUBLIC_URL` |
| Postgres | Neon free | `DATABASE_URL` — use the **pooled** connection string and set `DB_POOL_MAX=3` (9 services × pools must stay under Neon's connection cap) |
| Object storage | Cloudflare R2 | `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION=auto` — the storage provider already uses `forcePathStyle`, which R2 requires |
| Message bus | CloudAMQP (Little Lemur) | `RABBITMQ_URL` (`amqps://…`) — free tier caps at 20 connections; this stack uses 8 |
| Redis | Upstash | `REDIS_URL` (`rediss://…`) — only auth-service uses it, for the refresh-token allowlist |
| Email | Brevo SMTP | `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` (must be a Brevo-verified sender) — notification-service deploys as a normal Render service, no code changes needed |
| CI/CD | GitHub Actions (already wired) | pushes images to GHCR on merge to `main`; point Render's deploy hook at the new tag, or let Render build straight from the repo |

**Watch out for:**
- **Cold starts.** Render free instances sleep after 15 idle minutes and take tens of seconds to wake. With 9 services, a cold gateway calling a cold downstream service can chain into a multi-minute request. Keep-alive-pinging every service to stay under Render's 750 free instance-hours/month isn't possible — pick the 2-3 most latency-sensitive services (gateway, web, notification) to ping and let the rest sleep.
- **One Render account vs. several.** No functional difference — services talk over public HTTPS regardless. One account is simpler to manage (shared Environment Groups for common vars) but shares the 750-hour budget across every service; multiple accounts multiply the budget at the cost of repeating config and auth per account.
- **Chapa in production**: set `GATEWAY_PUBLIC_URL` to the gateway's Render URL so `callback_url` is sent, register `<gateway>/api/v1/payments/webhook/chapa` in the Chapa dashboard, and set `CHAPA_WEBHOOK_SECRET` to the dashboard's **webhook secret hash** (not the `CHAPUBK_…` public key). The financial-service background sweep (see below) means a sleeping/missed webhook still confirms within ~2 minutes once the service wakes.
- Replace every `dev-*-change-me` secret before this goes public — `INTERNAL_API_TOKEN` matters even more here since inter-service URLs are technically internet-reachable.

## Required infrastructure (managed services in prod)

| Component | Local | Production |
|---|---|---|
| PostgreSQL 15 | docker-compose | RDS / Cloud SQL (one instance, schema-per-service). Run `docker/postgres-init.sql` once to create the 7 schemas + `pgcrypto`. |
| Redis | docker-compose | ElastiCache / Upstash — refresh-token allowlist. |
| RabbitMQ | docker-compose | CloudAMQP or a self-hosted node — domain-event bus. |
| Object storage | MinIO | S3 (or R2/Spaces) + a CDN. Keep the `videos/` prefix **private**; make `thumbnails/` public-read. |

## Configuration (environment variables)

All config is via env vars (see `api/.env.example`). The services read `api/.env` locally; in containers/orchestrators they read the injected environment. **Set these to strong secrets in any non-local environment:**

- `JWT_SECRET`, `CERT_SIGNING_SECRET`, `INTERNAL_API_TOKEN`, `CHAPA_WEBHOOK_SECRET` — long random values.
- `DATABASE_URL`, `REDIS_URL`, `RABBITMQ_URL` — managed endpoints.
- `S3_*` — real bucket + credentials; **unset `S3_ENDPOINT`** on real AWS so the SDK uses AWS.
- `WEB_URL`, `GATEWAY_PUBLIC_URL`, `NEXT_PUBLIC_*` — your real domains.
- **Chapa**: `CHAPA_MODE=live` + `CHAPA_SECRET_KEY` (keep the secret server-side only). Point the Chapa dashboard webhook at `https://api.yourdomain/api/v1/payments/webhook/chapa`.
- **Email**: set `SMTP_*` (any SMTP server / Gmail app-password) **or** `RESEND_API_KEY`. Configure SPF/DKIM/DMARC on the sending domain for inbox delivery.
- **AI**: `GROQ_API_KEY` (+ optional `GROQ_MODEL`). Without a real key, AI features fall back to a deterministic mock.

## Networking & security

- The **API gateway is the only service exposed to the internet.** Put the 7 domain services on a private network/subnet; the gateway reaches them by service name. They trust the gateway's `x-user-*` / `x-internal-token` headers, so they must never be directly reachable.
- Terminate TLS at a load balancer / nginx / Caddy in front of the gateway and the web app.
- Rate limiting, Helmet, and CORS are applied at the gateway; set `WEB_URL` so CORS allows your real origin. Limits are bucketed by risk (strict on login/signup/reset, AI endpoints, comment/DM writes, payment initiation; general cap on everything) and keyed **per authenticated user**, falling back to per-IP for anonymous traffic — tune with the `RATE_LIMIT_*` env vars in `api/.env.example`. The limiter store is in-memory: with more than one gateway replica each replica enforces its own window (fine for launch; move to a shared Redis store if you scale the gateway horizontally).

## Database migrations

For dev, TypeORM `synchronize` is on (auto-creates/updates tables). **Turn it off in production** (`DB_SYNC=false`) and use generated migrations instead — `synchronize` can drop/alter columns unexpectedly. Generating and committing migrations is the one remaining task before a production launch.

## Scaling & operations

- Services are stateless → scale horizontally behind the gateway; use PgBouncer for Postgres connection pooling under load.
- Put a CDN in front of object storage; lesson videos are served as short-TTL signed URLs so the CDN caches renditions without exposing raw keys.
- The nightly payout cron runs inside the Financial service (`@Cron`); ensure only one replica runs the schedule (or move it to an external scheduler hitting `POST /payouts/run`).
- Observability hooks (Sentry, structured logs, Prometheus) are described in the spec; wire your provider's SDK at each service's bootstrap.
