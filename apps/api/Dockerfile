# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/api/Dockerfile .
# The monorepo lockfile and packages/shared live outside apps/api.

FROM node:22.13-bookworm-slim AS base
# Prisma's query engine needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Manifests only, so dependency layers are cached until a package.json changes.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

FROM manifests AS deps
RUN npm ci -w @huddle/api -w @huddle/shared --include-workspace-root --ignore-scripts

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @huddle/shared \
	&& npm exec -w @huddle/api -- prisma generate \
	&& npm run build -w @huddle/api

# Development: used by docker-compose, with src/ mounted for hot reload.
FROM build AS dev
ENV NODE_ENV=development
EXPOSE 3001
CMD ["npm", "run", "start:dev", "-w", "@huddle/api"]

# Production: runtime dependencies and compiled output only.
FROM manifests AS prod
ENV NODE_ENV=production
RUN npm ci -w @huddle/api -w @huddle/shared --omit=dev --ignore-scripts \
	&& npm cache clean --force
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/prisma apps/api/prisma
WORKDIR /app/apps/api
# Winston writes log files to ./logs; the app runs as the unprivileged node user.
RUN mkdir -p logs && chown node:node logs
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
