# @huddle/api

NestJS backend for Huddle, built on [nestjs-boilerplate](https://github.com/manas-aggrawal/nestjs-boilerplate). Setup and the main scripts are in the [root README](../../README.md).

## Stack

| Piece | Choice |
|---|---|
| Framework | NestJS 11 (Express), Node 22.13+ |
| Database | PostgreSQL 17 + Prisma 6 |
| Validation | zod via `nestjs-zod` (global pipe); `joi` for a few legacy validators |
| Auth | Passport: local login, JWT access (1h) + refresh (8h) tokens, forgot-password token |
| Security | Helmet, rate limiting (`@nestjs/throttler`), CORS allowlist, 10 MB body limit |
| Docs | Swagger at `/api/docs` |
| Logging | Winston (console + `logs/`) |
| Tests | Vitest + Supertest e2e, compiled with SWC |

## Conventions

- **No Postgres enums.** Columns with a fixed set of values are strings. The allowed values live in `@huddle/shared` and are validated with zod (see `docs/DB_DESIGN.md` #13).
- **Module system:** TypeScript `module: nodenext` compiling to CommonJS. ESM-only packages (such as the AI SDK) load through Node's native `require(esm)`, which needs Node 22.12+.
- **App setup lives in `src/app.setup.ts`** (`configureApp`), used by both `main.ts` and the e2e tests, so tests run the production request pipeline.
- **Path aliases:** `@src/*`, `@auth/*`, `@configs/*`, `@middleware/*`, `@user/*`. They're mirrored in `vitest.config.ts`.

## Scripts

Run these from the repo root with `-w @huddle/api`, or from this folder.

| Script | What it does |
|---|---|
| `start:dev` | Watch mode |
| `build` / `start:prod` | Compile to `dist/` and run it |
| `test:e2e` | e2e suite against the `<db>_test` database (never the dev DB) |
| `migrate` | Apply migrations (`prisma migrate deploy`) |
| `migrate:new` | Create a migration from schema changes (`prisma migrate dev`) |
| `seed` | Create a local admin user (`admin` / `Admin@1234`) |

## Testing

e2e tests live in `test/*.e2e-spec.ts` and run with `npm run test:e2e`.
- **Database:** a separate `<db>_test` database, created and migrated automatically on the first run. Every test file starts with empty tables.
- **Order:** files run one at a time.
- **Rate limits:** off in tests (`NODE_ENV=test`).

```ts
const ctx = await setupE2E({ users: ['maya', 'leo'] });   // running app + logged-in users
await ctx.as('maya').post('/sessions').send({ ... }).expect(200);
const socket = await connectSocket(ctx.app, ctx.users.leo.token);
const event = await waitForEvent(socket, 'timeline:event', (e) => e.seq === 2);
await ctx.close();
```

| Helper (`test/utils/`) | What it does |
|---|---|
| `setupE2E({ users, providers, overrides })` | Boots AppModule through `configureApp()` on a random port, and registers users |
| `registerAndLogin`, `authed` | Create a user through the API. Supertest calls with their Bearer token. |
| `connectSocket`, `waitForEvent`, `expectNoEvent` | Real Socket.IO clients. Waits fail on timeout instead of hanging. |
| `scriptedModel([...steps])` | Deterministic LLM: scripted text, streamed chunks, tool calls, errors, slow streams. Records every prompt. |
| `startFixtureServer()` | Local web server standing in for the internet: SearXNG-shaped `/search`, an article page, `robots.txt`, custom routes, hit counts |
| `testPrisma`, `resetDatabase` | Direct database access for assertions |

Inject the mock model with `overrides: [{ provide: <LLM token>, useValue: mock.model }]` (the token arrives in #12). `npm run typecheck` also type-checks the tests.

## Auth endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/users/register` | Returns the user plus `access_token` and `refresh_token`. Role is always STANDARD. |
| POST | `/users/login` | `{ usernameOrEmail, password }` |
| GET | `/auth/refresh-token` | Send the refresh token as a Bearer token |
| GET / PATCH / DELETE | `/users/me` | Own profile |
| PATCH | `/users/change-password` | Requires the current password |
| POST | `/users/forgot-password` → PATCH `/users/reset-password` | Reset flow with a short-lived token |
| GET | `/users`, `/users/:id` | ADMIN only |
| GET | `/health` | Public. Checks the database. |

## Docker

The image builds from the **repo root**, because it needs the workspace lockfile and `packages/shared`:

```bash
docker build -f apps/api/Dockerfile --target prod -t huddle-api .
```

- **Targets:** `dev` (used by `docker compose up api`, with `src/` mounted) and `prod` (runtime dependencies only, runs as the `node` user).
- The `prod` image includes the Prisma CLI, so you can run `npx prisma migrate deploy` from it.
