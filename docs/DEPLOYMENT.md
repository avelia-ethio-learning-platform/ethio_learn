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
| financial     | + `CHAPA_MODE`, `CHAPA_SECRET_KEY`, `CHAPA_WEBHOOK_SECRET`, `CHAPA_FALLBACK_EMAIL`, `GATEWAY_PUBLIC_URL`, `WEB_URL` | Register `<GATEWAY_PUBLIC_URL>/api/v1/payments/webhook/chapa` in the Chapa dashboard. A `@Cron('*/2 * * * *')` sweep re-verifies any payment still pending after a minute, so a missed/delayed webhook self-heals — run exactly one replica, same as the payout cron below |
| quality       | + `GROQ_API_KEY` (plagiarism screen)                                    | |
| notification  | + email provider (SMTP_* or `RESEND_API_KEY`), `PLATFORM_ADMIN_EMAIL`, `WEB_URL` | Also hosts course comments + direct messages |
| web           | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_S3_PUBLIC_URL` | Static assets in `public/mediapipe/` power exam proctoring |

## Build & run one service alone

```bash
pnpm turbo build --filter=@ethiopialearn/course-service
PORT=4102 node api/services/course/dist/main.js
```

Each service exposes `GET /health` for liveness probes. On boot a service runs
its pending migrations before it listens, so `/health` answers only once its
schema is current (README: "Changing the schema").

## Production checklist

- [ ] Long random (32+ characters) `JWT_SECRET`, `INTERNAL_API_TOKEN`, `CERT_SIGNING_SECRET`; production refuses to boot without them, and with `REQUIRE_INTERNAL_TOKEN` off
- [ ] `CHAPA_WEBHOOK_SECRET` = the **webhook secret hash** from the Chapa
      dashboard (a `CHAPUBK_…` public key is the wrong value)
- [ ] Gateway is the only service with a public ingress; services + RabbitMQ +
      Postgres live on a private network
- [ ] `CORS_ORIGINS` locked to the real web origin(s)
- [ ] Production schema matches the code: `DATABASE_URL=<prod> pnpm -C api db:check`
      reports no drift (it is read-only)

## Outbox (Phase 9b)

**What it is:**
- auth, course, enrollment, financial, quality and outcomes each have an `outbox` table in their schema.
- An event that another service acts on (a refund approved, a course completed, a user registered, a fraud flag, a course published…) is written there in the same transaction as the state change it announces. If the transaction rolls back, there's no event; if it commits, the event is delivered at least once.
- Right after the commit, the service publishes the row (the fast path). A relay inside the service sends anything left over every `OUTBOX_POLL_MS` (5 s), oldest first, and stops at the first failure so nothing overtakes it.
- The row's `id` is the event's `event_id`, so a re-send is the same event to the consumers' dedupe.
- Published rows are deleted after `OUTBOX_RETENTION_DAYS` (7).
- A broker outage, or a crash between the commit and the publish, loses nothing. The rows wait and go out on the first relay tick once the broker is back. On a sleeping free instance, that's the first tick after it wakes.

**Watching:**
- warn `outbox relay: N event(s) older than 10 min still unpublished`: the relay can't publish (the broker is down, or a row keeps failing);
- error `outbox row <id> (<type>) failed 20 times: <error>`: one row is stuck and blocks the rows behind it.
- Stuck rows, read-only, per schema:
  ```sql
  SELECT event_type, count(*), min(created_at), max(attempts) FROM <schema>.outbox WHERE published_at IS NULL GROUP BY 1;
  SELECT id, event_type, attempts, last_error, created_at FROM <schema>.outbox WHERE published_at IS NULL ORDER BY created_at, id LIMIT 5;
  ```

**A poison row** (it fails every time, so its service's events stop):
1. Read its `last_error` and payload, and fix the cause if it's on the consumer side or in the broker.
2. If the event itself must be skipped, mark it sent. The next tick goes on with the rows behind it:
   ```sql
   UPDATE <schema>.outbox SET published_at = now() WHERE id = '<id>' AND published_at IS NULL;
   ```
   Then do by hand whatever the skipped event would have caused, since its consumers never see it.

