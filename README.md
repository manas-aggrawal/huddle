# Huddle

Multiplayer AI agents: a team and an AI agent research and write a document together, live. Anyone can drop in to watch, steer, or take over.

- Product concept: [`CONCEPT.md`](./CONCEPT.md)
- Data model: [`docs/DB_DESIGN.md`](./docs/DB_DESIGN.md), [`docs/DB_UML_DESCRIPTION.md`](./docs/DB_UML_DESCRIPTION.md), [`apps/api/prisma/schema.prisma`](./apps/api/prisma/schema.prisma)
- Work tracking: [GitHub issues](https://github.com/manas-aggrawal/huddle/issues) (source: [`docs/TICKETS.md`](./docs/TICKETS.md))

## Layout

```
apps/
  api/        NestJS backend (from nestjs-boilerplate): REST, WebSockets, agent runner, Prisma + Postgres
  web/        React + Vite frontend
packages/
  shared/     Types and helpers used by both apps (session roles, permissions, socket events)
docs/         Design docs
```

This is an npm workspaces monorepo. Each app builds and runs on its own. They share code only through `@huddle/shared`, which is built to both CommonJS (for the API) and ESM (for the web app).

## Prerequisites

- Node **22.13+** (`nvm use` picks it up from `.nvmrc`)
- Docker (for Postgres)

## Setup

```bash
nvm use
npm install                                   # installs every workspace and generates the Prisma client
cp apps/api/.env.example apps/api/.env
cd apps/api && docker compose up -d db && cd ../..   # Postgres on localhost:5432
npm run migrate -w @huddle/api                # apply database migrations
npm run dev
```

| URL | What |
|---|---|
| http://localhost:5173 | Web app |
| http://localhost:3001/health | API health (includes the database) |
| http://localhost:3001/api/docs | Swagger API docs |

## Scripts (run from the repo root)

| Script | What it does |
|---|---|
| `npm run dev` | Builds `shared`, then runs shared (watch), API and web together |
| `npm run dev:api` / `dev:web` / `dev:shared` | Run one package |
| `npm run build` | Builds shared, then API, then web |
| `npm run lint` | Biome lint across all packages |
| `npm run check` | Biome format + lint with fixes |
| `npm run test:e2e` | API end-to-end tests |

Run any package script directly with `-w`, for example `npm run migrate:new -w @huddle/api`.
