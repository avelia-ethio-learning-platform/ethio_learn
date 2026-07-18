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

CI (`.github/workflows/ci.yml`) already lints, type-checks, builds, and builds every image on merge to `main`. Add a registry login + `push` + your deploy step (ECS/Cloud Run `update-service` / `deploy`) where the `TODO` comment is.

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
- Rate limiting, Helmet, and CORS are already applied at the gateway; set `WEB_URL` so CORS allows your real origin.

## Database migrations

For dev, TypeORM `synchronize` is on (auto-creates/updates tables). **Turn it off in production** (`DB_SYNC=false`) and use generated migrations instead — `synchronize` can drop/alter columns unexpectedly. Generating and committing migrations is the one remaining task before a production launch.

## Scaling & operations

- Services are stateless → scale horizontally behind the gateway; use PgBouncer for Postgres connection pooling under load.
- Put a CDN in front of object storage; lesson videos are served as short-TTL signed URLs so the CDN caches renditions without exposing raw keys.
- The nightly payout cron runs inside the Financial service (`@Cron`); ensure only one replica runs the schedule (or move it to an external scheduler hitting `POST /payouts/run`).
- Observability hooks (Sentry, structured logs, Prometheus) are described in the spec; wire your provider's SDK at each service's bootstrap.
