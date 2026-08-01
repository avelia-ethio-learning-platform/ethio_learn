# Next.js standalone build — final image carries only the standalone server
# output (no node_modules toolchain, no source), on node:20-alpine.
# Build context is this web/ directory: docker build -t ethiopialearn-web web/
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate
WORKDIR /app

FROM base AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ARG NEXT_PUBLIC_S3_PUBLIC_URL=http://localhost:9000/ethiopialearn
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
# Selects `output: 'standalone'` in next.config.mjs; the runtime stage below
# copies .next/standalone, so this build MUST produce it.
ENV BUILD_STANDALONE=1 \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_S3_PUBLIC_URL=$NEXT_PUBLIC_S3_PUBLIC_URL \
    NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID \
    NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
