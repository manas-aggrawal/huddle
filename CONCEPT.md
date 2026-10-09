# Huddle: Multiplayer AI Agents (Hackathon Concept)

> A team and an AI agent research and write a document together, live. Anyone can drop in, watch, steer, or take over.

Working name: **Huddle**. MVP use case: **shared research doc**. Control: **role-based** (Owner / Editor / Viewer).

---

## 1. Example session (the demo story)

**Goal:** "Competitive analysis of the top 5 note-taking apps"

**Cast:**
- Maya: PM, **Owner**
- Leo: designer, **Editor**
- Raj: engineer, **Editor**
- Dana: VP, **Viewer**

**Day 1**
1. **Start:** Maya creates the session, types the goal, and invites Leo and Raj. The agent proposes an outline: *Market overview → 5 app profiles → Feature matrix → Pricing → Recommendation*. Approval gate: Maya moves "Pricing" before "Feature matrix" and approves. The status becomes **Running**.
2. **Watch:** Leo opens the link. Leo sees the plan with step 2 active, the doc filling in live under "Notion," and Maya's avatar.
3. **Steer (Suggest):** Leo writes: "Include screenshots or UX notes for each app; design matters here." The agent finishes its paragraph, then replies: "Got it, Leo. Adding a UX notes subsection to each profile." The plan updates and the change is attributed to Leo.
4. **Conflict:** Raj suggests "Drop Evernote, it's irrelevant now." Maya had listed Evernote in the goal. The agent posts a conflict card tagging Raj and Maya and keeps writing the other sections. Maya resolves it: "Keep it, but shorten it." The decision is pinned to Session Memory.
5. **Human edit:** Leo rewrites the Obsidian intro by hand. The agent treats the paragraph as human-owned and won't overwrite it without asking.
6. **Handoff:** Maya signs off and hands ownership to Raj. Raj gets a briefing: goal, 3 of 7 steps done, 1 pinned decision, 0 open questions.

**Day 2**
7. **Catch-up:** Leo opens the session and sees: "Since you left: Pricing and Feature matrix are done. Raj approved the matrix format. The agent asks you: *Which 3 UX criteria should the recommendation weigh?*" Leo answers inline.
8. **Viewer:** Dana drops in, reads the doc, and asks the agent "Why is Notion ranked first?" The agent answers in the thread. Dana can't change the agent's course; the Ask button is the only control Dana gets.
9. **Finish:** The agent requests the "Mark final?" gate. Raj approves. The session moves to **Done** and stays as a replayable record of the whole process.

---

## 2. Screens

**A. Home (Mission Control)**
```
Huddle                                   [+ New session]
⚠ Waiting on you (1)   Competitive analysis — agent asks you a question
● Running (2)          Q3 pricing memo · Onboarding research
✓ Done (5)             ...
```

**B. Session room (the main screen)**
```
┌ Competitive analysis      ● Running   Owner: Raj   👤M 👤L 👤R 👁D  [Invite][Hand off] ┐
├ PLAN ───────────────┬ DOCUMENT (live) ─────────────────────────────┬ TIMELINE ──────────┤
│ ✓ Outline           │ ## 3. Obsidian                               │ 🤖 Wrote Notion §  │
│ ✓ Notion            │ [Leo edited ✎] Obsidian is a local-first...  │ 👤 Leo: add UX...   │
│ ▶ Obsidian   ✍      │ ▍agent typing…                               │ 🤖 Got it, Leo      │
│ ○ Pricing           │                                              │ ⚔ Conflict: Raj vs  │
│ ○ Matrix  🔒        │   💬 Leo: "more skeptical here"              │   Maya — [Resolve]  │
│ PINNED              │                                              │                    │
│ • Keep Evernote,    │                                              │ [Suggest▾] msg… ⏎  │
│   shortened         │                                              │                    │
└─────────────────────┴──────────────────────────────────────────────┴────────────────────┘
```

**C. Catch-up card** (shown when you rejoin): what's done, decisions made and by whom, questions waiting on you. [Jump to doc]

**D. Approval card** (appears in the timeline and the inbox): "Agent wants to: rewrite §3 (contains Leo's edits)". [Approve] [Reject] [Discuss]

**E. Handoff dialog:** pick the new Owner, see the briefing preview, add an optional note, then [Hand off].

**F. New session:** goal, optional files or links, invite teammates (Editor by default).

---

## 3. Agent behavior rules (multiplayer etiquette)

