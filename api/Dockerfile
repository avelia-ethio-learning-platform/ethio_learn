# Slim multi-stage build for any backend workspace package (gateway + 7 services).
# Build from the api/ directory: docker build --build-arg PKG=@ethiopialearn/auth-service api/
# The runtime stage carries only one service's compiled dist and its
# production dependencies: no source, no dev deps, no toolchain.
# The base is pinned by digest; Dependabot (docker ecosystem) bumps it.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS base
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate
WORKDIR /repo

FROM base AS build
ARG PKG
# Dependencies first, from the lockfile alone: a source-only change reuses this layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm exec turbo run build --filter=${PKG}
# Isolated production bundle (workspace deps included with their dist/)
RUN pnpm --filter=${PKG} deploy --prod /out

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /out/package.json ./
COPY --from=build --chown=app:app /out/node_modules ./node_modules
COPY --from=build --chown=app:app /out/dist ./dist
USER app
CMD ["node", "dist/main.js"]
