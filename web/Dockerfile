# Next.js standalone build — final image carries only the standalone server
# output (no node_modules toolchain, no source), on node:22-alpine pinned by
# digest (Dependabot's docker ecosystem bumps it).
# Build context is this web/ directory: docker build -t ethiopialearn-web web/
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS base
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate
WORKDIR /app

FROM base AS build
# Dependencies first, from the manifest and lockfile alone: a source-only change reuses this layer
# (and so does a change of the build args below, which come after it).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ARG NEXT_PUBLIC_S3_PUBLIC_URL=http://localhost:9000/ethiopialearn
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
# Comma-separated public /health URLs the browser pings to wake free-tier services (see .env.example).
ARG NEXT_PUBLIC_WAKE_URLS=
# Selects `output: 'standalone'` in next.config.mjs; the runtime stage below
# copies .next/standalone, so this build MUST produce it.
ENV BUILD_STANDALONE=1 \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_S3_PUBLIC_URL=$NEXT_PUBLIC_S3_PUBLIC_URL \
    NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID \
    NEXT_PUBLIC_WAKE_URLS=$NEXT_PUBLIC_WAKE_URLS \
    NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm build

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
