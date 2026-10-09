# Huddle: Tickets

Each `## Txx` block below becomes one GitHub issue. Each `Labels:` line becomes issue labels, and each `Milestone:` line becomes a milestone.

**Testing convention:**
- **Backend:** automated e2e tests with Vitest + Supertest + socket.io-client, run against a dedicated test Postgres. (Vitest, not Jest: Jest can't load the ESM-only AI SDK.) The LLM is always mocked in tests, so runs are deterministic and cost nothing.
- **Frontend:** manual test scenarios, checked off in the issue before closing.
- A ticket is done only when its listed e2e tests pass in `npm run test:e2e` or its manual checklist is fully ticked.

---

## T01 · Set up monorepo with the boilerplate as `apps/api`
Labels: area:infra, type:chore
Milestone: Day 1

### Description
Create the Huddle monorepo with npm workspaces:
- `apps/api` is a copy of `manas-aggrawal/nestjs-boilerplate` with fresh git history.
- `apps/web` is React + Vite + TypeScript.
- `packages/shared` holds types used by both apps: socket event names and payloads, the allowed values for every string column (roles, statuses, kinds), and role/permission helpers.
- Root scripts run either app or both. Biome is configured at the root and applies to all packages.

### Tasks
- [ ] Root `package.json` with `workspaces: ["apps/*", "packages/*"]`
- [ ] Copy boilerplate into `apps/api`, remove its `.git`, keep its README as `apps/api/README.md`
- [ ] Scaffold `apps/web` (Vite React TS)
- [ ] `packages/shared` with a `tsconfig`, built to CJS + ESM (or consumed as TS source by both apps)
- [ ] Root scripts: `dev` (api + web together), `dev:api`, `dev:web`, `build`, `lint`, `test:e2e`
- [ ] Root Biome config. Remove per-app lint configs that conflict with it.
- [ ] Root README covering setup, scripts and folder layout
- [ ] Move `CONCEPT.md` and `docs/` into the repo

### Test scenarios
- **Manual:** `npm install` at the root installs every workspace without errors
- **Manual:** `npm run dev` starts the API on :3001 and the web app on :5173
- **Manual:** importing a type from `@huddle/shared` compiles in both `apps/api` and `apps/web`
- **Manual:** `npm run lint` covers all packages

### Done when
A fresh clone followed by `npm install && npm run dev` runs both apps.

---

## T02 · Clean up and harden the boilerplate
Labels: area:api, type:chore
Milestone: Day 1

### Description
Fix the issues found in the boilerplate review so the base is solid before features land on it.

### Tasks
- [ ] Align Prisma versions: `prisma`, `@prisma/client`, `@prisma/config` all on the same major. Move `@prisma/client` to `dependencies`.
- [ ] Remove leftover ESLint/Prettier deps and configs (Biome replaces them). Move `commitlint` to devDependencies, or drop it.
- [ ] Bump `@types/node` to 22 to match the required Node version
- [ ] Fix the `Role` import in `access-token.guard.ts`: change `.prisma/client/client` to `@prisma/client`
- [ ] Dockerfile: use a multi-stage build, set `EXPOSE` to `PORT`, and run `start:prod` in the production stage. docker-compose keeps using `start:dev` for development.
- [ ] Remove the `CrudSample` model and its migrations (squash migrations into a fresh `init`)
- [ ] Check that `node16` module resolution works with ESM-only libraries we'll add (`ai`, `@hocuspocus/server`, `yjs`). Switch to `nodenext` or adjust if needed.
- [ ] Update Swagger title and description to Huddle

### Test scenarios
- **e2e:** the existing `app.e2e-spec.ts` health check passes
- **e2e:** register → login → `GET /user/me` with the access token returns the user, and the same call without a token returns 401
- **e2e:** refresh token flow returns a new access token
- **Manual:** `docker compose up` builds and the API answers on the configured port
- **Manual:** `npm run build && npm run start:prod` works with no dev deps installed

### Done when
The boilerplate auth flows pass as e2e tests, and nothing references removed tooling.

---

## T03 · Set up the backend e2e test harness
Labels: area:testing, area:api, type:chore
Milestone: Day 1

### Description
Build a reliable e2e test setup that every backend ticket will use.

Already in place from #2: Vitest + SWC (`vitest.e2e.config.ts`), `createTestApp()` (boots AppModule through the same `configureApp()` as `main.ts`), and an automatic `<db>_test` database URL in `test/setup-env.ts`.

### Tasks
- [ ] Create and migrate the `huddle_test` database automatically before the suite (global setup), so a fresh clone needs no manual step
- [ ] Global setup: run `prisma migrate reset --force --skip-seed` once. Per test file, truncate all tables.
- [ ] Test helpers:
  - `createApp()`: boots a Nest test app on a random port
  - `registerAndLogin(name)`: returns `{ user, token }`
  - `authed(token)`: a Supertest agent with the auth header set
  - `connectSocket(token, sessionId)`: a socket.io-client connection
  - `connectDoc(token, sessionId)`: moved to #8, since it needs the Hocuspocus server to exist
- [ ] **Mock LLM:** the provider layer (T12) accepts an injected model, and tests use the AI SDK's `MockLanguageModelV3` (from `ai/test`) with scripted responses and tool calls
- [ ] **Fixture web server:** a local HTTP server that serves canned HTML pages and a fake SearXNG JSON endpoint, so scraper and search tests never touch the internet
- [ ] `waitForEvent(socket, type, predicate)` helper with a timeout
- [ ] `npm run test:e2e` at the root runs the API e2e suite with `--runInBand`

### Test scenarios
- **e2e:** a sample test registers two users, opens two sockets, and both receive a broadcast message
- **e2e:** a sample test runs the mock LLM and asserts on the scripted output
- **Manual:** running the suite twice in a row passes both times, so no state leaks between runs

### Done when
New tests can be written as `const { app, users } = await setup()` in fewer than 10 lines of boilerplate.

---

## T04 · Implement the Prisma schema and migration
Labels: area:db, area:api, type:feature
Milestone: Day 1

### Description
Move `docs/schema.prisma` into `apps/api/prisma/schema.prisma` (it becomes the only copy) and create the migration. Then add raw SQL for the constraints Prisma can't express, the shared value sets, workspace-on-signup, and the timeline helper. A demo-data seed is not needed here; #32 has one for the final demo.

### Tasks
- [ ] Copy the schema in and create a migration (`prisma migrate dev --name huddle_schema`)
- [ ] Add a constant for every string value set to `@huddle/shared` (`SessionStatus`, `AgentState`, `Effort`, `StepStatus`, `MessageMode`, `MessageStatus`, `ApprovalKind`, `ApprovalStatus`, `ActorType`, `EventType`, `NotificationType`, `WorkspaceRole`), matching the `///` comments in the schema. There are no Postgres enums (see DB_DESIGN #13).
- [ ] In the migration SQL, add the constraints Prisma can't express (the exact SQL is in the schema comments):
  - partial unique index `one_owner_per_session` on `SessionMember(sessionId) WHERE role = 'OWNER'`
  - check `can_approve_only_editors`: `canApprove` can only be true when the role is EDITOR
  - check `decision_single_origin`: a Decision can't have both `conflictId` and `approvalId`
- [ ] On user register, create a personal `Workspace` plus a `WorkspaceMember(ADMIN)`, inside the same transaction as the user insert
- [ ] Add a `TimelineService.append(tx, sessionId, event)` helper that allocates `seq` by running `UPDATE "Session" SET "lastEventSeq" = "lastEventSeq" + 1 ... RETURNING`

### Test scenarios
- **e2e:** registering creates the user, a workspace, and a workspace membership
- **e2e:** inserting a second OWNER for the same session fails with a unique-constraint error
- **e2e:** setting `canApprove = true` on a VIEWER or OWNER membership fails the check constraint
- **e2e:** a Decision with both `conflictId` and `approvalId` set fails the check constraint
- **e2e:** 50 concurrent `append()` calls on one session produce seq values 1..50 with no gaps or duplicates
- **e2e:** deleting a session cascades to its members, events, messages and plan steps
- **e2e:** a timeline append inside a transaction that rolls back leaves no gap in the numbering

### Done when
The migration applies cleanly from an empty database, and every constraint test passes.

---

## T05 · Sessions API: create, list, get, update status
Labels: area:api, type:feature
Milestone: Day 1

### Description
REST endpoints for sessions:
- **Creating a session:** any member of the workspace can do it. It creates the `Session` and a `SessionMember(OWNER)` for the creator, sets status `PLANNING`, and appends a `SESSION_CREATED` event with the creator as actor. The session has no creator column; that event is the record.
- **Listing** returns sessions the user is a member of, grouped by status.

### Tasks
- [ ] `POST /sessions` with `{ workspaceId, title, goal, modelProvider?, modelId?, effort?, tokenBudget? }`. The caller must be a member of the workspace. Validate with zod. Default the model from config. `tokenBudget` is an optional per-session cap.
- [ ] `GET /sessions` returns my sessions with my role, member count and status. Supports filtering by `status`.
- [ ] `GET /sessions/:id` returns the session, members (with role), plan steps and pending approvals. Callable only by members.
- [ ] `PATCH /sessions/:id/status` with `pause | resume | end`, Owner only. Appends a `STATUS_CHANGED` event.
- [ ] `@SessionRoles(...)` decorator plus a `SessionRoleGuard` that loads the membership and attaches it to the request. All later session endpoints reuse this guard.
- [ ] Swagger docs for every endpoint

### Test scenarios
- **e2e:** creating a session makes the creator OWNER, sets status PLANNING, and appends a SESSION_CREATED event with seq 1
- **e2e:** a user who isn't a member of the workspace gets 403 when creating a session in it
- **e2e:** `GET /sessions` returns only sessions the caller belongs to
- **e2e:** a non-member calling `GET /sessions/:id` gets 404 (not 403, so the session's existence isn't revealed)
- **e2e:** an Editor calling `PATCH status` gets 403. The Owner calling it succeeds and an event is appended.
- **e2e:** an invalid body (empty goal, or a title over 200 characters) returns 400 with zod error details
- **e2e:** values outside a shared constant are rejected with 400 by zod built from `@huddle/shared` (`z.enum(SessionStatus)` etc.): `GET /sessions?status=BOGUS`, and `POST /sessions` with `effort: 'EXTREME'`. There are no Postgres enums, so this API check is what keeps bad values out (moved here from #4).

### Done when
The role guard is reusable, and every scenario passes.

---

## T06 · Invites, joining and role management
Labels: area:api, type:feature
Milestone: Day 1

### Description
- The Owner creates invite links. EDITOR links are invites, and VIEWER links are share links.
- A logged-in user who opens a link joins the session with that link's role.
- The Owner can change a member's role and toggle `canApprove` for an Editor.

### Tasks
- [ ] `POST /sessions/:id/invites` with `{ role: EDITOR|VIEWER, expiresInHours? }` returns `{ token, url }`. Tokens are 32 random bytes, base64url-encoded.
- [ ] `GET /invites/:token` (public) returns a preview: session title, inviter name and role. Returns 410 if the link is expired or revoked.
- [ ] `POST /invites/:token/accept` creates the membership. It's idempotent: if the user is already a member, their role stays the same and they don't get downgraded. Increments `useCount` and appends a `MEMBER_JOINED` event.
- [ ] `DELETE /sessions/:id/invites/:inviteId` revokes a link (Owner only)
- [ ] `PATCH /sessions/:id/members/:userId` with `{ role?, canApprove? }` (Owner only). Assigning OWNER here is not allowed, because ownership changes only through handoff (T27). Appends a `ROLE_CHANGED` event.
- [ ] `DELETE /sessions/:id/members/:userId` removes a member (Owner only, and the Owner can't remove themselves)

### Test scenarios
- **e2e:** the Owner creates an EDITOR invite, User B accepts it, and B becomes an EDITOR with a MEMBER_JOINED event
- **e2e:** accepting the same invite twice keeps a single membership
- **e2e:** an Editor accepting a VIEWER link stays an EDITOR
- **e2e:** an expired link and a revoked link both return 410 on preview and on accept
- **e2e:** an Editor trying to create an invite gets 403
- **e2e:** PATCH with role OWNER returns 400. The Owner removing themselves returns 400.
- **e2e:** after the Owner changes B to VIEWER, B gets 403 on any Editor-only endpoint

### Done when
Every permission path is covered by a passing test.

---

## T07 · Realtime gateway: socket auth, session rooms, presence
Labels: area:api, type:feature
Milestone: Day 1

### Description
A Socket.IO gateway that:
- authenticates the JWT during the handshake
- lets members join a session room
- broadcasts timeline events
- tracks presence in memory (who's online, what they're viewing, whether they're typing)

The existing `AccessTokenGuard` only works over HTTP, so it needs a WebSocket-specific auth guard.

### Tasks
- [ ] Install `@nestjs/websockets` and `@nestjs/platform-socket.io`
- [ ] `WsAuthGuard` / handshake middleware: reads the token from `auth.token`, verifies it with the same secret, and rejects the connection if it's invalid
- [ ] `session:join { sessionId, sinceSeq }`:
  - Checks membership.
  - Joins room `session:<id>`.
  - Replies with every event after `sinceSeq` (this is how a reconnecting client catches up) and the current presence list.
- [ ] A `TimelineService.append` hook that broadcasts `timeline:event` to the room after the transaction commits
- [ ] Presence events: `presence:update { viewing?, typing? }`, broadcast as `presence:state`. Remove a user from presence on disconnect.
- [ ] Rate-limit `presence:update` to 10 per second per socket
- [ ] Add shared event names and payload types to `packages/shared`

### Test scenarios
- **e2e:** a socket connection without a token, or with an invalid one, is rejected
- **e2e:** a non-member emitting `session:join` gets an error and doesn't receive room events
- **e2e:**
  1. Users A and B join.
  2. A REST action appends an event.
  3. Both sockets receive `timeline:event` with the same seq.
- **e2e:** joining with `sinceSeq: 3` returns only events with seq > 3, in order
- **e2e:** B joining makes A receive `presence:state` listing both. B disconnecting removes B from it.
- **e2e:** a typing update from A reaches B but isn't echoed back to A

### Done when
Two clients see the same events in the same order, and reconnecting loses nothing.

---

## T08 · Collaborative document server (Hocuspocus + Yjs)
Labels: area:api, type:feature
Milestone: Day 1

### Description
Run a Hocuspocus server inside the API process to sync the shared Yjs document for each session:
- **Auth:** JWT plus membership. Viewers get read-only connections.
- **Persistence:** snapshots are saved to `Document.ydocState`.
- **Server-side editing:** an `AgentDocWriter` lets the agent edit the doc as another peer (T13 uses it).

### Tasks
- [ ] Hocuspocus server on `/collab`, either on the same HTTP server as the API or on its own port
- [ ] `onAuthenticate`: verify the JWT, load the membership, reject non-members, and set `connection.readOnly = true` for VIEWER
- [ ] `@hocuspocus/extension-database`: `fetch` and `store` against `Document.ydocState`, debounced at 2 seconds
- [ ] Define the doc schema conventions:
  - ProseMirror fragment `default`
  - headings carry `data-section-id`
  - a `human` mark with `{ userId }` on text that people typed
- [ ] Test helper `connectDoc(app, token, sessionId)` in `test/utils/` (moved here from #3): a Hocuspocus provider plus a Y.Doc, resolving once synced
- [ ] `AgentDocWriter` service: opens a server-side direct connection to a session's doc. Methods: `insertSection(sectionId, title)`, `appendToSection(sectionId, textChunk)`, `getSectionText(sectionId)`, `getHumanOwnedRanges(sectionId)`.
- [ ] Throttled `DOC_EDITED` timeline events for human edits, at most one per user per section per minute

### Test scenarios
- **e2e:** two Editor clients connect, A inserts text, and B's Y.Doc contains it
- **e2e:** a Viewer client's local edits don't reach the server or other clients
- **e2e:** a non-member, or a client with an invalid token, can't connect
- **e2e:** after an edit, disconnecting everyone, and waiting past the debounce, reconnecting returns the same content from the database
- **e2e:** `AgentDocWriter.appendToSection` called 5 times shows up in a connected client's doc, in order
- **e2e:** text inserted by a client with the `human` mark is returned by `getHumanOwnedRanges`

### Done when
The agent and humans edit the same doc, and the content survives server restarts.

---

## T09 · Web app shell: routing, auth and API client
Labels: area:web, type:feature
Milestone: Day 1

### Description
Set up the React app skeleton:
- routes: `/login`, `/register`, `/` (Home), `/s/:sessionId` (session room), `/invite/:token`
- an auth context that stores tokens and refreshes them when they expire
- an API client typed from the backend's Swagger spec

### Tasks
- [ ] React Router routes, plus a guard that redirects to `/login` and returns the user afterward
- [ ] Login and register pages wired to the boilerplate auth endpoints
- [ ] Token storage, and automatic refresh on 401 followed by one retry
- [ ] `openapi-typescript` + `openapi-fetch`, with a `npm run gen:api` script that reads `/api/docs-json`
- [ ] Socket client hook `useSessionSocket(sessionId)`: connects, joins, keeps `lastSeq`, and rejoins with `sinceSeq` after a reconnect
- [ ] A base design: tokens, light/dark theme, plus Button, Avatar, Badge and Card components
- [ ] Invite page: shows the preview, has an "Accept" button, and redirects into the session room

### Test scenarios (manual)
- [ ] Register a new user, which logs them in and lands on Home
- [ ] Log out and back in, and the session persists after a page refresh
- [ ] With the access token expired (set a short TTL), the next request refreshes silently and succeeds
- [ ] Opening `/s/xyz` while logged out redirects to login and returns to `/s/xyz` afterward
- [ ] Opening an invite link while logged out goes to login, then back to the invite preview. Accepting it lands in the room.
- [ ] An expired invite shows a clear "This link has expired" message
- [ ] The UI is readable in both light and dark mode

### Done when
Every manual scenario is ticked.

---

## T10 · Session room layout: header, plan, doc and timeline panes
Labels: area:web, type:feature
Milestone: Day 1

### Description
The main screen: a header with the title, status, Owner, avatars and Invite/Hand-off buttons, then three panes (plan, live doc, timeline) that read live data. On narrow screens the panes stack.

### Tasks
- [ ] Header showing status badge, Owner name and presence avatars. Viewers have dashed avatars. Typing shows as a dot.
- [ ] Invite dialog (Owner only): create an Editor or Viewer link and copy it
- [ ] Plan pane: steps with status icons, live through socket events, with the current step highlighted
- [ ] Timeline pane: virtualized list rendering each `EventType` with an actor avatar and a relative time. Auto-scrolls when the user is already at the bottom.
- [ ] Doc pane: Tiptap editor bound to the Yjs doc, with collaborative cursors that show names and avatar colors (color computed from a hash of the user id, initials from the name; neither is stored)
- [ ] Read-only Tiptap for Viewers, plus a small "View only" badge
- [ ] Hide or disable controls based on role, using permission helpers from `packages/shared`

### Test scenarios (manual)
- [ ] With 2 browsers logged in as different users, each sees the other's avatar within 1 second. Closing one removes its avatar.
- [ ] Typing in the doc in browser A appears in browser B live, with A's colored cursor and name
- [ ] Viewer browser: the doc can't be edited, Invite and Hand-off are hidden, and the composer shows only Ask
- [ ] Triggering an event from the API (for example a status change) shows it in both timelines in the same order
- [ ] Killing the API for 10 seconds, restarting it, and appending an event: the client reconnects, and no events are missing or duplicated
- [ ] At 400px width the panes stack and nothing scrolls sideways

### Done when
Every manual scenario is ticked.

---

## T11 · New-session flow
Labels: area:web, area:api, type:feature
Milestone: Day 1

### Description
A form to start a session: title, goal and optional context (pasted text or links), plus a model picker that defaults from config. Submitting creates the session, redirects into the room, and starts the agent's planning (T13).

### Tasks
- [ ] New Session dialog/page with validation that matches the API's zod schema
- [ ] Optional "Context" field, saved as the first `Message` (mode SUGGEST) from the creator
- [ ] Redirect to `/s/:id` on success. The room shows the `PLANNING` state while the outline is generated.

### Test scenarios
- **e2e:** `POST /sessions` with context creates the session plus one QUEUED message authored by the creator
- **Manual:** submitting an empty goal shows an inline error and makes no request
- **Manual:** after creating, the room opens with status "Planning" and an "Agent is drafting an outline…" state

---

## T12 · LLM provider layer and usage tracking
Labels: area:agent, area:api, type:feature
Milestone: Day 1

### Description
One module that wraps the Vercel AI SDK, so the rest of the code never talks to a provider directly:
- **Providers:** Groq (default) and Ollama (local), through config. Paid providers can be added later with no code changes elsewhere.
- **Usage tracking:** every call records tokens to `UsageRecord`, and increments both `Session.tokensUsed` and the workspace pool's `tokensUsedThisPeriod`.
- **Tests:** a mock model can be injected.

### Tasks
- [ ] `LlmModule` with `LlmService.stream({ sessionId, purpose, system, messages, tools, abortSignal })` and `generate(...)`
- [ ] Model registry from env:
  - `GROQ_API_KEY`
  - `OLLAMA_BASE_URL`
  - an allowed list `MODELS=groq:llama-3.3-70b-versatile,ollama:qwen2.5:14b`
- [ ] Map effort LOW/MEDIUM/HIGH to settings: max tokens, temperature, and how many tool-call steps to allow
- [ ] Record usage after each call: one transaction writes the UsageRecord and increments the session and workspace totals
- [ ] Budget check before every call:
  1. If the workspace's `periodStart` is over a month old, start a new period (reset `tokensUsedThisPeriod`, move `periodStart`).
  2. Refuse when the workspace pool is used up (`tokensUsedThisPeriod >= tokenAllowance`): throw `PoolExhaustedError`.
  3. Refuse when the session has a cap and has reached it (`tokensUsed >= tokenBudget`): throw `BudgetExceededError`.
  4. T28 turns both into pauses in the UI.
- [ ] `LLM_PROVIDER_OVERRIDE` token for tests, which injects `MockLanguageModelV3`
- [ ] `GET /models` returns the allowed models, for the picker

### Test scenarios
- **e2e:** with the mock model, `generate` returns the scripted text and writes a UsageRecord with the mock's token counts
- **e2e:** after 3 calls, `Session.tokensUsed` and `Workspace.tokensUsedThisPeriod` both equal the sum of the UsageRecords
- **e2e:** two sessions in the same workspace both add to the same pool
- **e2e:** when the session cap is reached, the call throws BudgetExceededError and makes no model call. A session with no cap (`tokenBudget = null`) is never stopped by this check.
- **e2e:** when the workspace pool is used up, the call throws PoolExhaustedError even if the session is under its cap
- **e2e:** with `periodStart` set over a month ago, the next call resets the period and succeeds
- **e2e:** aborting `stream` midway via `abortSignal` stops it, and the partial usage is still recorded
- **e2e:** `GET /models` returns only models listed in env

### Done when
Agent code depends only on `LlmService`, and all tests use the mock model.

---

## T13 · Agent runner v1: outline, approval, then sections streaming into the doc
Labels: area:agent, area:api, type:feature
Milestone: Day 1

### Description
The core agent loop for each session.

**Planning:**
1. Read the goal and context.
2. Propose an outline as plan steps.
3. Create an `OUTLINE` approval. Status becomes `WAITING`.

**Running** (after approval):
1. Take the next PENDING step and mark it IN_PROGRESS.
2. Create its section heading.
3. Stream the section text into the doc through `AgentDocWriter`.
4. Mark the step DONE.
5. Repeat until no steps are left.

Each session runs one agent at a time.

### Tasks
- [ ] `AgentRunner` with an in-memory registry of running sessions. On boot, resume sessions that are `RUNNING`.
- [ ] Planning prompt that returns structured output (zod): `[{ title, description }]`. Validate it, then insert the PlanSteps.
- [ ] Create the OUTLINE approval (generic approvals arrive in T18; here, just create the row and event)
- [ ] When the outline is approved, set status RUNNING and run steps in `position` order
- [ ] Section writing: stream with the mock or a real model, and append chunks to the doc every ~150ms
- [ ] Update `agentState` (THINKING / WRITING) and broadcast it
- [ ] Events: STEP_STARTED, STEP_COMPLETED, AGENT_MESSAGE ("Finished X")
- [ ] When all steps are done, request a `MARK_FINAL` approval (completion is handled in T31)
- [ ] Context for each section: goal, outline, pinned decisions, previous section summaries, and the current section's existing text

### Test scenarios
- **e2e (mock LLM):**
  1. Create a session.
  2. Plan steps are created, a PENDING OUTLINE approval exists, and status is WAITING.
- **e2e:**
  1. Approve the outline.
  2. Steps go PENDING → IN_PROGRESS → DONE in order.
  3. The doc contains each section heading with the mock text under it.
- **e2e:** timeline events appear in this order: STEP_STARTED(1), STEP_COMPLETED(1), STEP_STARTED(2), …
- **e2e:** two concurrent "start" triggers for the same session result in only one runner
- **e2e:** after a simulated restart (stop the runner, start it again), a RUNNING session resumes at the first non-DONE step without duplicating sections
- **e2e:** an invalid outline from the LLM (bad JSON) triggers one retry, then posts an AGENT_MESSAGE error and stays in PLANNING

### Done when
A session goes from goal to a fully written doc using the mock model, and a manual run with Groq produces a real doc.

---

## T14 · Day 1 integration check (manual)
Labels: area:testing, type:chore
Milestone: Day 1

### Description
End-to-end manual check of the Day 1 slice with a real free model (Groq).

### Test scenarios (manual)
- [ ] Maya creates the session "Competitive analysis of top 5 note-taking apps". An outline appears within about 15 seconds.
- [ ] Leo joins through an Editor link in a second browser and sees the same plan and the pending outline approval
- [ ] Maya approves. Both browsers watch sections stream into the doc live.
- [ ] Leo types into a finished section while the agent writes the next one, and nothing gets overwritten
- [ ] Dana joins through a Viewer link, sees everything, and can't edit
- [ ] Refreshing any browser mid-run restores the full state

---

## T15 · Composer: Suggest, Interrupt and Ask with attribution
Labels: area:api, area:web, type:feature
Milestone: Day 2

### Description
The message box at the bottom of the timeline, with a mode switcher. Every message is stored as a `Message`, appended as a `HUMAN_MESSAGE` event, and tagged with the author's name and role. Permissions:
- **Viewers:** Ask only
- **Editors and Owner:** all modes

### Tasks
- [ ] `POST /sessions/:id/messages` with `{ mode, content, planStepId? }`, enforcing role per mode
- [ ] The HUMAN_MESSAGE event payload includes `messageId`, `mode`, and `author {id, name, role}`
- [ ] Composer UI: a mode dropdown (Suggest by default), Enter to send, Shift+Enter for a newline. Sends `typing` presence while typing.
- [ ] Message status chips in the timeline (Queued → Acknowledged / Applied / Declined / Answered), updated live
- [ ] An `@mention` autocomplete over members, stored in the content as `@[userId]`, which creates a MENTION notification

### Test scenarios
- **e2e:** an Editor posting SUGGEST creates a QUEUED Message plus a HUMAN_MESSAGE event that includes the author's role
- **e2e:** a Viewer posting SUGGEST or INTERRUPT gets 403. A Viewer posting ASK gets 201.
- **e2e:** a message mentioning `@[leoId]` creates a MENTION notification for Leo
- **e2e:** content that's empty or over 4000 characters returns 400
- **Manual:** the mode dropdown shows only "Ask" for a Viewer
- **Manual:** a sent message appears in both browsers with a "Queued" chip, which changes when the agent acknowledges it

---

## T16 · Agent handles suggestions at section boundaries and answers Asks
Labels: area:agent, type:feature
Milestone: Day 2

### Description
The agent doesn't break off mid-section to handle new input:
- **Suggestions:** at the end of each section, the runner reads QUEUED SUGGEST and COMMENT messages and decides, through the LLM, what to do with each. Options: apply now, change the plan, or decline with a reason. It replies to each one by name ("Got it, Leo…").
- **Asks:** answered right away, in parallel with the runner, and they never change the plan.

### Tasks
- [ ] A `processQueue()` step between sections. Structured LLM output: `[{ messageId, decision: apply|plan_change|decline, reply, planOps? }]`.
- [ ] Apply plan operations (add, edit or reorder steps) and append a PLAN_UPDATED event with a diff
- [ ] Set each message's status, `response` and `processedAt`, and append an AGENT_ACK event that names the author
- [ ] An Ask handler: a separate, lightweight LLM call with the session context. Sets status ANSWERED and posts an AGENT_MESSAGE as a threaded reply (`replyTo: messageId`).
- [ ] Every input's author name and role go into the prompt context

### Test scenarios
- **e2e (mock LLM):** a SUGGEST posted while section 2 is writing stays QUEUED until section 2 is done, and only then is ACKNOWLEDGED
- **e2e:** the mock returns `plan_change` (add step "UX notes"), and PlanStep is inserted at the right position with a PLAN_UPDATED event
- **e2e:** the mock returns `decline`, so the message status becomes DECLINED with the response text
- **e2e:** the AGENT_ACK payload references the messageId and the author's name
- **e2e:** an ASK posted while the agent is writing is ANSWERED before the current section finishes, and the plan isn't changed
- **Manual (Groq):** Leo suggests "add UX notes to each profile", and the agent replies to Leo by name and adds the subsections

---

## T17 · Interrupt and replan
Labels: area:agent, type:feature
Milestone: Day 2

### Description
An Interrupt stops the agent right away:
1. Abort the current stream.
2. Mark the step PENDING again, keeping any text already written.
3. Replan using the interrupt.
4. Post the revised plan as a diff.
5. Continue.

### Tasks
- [ ] An `AbortController` per runner. An INTERRUPT message aborts the in-flight stream.
- [ ] A replan prompt with the current plan plus the interrupt, which outputs plan operations
- [ ] Interrupt handling is serialized: a second interrupt during a replan gets queued and applied right after
- [ ] Append a PLAN_UPDATED event with `{ reason: 'interrupt', by, diff }`

### Test scenarios
- **e2e (mock streaming):** an INTERRUPT mid-section stops the stream within 1 second. The doc keeps the partial text and adds no more.
- **e2e:** after a replan, the mock's new plan is applied and the runner continues with the new next step
- **e2e:** two interrupts in quick succession are both processed, in order, with no crash and no duplicate runners
- **e2e:** an Editor can interrupt and a Viewer can't (403)
- **Manual:** clicking Interrupt in the UI makes the typing caret stop within about a second, and the plan pane updates

---

## T18 · Generic approval gates (API, inbox and UI card)
Labels: area:api, area:web, type:feature
Milestone: Day 2

### Description
A single approval system used for outline approval, rewriting human text, marking the doc final, and budget limits:
- **Who can approve:** the Owner, plus Editors with `canApprove`
- **Agent behavior:** it pauses only the gated work. Other independent sections can continue, except for the OUTLINE and MARK_FINAL gates.

### Tasks
- [ ] `ApprovalService.request(sessionId, kind, title, details, planStepId?)`: creates the row, appends an APPROVAL_REQUESTED event, and notifies everyone who can approve
- [ ] `POST /sessions/:id/approvals/:approvalId` with `{ decision: approve|reject, note? }`, checking permission
- [ ] Resolving appends an APPROVAL_RESOLVED event, optionally creates a Decision (T21), and wakes the runner
- [ ] **Status rule:** creating a blocking approval sets `Session.status = WAITING`, and resolving the last pending one sets it back to RUNNING, in the **same transaction** as the approval write. That way the two can't disagree.
- [ ] Concurrency: the first resolution wins, and any later one returns 409
- [ ] UI: an approval card in the timeline with Approve, Reject and Discuss. Discuss pre-fills the composer.
- [ ] UI: a pending-approvals badge in the header, and the 🔒 marker on gated plan steps

### Test scenarios
- **e2e:** the Owner approves, the status changes, and an APPROVAL_RESOLVED event is appended with resolvedBy
- **e2e:** an Editor without canApprove gets 403. After the Owner grants canApprove, the same Editor succeeds.
- **e2e:** two approvers resolving at the same time: one gets 200 and the other gets 409
- **e2e:** creating an approval sets the session to WAITING, and resolving it sets RUNNING. If the approval write is forced to fail, the status is unchanged.
- **e2e:** the request creates Notifications for the Owner and for Editors with canApprove, and for no one else
- **e2e:** a rejected OUTLINE returns the agent to PLANNING to revise, using the rejection note as input
- **Manual:** the card appears in every browser. Once someone approves it, it shows "Approved by Maya" everywhere.

---

## T19 · Protect human-written text
Labels: area:agent, area:web, type:feature
Milestone: Day 2

### Description
Text a person types gets a `human` mark carrying their userId. The agent never overwrites or deletes marked text. To change it, the agent must request a `REWRITE_HUMAN_TEXT` approval that shows the before and after.

### Tasks
- [ ] A Tiptap extension that automatically applies the `human` mark to text typed by the local user, plus a subtle left-border style with an "edited by Leo" tooltip
- [ ] An `AgentDocWriter` guard: write operations that overlap human ranges throw `HumanTextProtectedError`
- [ ] When the agent wants to change marked text, it requests REWRITE_HUMAN_TEXT with `{ sectionId, before, after }`. On approval it applies the change and removes the mark for the changed range.
- [ ] Agent prompts include "Human-authored passages (do not change): …"

### Test scenarios
- **e2e:** a client inserts marked text, the agent tries to replace it via `AgentDocWriter`, the write throws, and the doc is unchanged
- **e2e:**
  1. The agent requests a REWRITE.
  2. The approval exists with before and after text.
  3. On approval the doc contains the new text.
  4. On rejection the doc is unchanged.
- **e2e:** the agent appending after a human paragraph works fine, since it isn't overlapping
- **Manual:** Leo's edits show a blue left border with "edited by Leo" on hover
- **Manual:** pasted text gets the human mark too

---

## T20 · Conflict detection and resolution
Labels: area:agent, area:api, area:web, type:feature
Milestone: Day 2
Cut-able: if behind, replace automatic detection with a manual "Flag conflict" action on messages

### Description
While processing the queue (T16), the agent checks new inputs against each other, the goal, and pinned decisions. When two contradict, it:
1. creates a `Conflict` linking the messages
2. tags both authors
3. pauses only the affected step (BLOCKED)
4. keeps writing the other steps

The Owner settles it with a resolution, which becomes a pinned Decision.

### Tasks
- [ ] Extend the `processQueue` output with `conflicts: [{ messageIds, summary, planStepId? }]`
- [ ] Create the Conflict, set the step to BLOCKED, append a CONFLICT_RAISED event, and send CONFLICT_RAISED notifications to both authors and the Owner
- [ ] `POST /sessions/:id/conflicts/:conflictId/resolve` with `{ resolution }` (Owner only). Unblocks the step, creates a Decision, and appends CONFLICT_RESOLVED and DECISION_PINNED events.
- [ ] Runner: skips BLOCKED steps and comes back to them once they're unblocked
- [ ] UI: a conflict card showing both sides with avatars, a Resolve dialog for the Owner, and "Waiting for Owner" for others

### Test scenarios
- **e2e (mock):** the mock reports a conflict between messages A and B, creating a Conflict linked to both and setting the step to BLOCKED
- **e2e:** while blocked, the runner completes other PENDING steps
- **e2e:** an Editor trying to resolve gets 403. The Owner resolving unblocks the step and sets `resolvedAt`/`resolvedById` and creates a Decision linked by `conflictId`.
- **e2e:** resolving an already-resolved conflict (`resolvedAt` set) returns 409
- **Manual:** both tagged users see the conflict in their inbox, and only Maya sees the Resolve button

---

## T21 · Pinned decisions (session memory)
Labels: area:api, area:web, area:agent, type:feature
Milestone: Day 2

### Description
Decisions are the session's shared memory:
- **How they're created:** automatically when a conflict or approval is resolved, or by hand by Editors and the Owner
- **Where they're used:** the agent re-reads all active decisions before every section, and they're shown in the plan pane

### Tasks
- [ ] `POST /sessions/:id/decisions` with `{ content }` (Editor or Owner), and `DELETE` to unpin (sets `unpinnedAt`)
- [ ] Auto-create a decision when an approval is resolved with a note, or when a conflict is resolved
- [ ] Inject active decisions into every section and replan prompt
- [ ] UI: a "Pinned" list in the plan pane showing who decided each one, with Unpin for Editors and the Owner

### Test scenarios
- **e2e:** an Editor pins a decision, which creates a DECISION_PINNED event. A Viewer trying to pin gets 403.
- **e2e:** unpinning sets `unpinnedAt`, and the decision drops out of the active list
- **e2e (mock):** the prompt captured by the mock model contains every active decision's text and no unpinned ones
- **Manual:** a decision pinned in browser A appears in browser B's Pinned list live

---

## T22 · Human plan editing
Labels: area:api, area:web, type:feature
Milestone: Day 2

### Description
Editors and the Owner can edit the plan directly: add a step, rename, describe, reorder, skip, or toggle "needs approval." Changes sync live, and the runner picks them up at the next step.

### Tasks
- [ ] `POST/PATCH/DELETE /sessions/:id/plan-steps`, plus `POST /reorder` with `{ orderedIds }`
- [ ] The step currently IN_PROGRESS can't be deleted or reordered (409). Skipping it means interrupting first.
- [ ] Append a PLAN_UPDATED event with `{ by, diff }`
- [ ] UI: drag to reorder, inline title editing, a step menu (Skip, Needs approval, Delete)

### Test scenarios
- **e2e:** reordering updates `position` for every step to match `orderedIds`, and appends a PLAN_UPDATED event
- **e2e:** deleting the IN_PROGRESS step returns 409
- **e2e (mock):** a step added mid-run is written by the runner in its position
- **e2e:** a step marked `requiresApproval` makes the runner request a CUSTOM approval before writing it
- **e2e:** a Viewer calling any plan endpoint gets 403
- **Manual:** dragging a step in browser A reorders it in browser B live

---

## T23 · Agent tool: web_search through SearXNG
Labels: area:agent, area:infra, type:feature
Milestone: Day 2

### Description
Run SearXNG in docker-compose with its JSON API enabled. Expose a `web_search(query)` tool to the LLM that returns the top results (title, url, snippet). The model decides when to call it.

### Tasks
- [ ] Add a `searxng` service to docker-compose. Its `settings.yml` enables the `json` format, a few engines, and a fixed secret.
- [ ] `SearchService.search(query, { limit: 8 })` with a timeout of about 8 seconds and a 10-minute in-memory cache
- [ ] AI SDK tool definition with a zod input schema
- [ ] Append a TOOL_CALL event `{ tool: 'web_search', query, resultCount }`, and set `agentState = RESEARCHING`
- [ ] Graceful failure: if SearXNG is down, the tool returns an error string to the model and the run doesn't crash

### Test scenarios
- **e2e (fixture SearXNG):** `search('obsidian pricing')` returns normalized results from the fixture JSON
- **e2e (mock LLM calls the tool):** a TOOL_CALL event is appended with the query and result count
- **e2e:** a fixture that never responds times out at about 8 seconds, the tool returns an error, and the section still completes
- **e2e:** the same query within 10 minutes hits the cache and makes no second HTTP request
- **Manual:** `docker compose up searxng` then `curl 'localhost:8080/search?q=test&format=json'` returns results

---

## T24 · Agent tool: read_page scraper
Labels: area:agent, type:feature
Milestone: Day 2

### Description
A `read_page(url)` tool that fetches a page and returns its clean main text.

**Fetching:**
- Plain fetch first: a realistic user agent, robots.txt respected, a 10-second timeout, a 2 MB cap.
- Text extracted with Mozilla Readability + jsdom.
- Playwright fallback when the extracted text is suspiciously short.

**Results:** cached in the session's **workspace** `PageCache` for 24 hours (teams never share cached content), recorded as a `Source` for the session, and truncated to fit the context window (about 12k characters).

### Tasks
- [ ] `ScraperService.read(url)`:
  1. Validate the URL.
  2. Block private IPs and localhost to prevent SSRF, with an allowlist override for tests.
  3. Check robots.txt.
  4. Fetch and extract.
  5. Fall back to Playwright if needed.
- [ ] Cache by (`workspaceId`, `sha256(url)`). Use `finalUrl` after redirects.
- [ ] Upsert a `Source` row. Append a TOOL_CALL event `{ tool: 'read_page', url, title, chars }`.
- [ ] Only `text/html` and `text/plain` are accepted. Other content types return an error string.
- [ ] Citations: the agent's section prompt asks for `[n]` references, and a "Sources" list is maintained at the end of the doc

### Test scenarios
- **e2e (fixture server):** an article page returns its title and main text without the nav or footer
- **e2e:** a page disallowed by the fixture's robots.txt is refused with an error string
- **e2e:** `http://169.254.169.254/` and `http://localhost:5432` are refused (SSRF guard) when no test allowlist is set
- **e2e:** a 5 MB response gets cut at 2 MB without crashing
- **e2e:** a second read within 24 hours from a session in the same workspace is served from PageCache with no HTTP hit
- **e2e:** a session in a different workspace reading the same URL does fetch it again and gets its own cache entry
- **e2e:** a redirect chain is followed, and `Source.url` stores the final URL
- **e2e:** a PDF or image URL returns an "unsupported content type" error string
- **Manual (real web):** the agent researching "Obsidian pricing" reads the official page and cites it

---

## T25 · Show research live in the UI
Labels: area:web, type:feature
Milestone: Day 2

### Description
Make the agent's research visible: tool-call rows in the timeline, a "Researching…" state in the header, and a Sources list.

### Tasks
- [ ] Timeline rows: "🔎 Searched '…' (8 results)" and "📄 Read obsidian.md/pricing", with links that open in a new tab
- [ ] An agent state indicator in the header: Thinking / Researching / Writing / Idle
- [ ] A Sources section at the end of the doc. `[n]` markers in the text link to it.

### Test scenarios (manual)
- [ ] During a real run, search and read rows appear live in every browser
- [ ] Clicking a read row opens the source URL in a new tab
- [ ] The header state switches between Researching and Writing as the agent works
- [ ] The doc ends with a numbered Sources list matching the `[n]` markers

---

## T26 · Catch-up card
Labels: area:api, area:web, area:agent, type:feature
Milestone: Day 3

### Description
When a member opens a session with unseen events (`seq > lastSeenSeq`), show a "Since you were last here…" card with:
- steps completed
- decisions made, and who made them
- approvals and conflicts waiting on this user
- an LLM summary of the rest

Viewing the timeline moves `lastSeenSeq` forward.

### Tasks
- [ ] `GET /sessions/:id/catch-up` returns `{ fromSeq, toSeq, stepsCompleted, decisions, waitingOnYou, summary }`. The structured parts are computed directly from the data. `summary` comes from the LLM, generated on demand and cached by `(sessionId, fromSeq, toSeq)`.
- [ ] Skip the LLM call when there are fewer than 3 unseen events
- [ ] `POST /sessions/:id/seen` with `{ seq }`, which only moves forward and never back
- [ ] UI: a dismissible card at the top of the timeline with "Jump to" links

### Test scenarios
- **e2e:**
  1. Leo's `lastSeenSeq` is 5.
  2. Events 6–20 contain 2 STEP_COMPLETED and 1 DECISION_PINNED.
  3. Catch-up returns those counts and items.
- **e2e:** a pending approval Leo can resolve shows up in `waitingOnYou`
- **e2e:** `seen` with a lower seq than the stored one is ignored
- **e2e (mock):** a second catch-up call for the same range doesn't call the LLM again
- **e2e:** fewer than 3 unseen events returns `summary: null` with no LLM call
- **Manual:** coming back after a run shows the card. Dismissing it and refreshing doesn't show it again.

---

## T27 · Handoff with briefing
Labels: area:api, area:web, area:agent, type:feature
Milestone: Day 3

### Description
The Owner hands the session to another member:
1. The agent generates a briefing covering the goal, progress, open questions, decisions and pending approvals.
2. Roles swap in one transaction: the old Owner becomes an Editor and the new one becomes Owner.
3. A HANDOFF event is appended, and the new Owner gets a notification.

### Tasks
- [ ] `POST /sessions/:id/handoff/preview` with `{ toUserId }` returns the generated briefing
- [ ] `POST /sessions/:id/handoff` with `{ toUserId, note?, briefing }`: swaps roles transactionally and writes Handoff, the event and a HANDOFF_RECEIVED notification
- [ ] Viewers can't receive a handoff (400). The Owner promotes them to Editor first.
- [ ] UI: a Hand-off dialog with a member picker, an editable briefing preview and a note. The new Owner sees a briefing card.

### Test scenarios
- **e2e:** after a handoff, the new Owner has role OWNER, the old one is EDITOR, and there's exactly one OWNER
- **e2e:** an Editor attempting a handoff gets 403. Handing off to a Viewer or a non-member returns 400.
- **e2e:** the old Owner gets 403 on Owner-only endpoints right after the handoff, and the new Owner succeeds
- **e2e:** the Handoff row stores the briefing and note, and the HANDOFF event names both users
- **e2e:** pending approvals stay pending, and the new Owner can resolve them
- **Manual:** Maya hands off to Raj. The header's Owner changes in every browser, and Raj sees the briefing.

---

## T28 · Model and effort picker, budget meter, budget gate
Labels: area:api, area:web, type:feature
Milestone: Day 3

### Description
- **Model and effort:** the Owner changes them for each session, and the change applies from the agent's next LLM call.
- **Budget meter:** everyone sees the session's usage, against its cap when it has one, plus how much of the workspace pool is left.
- **Session cap gate:** reaching the session's cap pauses the agent with a BUDGET approval for the session Owner ("Approve +200k tokens?").
- **Pool exhausted:** when the workspace pool runs out, every running session in the workspace pauses. The workspace admins get a notification, and only a workspace admin can raise the allowance. A session Owner can't approve their way past it.

### Tasks
- [ ] `PATCH /sessions/:id/settings` with `{ modelProvider, modelId, effort, tokenBudget }` (Owner only). The model must be in the allowed list. `tokenBudget: null` removes the cap. Appends a MODEL_CHANGED event.
- [ ] Runner: catch `BudgetExceededError`, request a BUDGET approval, and set status WAITING. Approving raises `tokenBudget` by the requested amount.
- [ ] Runner: catch `PoolExhaustedError`, set status PAUSED with a BUDGET_WARNING event explaining why, and notify workspace admins
- [ ] `PATCH /workspaces/:id/allowance` with `{ tokenAllowance }` (workspace ADMIN only). Raising it resumes paused sessions.
- [ ] `GET /workspaces/:id/usage` returns the allowance, the amount used this period, and the period start
- [ ] Broadcast `session:usage` after each call
- [ ] UI: a model and effort picker in the header (read-only for non-Owners) and a token meter for the session cap and the workspace pool, which turns orange at 80% and red at 100%

### Test scenarios
- **e2e:** an Editor changing settings gets 403. A model that isn't in the allowed list returns 400.
- **e2e (mock):** after a model change, the next LLM call uses the new model, and its UsageRecord shows it
- **e2e:** setting the session cap to just above current usage, the next call triggers a BUDGET approval and status WAITING. Approving resumes the run with a higher cap.
- **e2e:** an exhausted workspace pool pauses every running session in the workspace and notifies the admins. A session Owner who isn't a workspace admin gets 403 on the allowance endpoint. Raising the allowance as admin resumes the sessions.
- **Manual:** switching from Groq to Ollama mid-session keeps the agent writing the next section with the new model

---

## T29 · Home: sessions list and inbox
Labels: area:web, area:api, type:feature
Milestone: Day 3
Cut-able

### Description
The landing page lists the user's sessions grouped as *Waiting on you / Running / Done*, plus an inbox of unread notifications.

### Tasks
- [ ] `GET /notifications?unread=true` and `POST /notifications/:id/read`, plus a `notification:new` socket event to the user's personal room
- [ ] "Waiting on you" = sessions with unread notifications or pending approvals the user can resolve
- [ ] UI: grouped session cards (title, status, Owner, avatars, last activity), an inbox dropdown, and a New Session button

### Test scenarios
- **e2e:** an approval request creates an unread notification for the right user, and it appears in `GET /notifications?unread=true`
- **e2e:** marking it read removes it from the unread list. Another user's notification returns 404.
- **Manual:** when the agent requests approval, Maya's Home shows the session under "Waiting on you" live
- **Manual:** clicking an inbox item opens the session at the relevant timeline item

---

## T30 · Doc comments as anchored suggestions
Labels: area:web, area:api, type:feature
Milestone: Day 3
Cut-able

### Description
Select text in the doc, then "Comment." The comment is stored as a `Message(mode=COMMENT)` anchored to the section and the quoted text. The agent treats it as a suggestion for that section (T16).

### Tasks
- [ ] A Tiptap bubble menu with a "Comment" action. The anchor is `{ sectionId, quote, relative positions }`.
- [ ] Comment highlights in the doc, plus a side thread showing the agent's response
- [ ] Viewers can comment too. In the queue, comments get lower priority than Editor input.

### Test scenarios
- **e2e:** posting a COMMENT with an anchor stores the anchor JSON. A Viewer posting COMMENT gets 201.
- **e2e (mock):** a queued COMMENT is passed to the agent with its quote and section
- **Manual:** commenting "be more skeptical" on a paragraph shows a highlight, and the agent's reply appears in the thread

---

## T31 · Mark final, Done state, timeline replay
Labels: area:api, area:web, type:feature
Milestone: Day 3

### Description
When the plan is finished, the agent requests `MARK_FINAL`. Approving it:
- sets status DONE and `completedAt`
- makes the doc read-only for everyone
- stops the runner

Done sessions remain a full record, with a replay slider that steps through the timeline.

### Tasks
- [ ] MARK_FINAL approval handling. Rejecting it requires a note, which becomes a SUGGEST so the agent keeps revising.
- [ ] Hocuspocus treats DONE sessions as read-only for every role
- [ ] UI: a Done banner, plus a timeline replay slider that highlights each event (doc snapshots aren't required)

### Test scenarios
- **e2e:** approving MARK_FINAL sets status DONE and completedAt, and doc writes from an Editor client are rejected
- **e2e:** rejecting with a note creates a QUEUED SUGGEST, and the agent resumes
- **e2e:** messages posted to a DONE session get 409 (except Ask, which still gets an answer)
- **Manual:** the replay slider steps through events in order

---

## T32 · Demo polish and full run-through
Labels: area:testing, type:chore
Milestone: Day 3

### Description
Prepare the 3-minute demo and do a full manual regression of the main flows.

### Tasks
- [ ] Demo seed script: users and an empty session ready to start
- [ ] Polish: loading and empty states, error toasts, consistent spacing, both themes
- [ ] Record a backup demo video
- [ ] README: setup, environment variables, the free model setup (Groq key or Ollama), and the demo script

### Test scenarios (manual: full demo script with three browsers)
- [ ] Maya creates the session, approves the outline, and writing begins
- [ ] Leo joins and suggests, and the agent acknowledges Leo by name and adapts
- [ ] Raj's input conflicts with Maya's, the conflict card appears, Maya resolves it, and the decision is pinned
- [ ] Leo edits a paragraph, and it shows as protected
- [ ] Maya hands off to Leo with a briefing
- [ ] Dana joins as a Viewer, gets a catch-up card, asks "Why is Notion first?", and gets an answer
- [ ] Mark final, and the session is Done
- [ ] `npm run test:e2e` passes in full
