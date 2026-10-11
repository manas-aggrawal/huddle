import { EventType } from '@huddle/shared';
import { AgentDocWriter } from '@src/collab/agent-doc-writer.service';
import { fragmentOf } from '@src/collab/doc-structure';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createTestApp } from './utils/create-app';
import { testPrisma } from './utils/db';
import {
	connectDoc,
	DocClient,
	textOf,
	typeInto,
	typeSection,
	waitForDoc,
} from './utils/doc';
import { E2EContext, setupE2E } from './utils/setup';

type Name = 'maya' | 'leo' | 'dana' | 'sam';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Shared document server', () => {
	let ctx: E2EContext<Name>;
	let open: DocClient[] = [];

	beforeAll(async () => {
		ctx = await setupE2E({ users: ['maya', 'leo', 'dana', 'sam'] });
	});
	afterEach(() => {
		for (const c of open) c.close();
		open = [];
	});
	afterAll(async () => {
		await ctx.close();
	});

	async function connect(name: Name, sessionId: string, app = ctx.app) {
		const client = await connectDoc(app, ctx.users[name].token, sessionId);
		open.push(client);
		return client;
	}

	/** Maya (Owner), Leo (Editor), Dana (Viewer). Sam isn't a member. */
	async function team() {
		const s = (
			await ctx
				.as('maya')
				.post('/sessions')
				.send({ title: 'Competitive analysis', goal: 'Compare note apps' })
				.expect(201)
		).body.id as string;
		for (const [name, role] of [
			['leo', 'EDITOR'],
			['dana', 'VIEWER'],
		] as const) {
			const invite = await ctx
				.as('maya')
				.post(`/sessions/${s}/invites`)
				.send({ role })
				.expect(201);
			await ctx
				.as(name)
				.post(`/invites/${invite.body.token}/accept`)
				.expect(200);
		}
		return s;
	}

	const writer = () => ctx.app.get(AgentDocWriter);

	async function waitUntil(check: () => Promise<boolean>, timeoutMs = 2000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await check()) return;
			await sleep(25);
		}
		throw new Error(`Condition not met within ${timeoutMs}ms`);
	}

	/** Waits until the server's copy of a section reads `text` (client edits arrive asynchronously). */
	async function serverHas(s: string, sectionId: string, text: string) {
		const deadline = Date.now() + 2000;
		let last: string | null = null;
		while (Date.now() < deadline) {
			last = await writer()
				.getSectionText(s, sectionId)
				.catch(() => null);
			if (last === text) return;
			await sleep(25);
		}
		throw new Error(
			`Server has ${JSON.stringify(last)}, expected ${JSON.stringify(text)}`,
		);
	}

	describe('connecting', () => {
		it('lets members in, with Viewers read-only', async () => {
			const s = await team();
			expect((await connect('maya', s)).scope).toBe('read-write');
			expect((await connect('leo', s)).scope).toBe('read-write');
			expect((await connect('dana', s)).scope).toBe('readonly');
		});

		it('refuses a non-member, a bad token and a document that is not a session', async () => {
			const s = await team();
			await expect(connectDoc(ctx.app, ctx.users.sam.token, s)).rejects.toThrow(
				/Refused/,
			);
			await expect(connectDoc(ctx.app, 'not-a-jwt', s)).rejects.toThrow(
				/Refused/,
			);
			await expect(
				connectDoc(ctx.app, ctx.users.maya.token, 'some-other-doc'),
			).rejects.toThrow(/Refused/);
		});
	});

	describe('editing together', () => {
		it("two Editors: what Maya types shows up in Leo's copy", async () => {
			const s = await team();
			const maya = await connect('maya', s);
			const leo = await connect('leo', s);
			typeSection(
				maya.doc,
				's-intro',
				'Intro',
				'Five apps compared.',
				ctx.users.maya.id,
			);
			await waitForDoc(
				leo.doc,
				(d) => textOf(d, 's-intro') === 'Five apps compared.',
			);
		});

		it("a Viewer's local edits never reach the server or anyone else", async () => {
			const s = await team();
			const maya = await connect('maya', s);
			typeSection(
				maya.doc,
				's-intro',
				'Intro',
				'Real text.',
				ctx.users.maya.id,
			);
			const dana = await connect('dana', s);
			await waitForDoc(dana.doc, (d) => textOf(d, 's-intro') === 'Real text.');

			typeInto(dana.doc, 's-intro', ' Viewer scribble.', ctx.users.dana.id);
			typeSection(dana.doc, 's-dana', 'Dana', 'Nope.', ctx.users.dana.id);
			await sleep(300);

			expect(textOf(maya.doc, 's-intro')).toBe('Real text.');
			expect(textOf(maya.doc, 's-dana')).toBeNull();
			expect(await writer().getSectionText(s, 's-intro')).toBe('Real text.');
			const leo = await connect('leo', s);
			expect(textOf(leo.doc, 's-dana')).toBeNull();
		});
	});

	describe('saving', () => {
		it('saves when everyone leaves, and a later connection loads it from the database', async () => {
			const s = await team();
			const maya = await connect('maya', s);
			typeSection(
				maya.doc,
				's-intro',
				'Intro',
				'Saved text.',
				ctx.users.maya.id,
			);
			await serverHas(s, 's-intro', 'Saved text.');
			maya.close();
			open = [];
			await sleep(2500); // past the 2 s save debounce

			const row = await testPrisma.document.findUnique({
				where: { sessionId: s },
			});
			expect(row?.ydocState.length).toBeGreaterThan(0);

			const leo = await connect('leo', s);
			expect(textOf(leo.doc, 's-intro')).toBe('Saved text.');
		});

		it('saves while people are still editing, 2 s after the last change', async () => {
			const s = await team();
			const maya = await connect('maya', s);
			typeSection(
				maya.doc,
				's-intro',
				'Intro',
				'Still here.',
				ctx.users.maya.id,
			);
			await sleep(2500);
			// Maya is still connected; the snapshot is already in the database.
			const row = await testPrisma.document.findUnique({
				where: { sessionId: s },
			});
			expect(row).not.toBeNull();
		});

		it('the content survives a full API restart', async () => {
			const s = await team();
			// A separate API instance we can shut down without affecting the other tests.
			const first = await createTestApp();
			const maya = await connect('maya', s, first);
			typeSection(
				maya.doc,
				's-intro',
				'Intro',
				'Before restart.',
				ctx.users.maya.id,
			);
			const firstWriter = first.get(AgentDocWriter);
			await waitUntil(async () => {
				const text = await firstWriter
					.getSectionText(s, 's-intro')
					.catch(() => null);
				return text === 'Before restart.';
			});
			await firstWriter.appendToSection(s, 's-intro', ' Agent too.');
			await waitForDoc(
				maya.doc,
				(d) => textOf(d, 's-intro') === 'Before restart. Agent too.',
			);

			// Shut it down while Maya is still connected (well inside the save debounce),
			// then boot a fresh instance and read the document back.
			await first.close();
			const second = await createTestApp();
			try {
				const leo = await connectDoc(second, ctx.users.leo.token, s);
				expect(textOf(leo.doc, 's-intro')).toBe('Before restart. Agent too.');
				leo.close();
			} finally {
				await second.close();
			}
		});
	});

	describe('the agent writing', () => {
		it('appendToSection five times shows up in a connected client, in order', async () => {
			const s = await team();
			const leo = await connect('leo', s);
			await writer().insertSection(s, 's-pricing', 'Pricing');
			const chunks = [
				'Notion ',
				'charges ',
				'per seat. ',
				'Obsidian ',
				'is free.',
			];
			for (const c of chunks) await writer().appendToSection(s, 's-pricing', c);

			const expected = chunks.join('');
			await waitForDoc(leo.doc, (d) => textOf(d, 's-pricing') === expected);
			expect(await writer().getSectionText(s, 's-pricing')).toBe(expected);
		});

		it('starts a new paragraph on a blank line, and rejects unknown or duplicate sections', async () => {
			const s = await team();
			await writer().insertSection(s, 's-a', 'A');
			await writer().appendToSection(s, 's-a', 'First.\n\nSecond.');
			await writer().appendToSection(s, 's-a', ' More.');
			expect(await writer().getSectionText(s, 's-a')).toBe(
				'First.\n\nSecond. More.',
			);

			await expect(
				writer().appendToSection(s, 's-missing', 'x'),
			).rejects.toThrow(/not found/);
			await expect(writer().insertSection(s, 's-a', 'Again')).rejects.toThrow(
				/already exists/,
			);
		});

		it("returns the human-written parts of a section, and not the agent's", async () => {
			const s = await team();
			const maya = await connect('maya', s);
			typeSection(
				maya.doc,
				's-verdict',
				'Verdict',
				'Keep Evernote.',
				ctx.users.maya.id,
			);
			await serverHas(s, 's-verdict', 'Keep Evernote.');
			// The agent's text goes right after Maya's, and must not inherit her mark.
			await writer().appendToSection(s, 's-verdict', ' But shorten it.');
			const leo = await connect('leo', s);
			typeInto(leo.doc, 's-verdict', ' Leo agrees.', ctx.users.leo.id);
			await serverHas(
				s,
				's-verdict',
				'Keep Evernote. But shorten it. Leo agrees.',
			);
			expect(await writer().getHumanOwnedRanges(s, 's-verdict')).toEqual([
				{ userId: ctx.users.maya.id, text: 'Keep Evernote.', from: 0, to: 14 },
				{ userId: ctx.users.leo.id, text: ' Leo agrees.', from: 30, to: 42 },
			]);
		});
	});

	describe('DOC_EDITED timeline events', () => {
		const docEdits = (s: string) =>
			testPrisma.timelineEvent.findMany({
				where: { sessionId: s, type: EventType.DOC_EDITED },
				orderBy: { seq: 'asc' },
			});

		it('one per person per section per minute; agent edits make none', async () => {
			const s = await team();
			await writer().insertSection(s, 's-1', 'Pricing');
			await writer().insertSection(s, 's-2', 'Verdict');
			await writer().appendToSection(s, 's-1', 'Agent text.');
			const leo = await connect('leo', s);

			typeInto(leo.doc, 's-1', ' Edit one.', ctx.users.leo.id);
			await serverHas(s, 's-1', 'Agent text. Edit one.');
			typeInto(leo.doc, 's-1', ' Edit two.', ctx.users.leo.id);
			await serverHas(s, 's-1', 'Agent text. Edit one. Edit two.');
			typeInto(leo.doc, 's-2', 'Other section.', ctx.users.leo.id);
			await serverHas(s, 's-2', 'Other section.');
			await sleep(400); // events are written once the title settles (150 ms in tests)

			const events = await docEdits(s);
			expect(events.map((e) => e.payload)).toEqual([
				expect.objectContaining({ sectionId: 's-1', sectionTitle: 'Pricing' }),
				expect.objectContaining({ sectionId: 's-2', sectionTitle: 'Verdict' }),
			]);
			expect(events.every((e) => e.actorId === ctx.users.leo.id)).toBe(true);
			expect(events[0].payload).toMatchObject({
				actor: { id: ctx.users.leo.id, name: 'leo Tester' },
			});

			// More agent writing adds no events.
			await writer().appendToSection(s, 's-2', ' Agent again.');
			await sleep(400);
			expect(await docEdits(s)).toHaveLength(2);
		});

		it('records the section title as typed, not the empty heading of a brand-new section', async () => {
			const s = await team();
			const maya = await connect('maya', s);
			// The editor creates an empty heading first, then the title is typed into it.
			typeSection(maya.doc, 's-new', '', '', ctx.users.maya.id);
			await sleep(30);
			const heading = fragmentOf(maya.doc).get(0) as Y.XmlElement;
			(heading.get(0) as Y.XmlText).insert(0, 'Pricing', {
				human: { userId: ctx.users.maya.id },
			});
			await sleep(400);

			const events = await docEdits(s);
			expect(events).toHaveLength(1);
			expect(events[0].payload).toMatchObject({
				sectionId: 's-new',
				sectionTitle: 'Pricing',
			});
		});
	});

	describe('permission changes apply live', () => {
		it('after the Owner makes Leo a Viewer, he reconnects read-only and his edits stop reaching anyone', async () => {
			const s = await team();
			const maya = await connect('maya', s);
			const leo = await connect('leo', s);
			typeSection(leo.doc, 's-1', 'Notes', 'Leo was here.', ctx.users.leo.id);
			await waitForDoc(maya.doc, (d) => textOf(d, 's-1') === 'Leo was here.');

			const reauthenticated = new Promise<string>((resolve) =>
				leo.provider.on('authenticated', ({ scope }: { scope: string }) =>
					resolve(scope),
				),
			);
			await ctx
				.as('maya')
				.patch(`/sessions/${s}/members/${ctx.users.leo.id}`)
				.send({ role: 'VIEWER' })
				.expect(200);
			expect(await reauthenticated).toBe('readonly');

			typeInto(leo.doc, 's-1', ' Sneaky.', ctx.users.leo.id);
			await sleep(300);
			expect(textOf(maya.doc, 's-1')).toBe('Leo was here.');
		});

		it('after the Owner removes Dana, her connection is closed and she cannot get back in', async () => {
			const s = await team();
			const dana = await connect('dana', s);
			const refused = new Promise<void>((resolve) =>
				dana.provider.on('authenticationFailed', () => resolve()),
			);
			await ctx
				.as('maya')
				.delete(`/sessions/${s}/members/${ctx.users.dana.id}`)
				.expect(204);
			await refused;
			await expect(
				connectDoc(ctx.app, ctx.users.dana.token, s),
			).rejects.toThrow(/Refused/);
		});
	});
});
