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

## Logs

In production every service and the gateway write one JSON object per line.
Locally the output stays readable.

- **Settings:**
  - `LOG_FORMAT`: `json` or `pretty`. It defaults to `json` when `NODE_ENV=production` and to `pretty` everywhere else.
  - `LOG_LEVEL`: `error`, `warn`, `log` (the default), `debug` or `verbose`. Each level keeps the ones above it.
  - Neither needs setting on Render.
- **A line:**
  - `ts`, `level`, `service`, `context` (the class that logged it) and `msg`;
  - `request_id`, plus `user_id`, `event_id` and `handler` when they're known;
  - `stack` on errors.
- **The access line:** the gateway writes one per request, with `context` `"Access"`:
  - the method, the path and the status;
  - `ms`, `user_id` (only from a verified token), `upstream` (the service) and `ip`;
  - `error_code` when the proxy couldn't reach the service, for example `ECONNREFUSED` while it wakes;
  - a `/health` or `/ready` 200 isn't logged, so wake pings stay out.
- **Following one request:**
  - every API response carries an `x-request-id` header. The gateway keeps an incoming one only if it's a UUID.
  - That id goes with the request to every service it calls. It also becomes the `correlation_id` of every event published while handling it, and the consumers log under the same `request_id`.
  - To follow it, search `"request_id":"<id>"` in each service's Logs in Render. The gateway's access line names the service the request went to.
- **What's never logged:**
  - email addresses (masked as `a***@example.com` where one helps);
  - query strings;
  - invite and pay-request tokens, which show as `[token]` in paths;
  - SQL parameter values and Postgres error messages. A slow query (over `DB_SLOW_QUERY_MS`, 500 ms by default) logs its SQL and duration only.
  - Production also refuses to boot with:
    - `DB_LOGGING=true`;
    - the notification service without a real email provider (`BREVO_API_KEY`, `SMTP_HOST` or `RESEND_API_KEY`). Without one, the console provider would print reset and invite links.
- **Adding code:**
  - log ids, not addresses (`maskEmail()` if one is really needed), and `redactPath()` for a path;
  - `no-pii-in-logs.spec.ts` fails the build on a `logger.*(…)` call with an email-named value outside `maskEmail()`;
  - it also fails the build on a `:token`/`:secret` route param whose parent segment isn't in `TOKEN_PARENTS`.
