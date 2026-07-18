# Deploying EthiopiaLearn — independent services

Every backend service is a self-contained NestJS app that can be built, shipped
and scaled on its own. This page is the contract that keeps that true.

## Topology

```
                       ┌────────────────────────────────────────────┐
 browser ── WEB_URL ──▶│ web (Next.js)                              │
                       └──────────────┬─────────────────────────────┘
                                      │ NEXT_PUBLIC_API_URL
                                      ▼
                       ┌────────────────────────────────────────────┐
 Chapa webhooks ──────▶│ gateway :4000  (ONLY internet-exposed API) │
                       └───┬────────────────────────────────────┬───┘
                           │ *_SERVICE_URL (private network)    │
      ┌──────────┬─────────┼──────────┬───────────┬─────────┐   │
      ▼          ▼         ▼          ▼           ▼         ▼   ▼
    auth      course   enrollment  outcomes   financial quality notification
    :4101     :4102      :4103      :4104       :4105    :4106   :4107
      │          │         │          │           │         │       │
      └──────────┴─────────┴────┬─────┴───────────┴─────────┴───────┘
                                │
              PostgreSQL (schema-per-service) · RabbitMQ (events)
              Redis (refresh-token allowlist) · S3/MinIO (media)
```

## The three communication rules

1. **Clients (web, mobile) talk ONLY to the gateway** (`NEXT_PUBLIC_API_URL`).
   Services are never internet-exposed.
2. **Synchronous service-to-service reads go back through the gateway** using
   `InternalHttpClient` → `GATEWAY_INTERNAL_URL` with the shared
   `INTERNAL_API_TOKEN` (`x-internal-token` header; the gateway strips the
   header from client traffic and validates it on `/api/v1/internal/*` routes).
   No service ever dials another service's host directly, so services can move
   hosts freely — only the gateway's route table knows where they live.
3. **Everything asynchronous is a RabbitMQ event** (`RABBITMQ_URL`, fanout per
   event type, envelope in `api/packages/contracts/src/events.ts`). Payloads are
   event-carried state: consumers must never need a cross-schema join.

Data isolation: each service owns one PostgreSQL **schema**
(`buildTypeOrmOptions('<service>', …)`) and has no TypeScript imports from any
other service's `src/`. A service can be pointed at its own dedicated database
by giving it a different `DATABASE_URL`.

## Environment variables per deployable

| Deployable    | Required                                                                | Notes |
|---------------|-------------------------------------------------------------------------|-------|
| gateway       | `JWT_SECRET`, `INTERNAL_API_TOKEN`, `CORS_ORIGINS`/`WEB_URL`, and one `*_SERVICE_URL` per service | The only place service addresses exist. Rate limits tunable via `RATE_LIMIT_*` (see `api/.env.example`); the limiter store is in-memory — run one gateway instance, or accept per-instance limits when scaling out |
| every service | `DATABASE_URL`, `RABBITMQ_URL`, `JWT_SECRET`, `INTERNAL_API_TOKEN`, `GATEWAY_INTERNAL_URL`, `PORT` | `GATEWAY_INTERNAL_URL` = gateway's private address |
| auth          | + `WEB_URL` (verification/invite links)                                 | |
| course        | + S3 vars, `GROQ_API_KEY` (AI outlines/quiz gen)                        | |
| outcomes      | + S3 vars (certificates, projects, proctor snapshots), `GROQ_API_KEY`, `CERT_SIGNING_SECRET` | |
| financial     | + `CHAPA_MODE`, `CHAPA_SECRET_KEY`, `CHAPA_WEBHOOK_SECRET`, `CHAPA_FALLBACK_EMAIL`, `GATEWAY_PUBLIC_URL`, `WEB_URL` | Register `<GATEWAY_PUBLIC_URL>/api/v1/payments/webhook/chapa` in the Chapa dashboard |
| quality       | + `GROQ_API_KEY` (plagiarism screen)                                    | |
| notification  | + email provider (SMTP_* or `RESEND_API_KEY`), `PLATFORM_ADMIN_EMAIL`, `WEB_URL` | Also hosts course comments + direct messages |
| web           | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_S3_PUBLIC_URL` | Static assets in `public/mediapipe/` power exam proctoring |

## Build & run one service alone

```bash
pnpm turbo build --filter=@ethiopialearn/course-service
PORT=4102 node api/services/course/dist/main.js
```

Each service exposes `GET /health` for liveness probes. Schema changes are
applied by TypeORM `synchronize` in development; generate migrations before
pointing at a production database.

## Production checklist

- [ ] Long random `JWT_SECRET`, `INTERNAL_API_TOKEN`, `CERT_SIGNING_SECRET`
- [ ] `CHAPA_WEBHOOK_SECRET` = the **webhook secret hash** from the Chapa
      dashboard (a `CHAPUBK_…` public key is the wrong value)
- [ ] Gateway is the only service with a public ingress; services + RabbitMQ +
      Postgres live on a private network
- [ ] `CORS_ORIGINS` locked to the real web origin(s)
- [ ] Replace `synchronize` with migrations (`DB_SYNC=false`)
