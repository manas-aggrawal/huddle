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
