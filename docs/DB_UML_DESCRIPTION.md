# Huddle: How the Data Fits Together

*A product brief for whoever designs the database. It describes how the product works and what it needs to remember. Someone reading only this should be able to draw the data model from scratch. Compare their drawing with the [interactive diagram](https://claude.ai/artifact/4hxvHJfZG7qekpRBCc5TcU) to check that the diagram is right.*

---

## 1. People and teams

Everyone who uses Huddle has an **account**. We know their username and email (both unique, since people log in with either), their first and last name, and a password. On screen, each person shows up as their initials in a colored circle. We don't store either: initials come from their name, and the color is picked from their account id, so it's always the same for the same person. There's also an app-wide role. An admin operates Huddle itself, and a standard user is everyone else. It comes from the boilerplate and has nothing to do with the roles people have inside a session.

People work in **teams**, which we call workspaces. A workspace has a name. A person can belong to several workspaces, and a workspace has many people. For each pairing we record whether the person is a workspace admin or a regular member, and when they joined. A person can only be in a given workspace once.
- **Workspace admins** manage members, the token pool and billing, and can delete the workspace.
- **Members** create sessions and use the pool.

When someone signs up, we automatically create a personal workspace for them and make them its admin. In the MVP that's the only kind of workspace, so workspace roles don't do anything yet.

**The token pool.** The workspace pays for the AI. It has a token allowance for each billing period, the date the current period started, and how many tokens all of its sessions have used so far in that period. Every session in the workspace draws from this one shared pool, no matter who created the session or who owns it now. Handing a session to someone else never changes who pays.

## 2. The session: the room where the work happens

The center of the product is the **session**. A session belongs to exactly one workspace, and a workspace can hold many sessions. Any member of a workspace can start a session there, and whoever starts it becomes its Owner. A session has:
- a title and a goal, such as "Competitive analysis of the top 5 note-taking apps"
- a status: planning, running, waiting on a human, paused, or done
- what the agent is doing right now: idle, thinking, researching, or writing
- the model it uses (which provider, which model) and the effort level (low, medium or high)
- how many tokens it has used so far, plus an optional cap so one session can't drain the workspace's pool
- when it was created and when it was finished, if it is

We don't store who created the session on the session itself. The first timeline event already records that.

When a session's status is "waiting on a human," it's because an approval is pending. The two always change together, in the same step.

**Who's in the room.** People join sessions. A person can be in many sessions, and a session has many people. Each person in a session has exactly one role there:
- **Owner:** in charge
- **Editor:** can steer
- **Viewer:** can only watch and ask questions

**A session always has exactly one Owner,** never zero and never two. Editors can approve things only if the Owner has allowed it, so we store an "allowed to approve" flag per person per session. The flag can only be turned on for Editors, because Owners can always approve and Viewers never can. We also track the last timeline event each person has seen, which is what powers "Since you were last here…". A person appears only once per session.

**Getting people in.** The Owner creates **invite links**. Each link belongs to one session and grants one role. An Editor link is an invitation, and a Viewer link is a share link. A link has a unique random token, records which person created it, and counts how many times it's been used. It can have an expiry date, and it can be revoked. A session can have many links.

**The document.** Each session has one shared **document**, the thing the team and agent are writing. The document's content is not stored as normal columns. The live co-editing engine (Yjs) keeps it, and we save a binary snapshot of it, one per session, along with when it was last saved. A session might not have a snapshot yet if nobody has written anything. Which person wrote which text is tracked inside that snapshot, not in the database.

**Handing off.** The Owner can hand the session to another member. Each handoff is recorded with who handed off, who received it, the briefing the agent wrote for the new Owner, an optional personal note, and when it happened. A session can have many handoffs over its life, which gives the full ownership history.

## 3. The agent's work

**The plan.** The agent breaks the goal into **plan steps**. Each step belongs to one session, and a session has many steps. A step has:
- a position in the order
- a title and an optional description
- a status: pending, in progress, done, skipped, or blocked
- whether it needs approval before the agent starts it
- which section of the document it writes into

People can add steps too, so we record who created each step. When the agent proposed it, there's no creator.

**People talking to the agent.** Everything a person tells the agent is a **message**. A message belongs to one session and is written by one person. It has a mode:
- **Suggest:** "do this when you get a chance"
- **Interrupt:** "stop now"
- **Ask:** a question that shouldn't change course
- **Comment:** attached to a highlighted piece of the document, so we store where in the document it's anchored

A message can be about a specific plan step, but doesn't have to be. Messages form a queue the agent works through, so each one has a status:
- **Queued**
- **Acknowledged**
- **Applied** or **declined**
- **Answered** (for questions)

We also store the agent's reply and when it processed the message.

**Approvals.** Sometimes the agent must stop and get permission:
- approving the outline
- rewriting text a human wrote
- marking the doc final
- going over budget
- anything a human flagged as "needs approval"

Each of these is an **approval request**. It belongs to one session and is optionally tied to one plan step. It has a kind, a title, some details (such as the before and after text for a rewrite), a status (pending, approved, rejected or cancelled), and when it was requested. When someone resolves it, we record who, when, and an optional note. A plan step can have several approval requests over time.

**Conflicts.** When two people tell the agent contradictory things, the agent raises a **conflict**. A conflict belongs to one session and is optionally tied to the plan step it blocks. It has a summary of the disagreement, the resolution text, who resolved it (always the Owner), and when. A conflict counts as open until it has a resolution time, so there's no separate open/resolved field.

A conflict connects to the messages that caused it, usually two but possibly more. In principle, one message could be involved in more than one conflict, so this is many-to-many.

**Decisions (the session's memory).** Important outcomes are pinned as **decisions**, such as "Keep Evernote, but shorten it." A decision belongs to one session and has its text, who pinned it, when, and optionally when it was unpinned. A decision can come from one of three places:
- **a resolved conflict:** each conflict produces at most one decision
- **a resolved approval:** each approval produces at most one decision
- **typed in by hand**

So a decision optionally points to the one conflict or the one approval it came from, never both. Those links are the only record of its origin: a decision with neither link was typed in by hand. The agent re-reads every pinned decision before writing each section.

## 4. The timeline: what happened, in order

Everything that happens in a session is written to its **timeline** as an **event**. Examples:
- the session was created
- someone joined or changed role
- a message was sent, and the agent acknowledged it
- a step started or finished
- the plan changed
- the agent searched the web or read a page
- an approval was requested or resolved
- a conflict was raised or resolved
- a decision was pinned
- a handoff happened
- the model was changed
- the budget ran low
- someone edited the doc

Each event belongs to one session. It has a type, says who did it (a person, the agent, or the system), points to the person when there is one, and carries a bundle of details that depend on the type.

**Events are never edited or deleted, only added.** Each session numbers its events 1, 2, 3… with no gaps and no repeats, and no two events in a session share a number. This numbering is what lets a browser that lost its connection say "give me everything after event 41." It's also how catch-up works: a person's "last seen" number is compared with the newest one. The session itself remembers the latest number it handed out, so the next number can be given out safely even when many things happen at once.

The timeline is history, and the other records (messages, approvals, steps) are the current state. An event mentions the record it's about, for example "Leo's message #abc was acknowledged," and keeps a copy of the display details it needs, so the timeline can be shown without looking anything up.

## 5. Research

When the agent reads a web page, we remember it as a **source** for that session, with its URL, title, and when it was fetched, so the document can cite it. A session cites many pages, but the same page only once per session.

Separately, the scraper keeps a **page cache** for each workspace. A page read for one session doesn't have to be fetched again for another session in the same team. Teams never share cached content with each other. A workspace has many cached pages, and within a workspace each page is identified by a hash of its URL. A cached page stores the original URL, the final URL after redirects, the title, the extracted text, the HTTP status, when it was fetched, and when it expires (after 24 hours). The cache is purely a speed-up and can be wiped anytime, which is why sources keep their own copy of the URL and title.

## 6. Cost and the inbox

**Usage.** Every time the agent calls a model, we record a **usage entry**: which session, which provider and model, what the call was for (such as writing a section or answering a question), the input and output tokens, and when. A session has many usage entries. Both the session and its workspace keep running totals. Before every call we check the workspace's pool first, then the session's cap, without adding up the whole history.

**The inbox.** When something needs a specific person's attention, they get a **notification**:
- an approval they can resolve
- a question for them
- an @mention
- a conflict involving them
- a handoff to them

A notification belongs to one person and one session, and a person gets many notifications. It has a type, a short title, a pointer to the thing it's about (an approval, message, conflict or handoff), when it was created, and when it was read, if it has been.

## 7. What deletion means

- **Deleting a session** removes everything inside it: members, links, the document, plan, messages, approvals, conflicts, decisions, handoffs, timeline, sources, usage and notifications.
- **Deleting a workspace** removes its memberships, sessions and cached pages.
- **Removing a person** removes their memberships and notifications. We don't allow deleting someone who still has authored records (messages, handoffs, resolved approvals and so on). That history must stay intact.
- **If a plan step is deleted,** messages, approvals and conflicts that pointed to it stay, but lose the link.
- **If a conflict or approval is deleted,** a decision that came from it stays, but loses its origin.

## 8. What we deliberately don't store

- **Who's online, cursors, "typing…" indicators:** these change by the second and live only in memory.
- **The document's text and authorship:** kept by the co-editing engine and saved as a snapshot (section 2).

---

## Checklist for verifying the diagram

Each sentence should match exactly one line or constraint in the UML.

**People and teams**
1. A person can belong to many workspaces, and a workspace has many people. Each pairing has a role and appears only once.
2. A workspace has many sessions. A session belongs to exactly one workspace.
3. A workspace has one shared token pool (allowance, period start, used this period). Every session in it draws from that pool.

**Membership and access**

4. A person can be in many sessions, and a session has many people. Each pairing has one role and appears only once.
5. A session has exactly one Owner at any time. Only Editors can have the "allowed to approve" flag.
6. A session has many invite links. Each link belongs to one session and was created by one person.

**Session contents**

7. A session has zero or one document snapshot.
8. A session has many handoffs. Each handoff involves exactly two people: the one who handed off and the one who received it.
9. A session may have a spending cap. It has no stored creator (the first timeline event records who started it).

**Agent work**

10. A session has many plan steps. A step may have been created by a person, or by the agent (no creator).
11. A session has many messages. Each message has exactly one author and may be about one plan step.
12. A session has many approval requests. Each may be about one plan step and may have been resolved by one person.
13. A session has many conflicts. Each may block one plan step and may have been resolved by one person. It's open until it has a resolution time.
14. A conflict involves many messages, and a message can be part of many conflicts.
15. A session has many decisions. A decision comes from one conflict, one approval, or neither, never both. A conflict or approval produces at most one decision. There's no separate origin field.

**Timeline and research**

16. A session has many timeline events, numbered without gaps and unique within the session. An event may point to the person who did it.
17. A session has many sources, with each URL at most once per session.
18. A workspace has many cached pages. Within a workspace, each URL is cached at most once.

**Usage and inbox**

19. A session has many usage entries.
20. A person has many notifications. A session has many notifications. Each notification belongs to one of each.

---

## Appendix: Changes from the redundancy review

These were applied after the first review:

1. **A decision's origin** is no longer stored twice. The conflict or approval link is the only record, and a decision can't have both.
2. **A conflict's open/closed state** is no longer stored twice. A conflict is open until it has a resolution time.
3. **The session's creator** isn't stored on the session. The first timeline event records it.
4. **The "allowed to approve" flag** can only be set for Editors.
5. **"Waiting on a human"** stays as a session status, but it always changes in the same step as the approval that causes it.

Also changed:
- Avatar colors and initials are computed, not stored.
- Workspaces lost their URL slug.
- The token pool moved to the workspace, and sessions have an optional cap.
- The page cache is scoped to each workspace.

Kept on purpose:
- the running token totals (session and workspace)
- the latest event number
- display copies inside timeline events
- the agent's reply on the message
- the URL and title copied into sources
- the invite use count
- the finished-at time

Each one exists either for speed or because the original can disappear.

Open questions:
- Should the agent have its own person record?
- Should we keep document history for replay?
- How do we check the shape of event details?
- Per-member monthly token limits are deferred until teams exist.
