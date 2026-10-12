# Huddle

Multiplayer AI agents: a team and an AI agent research and write a document together, live. Anyone can drop in to watch, steer, or take over.

- Product concept: [`CONCEPT.md`](./CONCEPT.md)
- Data model: [`docs/DB_DESIGN.md`](./docs/DB_DESIGN.md), [`docs/DB_UML_DESCRIPTION.md`](./docs/DB_UML_DESCRIPTION.md), [`apps/api/prisma/schema.prisma`](./apps/api/prisma/schema.prisma)
- Work tracking: [GitHub issues](https://github.com/manas-aggrawal/huddle/issues) (source: [`docs/TICKETS.md`](./docs/TICKETS.md))

## How it works

- **Session room**: plan, a live shared document (Tiptap + Yjs over Hocuspocus at `/collab`), and a timeline (Socket.IO, replayable by sequence number).
- **Agent** (`apps/api/src/agent`): one loop per session, driven by saved state. It drafts an outline and asks for approval, then for each step researches (SearXNG search + page reader with citations), writes the section into the doc, and between sections handles the team's suggestions, comments, conflicts and plan edits. Interrupts stop it at once; questions are answered right away.
- **Approvals**: outline, final draft, budget, step gates, and rewrites of text people wrote.
- **LLM layer** (`apps/api/src/llm`): the only code that talks to a model; it checks budgets before and records tokens after every call.

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
cd apps/api && docker compose up -d db searxng && cd ../..   # Postgres on :5432, web search on :8080
npm run migrate -w @huddle/api                # apply database migrations
npm run seed:demo -w @huddle/api              # optional: the four demo users (see Demo script)
npm run dev
```

| URL | What |
|---|---|
| http://localhost:5173 | Web app |
| http://localhost:3001/health | API health (includes the database) |
| http://localhost:3001/api/docs | Swagger API docs |
| http://localhost:8080 | SearXNG (the agent's web search) |

### Pick a model (free)

The agent needs one model provider. Both are free:

- **Groq** (hosted, fast): create a key at https://console.groq.com/keys and set `GROQ_API_KEY` in `apps/api/.env`. The default model is `groq:llama-3.3-70b-versatile`.
- **Ollama** (local): install [Ollama](https://ollama.com), `ollama pull qwen2.5:14b`, and list it in `MODELS`, for example `MODELS=ollama:qwen2.5:14b`. To make it the default, set `DEFAULT_MODEL_PROVIDER=ollama` and `DEFAULT_MODEL_ID=qwen2.5:14b`.

The Owner can switch models per session from the header; the change applies from the agent's next step. Tests never call a real model.

### Environment (`apps/api/.env`)

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | | Postgres connection |
| `JWT_*_SECRET` | | Token signing secrets: change them anywhere that isn't your laptop |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | `1h` / `8h` | Token lifetimes (`30s`, `15m`, …) |
| `ALLOWED_ORIGINS` | | Web app origins allowed by CORS and the realtime socket |
| `WEB_APP_URL` | `http://localhost:5173` | Where invite links point |
| `DEFAULT_MODEL_PROVIDER` / `DEFAULT_MODEL_ID` | `groq` / `llama-3.3-70b-versatile` | Model for new sessions |
| `MODELS` | | Other models people can pick, `provider:modelId` comma-separated |
| `GROQ_API_KEY` | | Groq key |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Where Ollama listens |
| `SEARXNG_URL` | `http://localhost:8080` | Web search for the agent |
| `AGENT_ENABLED` | `true` | `false` creates sessions without an agent working on them |
| `AGENT_RESEARCH` | `true` | `false` skips web research before each section (faster, cheaper) |
| `SCRAPER_ALLOW_HOSTS` | | Private hosts the page reader may fetch (local testing only) |

Token budgets: each workspace has a shared monthly pool (2M tokens by default); the Owner can also cap a session. Running out pauses the agent and asks for more (session cap) or pauses the workspace's sessions until an admin raises the pool.

## Demo script (3 minutes, three browsers)

`npm run seed:demo -w @huddle/api` creates **mayachen**, **leopark**, **rajmehta** and **danasilva** (password `Huddle@2026`; you can also log in with `maya@huddle.demo` and so on). Use `-- --reset` before a re-run to wipe their sessions. Log in as each in a separate browser profile or private window.

1. **Maya** creates *“Competitive analysis of the top 5 note-taking apps”*. The outline appears in the plan; she approves it and the agent starts researching and writing, live.
2. Maya clicks **Invite** and sends an Editor link to **Leo** and **Raj**, and a Viewer link to **Dana**.
3. **Leo** suggests *“Add UX notes to each app”*. After the current section, the agent replies to Leo by name and adds it to the plan.
4. **Raj** suggests the opposite of something Maya asked for (e.g. *“Keep the verdict to one line”* vs *“Make the verdict a full page”*). The conflict card appears; Maya resolves it and the decision is pinned.
5. Leo edits a paragraph: it's marked as his (tint, rule, “Written by Leo”), and the agent won't change it without asking.
6. Maya clicks **Hand off**, drafts a briefing, and hands the session to Leo.
7. Dana opens the session as a Viewer, sees the catch-up card, and **asks** *“Why is Notion first?”*; the agent answers her.
8. When every section is written, the Owner approves **Mark the document final**. The session is Done and can be replayed.

## Scripts (run from the repo root)

| Script | What it does |
|---|---|
| `npm run dev` | Builds `shared`, then runs shared (watch), API and web together |
| `npm run dev:api` / `dev:web` / `dev:shared` | Run one package |
| `npm run build` | Builds shared, then API, then web |
| `npm run lint` | Biome lint across all packages |
| `npm run check` | Biome format + lint with fixes |
| `npm run test:e2e` | API end-to-end tests (uses the `huddle_test` database; the agent runs against a scripted model) |
| `npm run gen:api` | Regenerates the web app's API types from the API's OpenAPI document (no server or DB needed). Run after changing an endpoint. |

Run any package script directly with `-w`, for example `npm run migrate:new -w @huddle/api`.