1. **Attribution:** every human input reaches the agent tagged with name and role. The agent addresses people by name.
2. **Suggestions queue up:** the agent doesn't break mid-thought. At the end of each section it reads the queue and acknowledges every item, saying how it applied it or why it didn't.
3. **Interrupt:** the agent stops right away, posts a revised plan (showing what changed), and continues.
4. **Ask:** the agent answers in a thread and doesn't change course. Viewers can use Ask.
5. **Doc comments** count as suggestions anchored to a section.
6. **Human text is protected:** paragraphs a person edited are marked human-owned. Rewriting them requires an approval gate.
7. **Conflicts:** when two instructions contradict each other, the agent posts a conflict card tagging both people and pauses only the affected section. The Owner resolves it.
8. **When to stop and ask:** outline approval, rewriting human text, real ambiguity, and marking final. Otherwise the agent keeps going.
9. **Memory:** resolved conflicts and approvals are auto-pinned as decisions, and the agent re-reads them before each section.
10. **Role enforcement:** Viewers can only Ask or comment. Editors can steer and edit. The Owner approves, resolves, invites, hands off, and ends.

---

## 4. Models and billing

**The workspace runs the agent, not a person.** Costs and model settings belong to the team workspace. If they followed the Owner, every handoff would switch who pays in the middle of a session.

**Personal subscriptions aren't used.** Plans like Claude Pro or ChatGPT Plus cover that company's own app and don't include API access. Apps like Huddle use API keys billed per token. Running a shared agent on one member's account would also leave that person paying for everyone, and the session would break when they leave.

**Long-term pricing (hybrid):**
- **Trial:** free credits on our API keys.
- **Paid plan:** a per-seat price with included usage, plus overage.
- **Bring your own key:** an admin pastes the company's own provider key, and costs go straight to that provider account.

**Limits:**
- Each session has a budget, and a cost meter is visible to everyone in the room.
- Going over budget triggers an approval gate: "This session reached $5. Owner, approve more?"

**Choosing the model:**
- The Owner picks the model and effort level (fast/cheap vs. deep) for each session. Editors can see the setting but can't change it.
- Switching models mid-session works, because the session's state lives outside the model: the doc, the timeline, the plan and the pinned decisions. The new model reads that state and continues.
- Teams aren't locked to one AI provider, which is a selling point.

**Hackathon version:**
- A free-tier provider while developing.
- One paid key for the demo, with a hard spending cap.
- A per-session token budget in the app.
- A model dropdown only the Owner can change.
- No payments.

---

## 5. Hackathon plan (3 days)

**Day 1: the room works**
- Create a session, share an invite link, assign roles
- Agent proposes an outline (gate), then writes sections that stream into the doc
- Live timeline and presence, synced across browsers

**Day 2: steering works**
- Suggest / Interrupt / Ask, with attribution and acknowledgments
- Approval gates, human edits protected, conflict cards, pinned decisions

**Day 3: time works + demo**
- Catch-up card, handoff with briefing, Home screen
- Polish, rehearse the 3-minute demo, record a backup video

**Cut list (if behind, cut in this order):** doc comments → Home screen → conflict detection (fake it with a manual "flag conflict" button) → interrupt (keep Suggest only).

**3-minute demo:** three browser windows (Maya, Leo, Dana).
1. Start the session and approve the outline.
2. Leo joins and suggests; the agent acknowledges Leo by name.
3. Show a conflict and resolve it.
4. Hand off to Leo.
5. Dana joins as Viewer and gets a catch-up card plus an answer.
6. Mark final.

---

## 6. Stack

- **Frontend:** React + Vite, Tiptap editor
- **Backend:** NestJS (WebSockets for timeline + presence)
- **Co-editing:** Yjs + Hocuspocus. The agent joins the doc as a server-side editor, so its typing streams live.
- **DB:** PostgreSQL + Prisma (JSONB for event payloads; pgvector later if ever needed)
- **AI:** Vercel AI SDK. Groq / Ollama (free) during development; a paid model only for demos.
- **Auth:** guest name + invite link for the MVP
- **Repo:** pnpm monorepo: `apps/web`, `apps/api`

## 7. Agent tools (our own, no paid search APIs)

- **`web_search(query)`:** runs the query through a self-hosted **SearXNG** (open-source metasearch, free) and returns titles, URLs and snippets
- **`read_page(url)`:** our scraper. It fetches the page, extracts the main content (Readability), and returns clean text. Playwright is the fallback for pages that need JavaScript to load. It also enforces timeouts, a size cap, a cache and robots.txt.
- **`write_section` / `edit_section`:** writes into the shared doc
- **Every tool call appears in the timeline** ("Searched 'Obsidian pricing'", "Read obsidian.md/pricing"), so the team sees the agent's research live. Sources are cited in the doc.
