import { ApprovalKind, ApprovalStatus, EventType } from '@huddle/shared';
import { AgentDocWriter } from '@src/collab/agent-doc-writer.service';
import { ScrapeError, ScraperService } from '@src/research/scraper.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import {
	type FixtureServer,
	send,
	startFixtureServer,
} from './utils/fixture-server';
import { E2EContext, setupE2E } from './utils/setup';

describe('read_page scraper', () => {
	const agent = agentHarness({ research: true });
	let ctx: E2EContext<'maya' | 'raj'>;
	let web: FixtureServer;
	let scraper: ScraperService;
	let mayaWs: string;
	let rajWs: string;

	beforeAll(async () => {
		web = await startFixtureServer();
		ctx = await setupE2E({
			users: ['maya', 'raj'],
			overrides: agent.overrides,
		});
		scraper = ctx.app.get(ScraperService);
		scraper.configure({ allowHosts: ['127.0.0.1'] });
		const ws = async (userId: string) =>
			(await testPrisma.workspaceMember.findFirstOrThrow({ where: { userId } }))
				.workspaceId;
		mayaWs = await ws(ctx.users.maya.id);
		rajWs = await ws(ctx.users.raj.id);

		web.route('/huge', (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			const line = `${'x'.repeat(1023)}\n`;
			for (let i = 0; i < 5 * 1024; i++) res.write(line); // 5 MB
			res.end();
		});
		web.route('/hop1', (_req, res) => {
			res.writeHead(301, { Location: '/hop2' });
			res.end();
		});
		web.route('/hop2', (_req, res) => {
			res.writeHead(302, { Location: '/articles/obsidian-pricing' });
			res.end();
		});
		web.route('/paper.pdf', (_req, res) =>
			send(res, '%PDF-1.4 …', 'application/pdf'),
		);
		web.route('/logo.png', (_req, res) => send(res, 'PNG', 'image/png'));
	});
	afterAll(async () => {
		await ctx.close();
		await web.close();
	});

	const article = () => `${web.url}/articles/obsidian-pricing`;

	it('returns the article’s title and main text, without nav or footer', async () => {
		const page = await scraper.read(article(), mayaWs);
		expect(page.title).toBe(
			'Obsidian Pricing – Plans for individuals and teams',
		);
		expect(page.text).toContain('Obsidian is free for personal use');
		expect(page.text).toContain('A commercial license is required');
		expect(page.text).not.toContain('Download');
		expect(page.text).not.toContain('newsletter');
	});

	it('refuses a page robots.txt disallows', async () => {
		await expect(
			scraper.read(`${web.url}/private/secret`, mayaWs),
		).rejects.toThrow(/robots\.txt/);
	});

	it('refuses private and local addresses when they aren’t allowlisted', async () => {
		scraper.configure({ allowHosts: [] });
		try {
			for (const url of [
				'http://169.254.169.254/latest/meta-data',
				'http://localhost:5432/',
				'http://10.0.0.5/',
				'http://[::1]/',
			]) {
				await expect(scraper.read(url, mayaWs)).rejects.toThrow(
					/private network/,
				);
			}
			await expect(
				scraper.read('ftp://example.com/file', mayaWs),
			).rejects.toThrow(/http and https/);
		} finally {
			scraper.configure({ allowHosts: ['127.0.0.1'] });
		}
	});

	it('cuts a 5 MB response at 2 MB without crashing', async () => {
		const page = await scraper.read(`${web.url}/huge`, mayaWs);
		expect(page.text.length).toBeGreaterThan(10_000);
		expect(page.text.length).toBeLessThanOrEqual(12_001);
	});

	it('serves a second read within 24 hours from the workspace cache', async () => {
		const url = `${web.url}/articles/obsidian-pricing?v=cache`;
		const before = web.hits('/articles/obsidian-pricing');
		const first = await scraper.read(url, mayaWs);
		const second = await scraper.read(url, mayaWs);
		expect(first.fromCache).toBe(false);
		expect(second.fromCache).toBe(true);
		expect(second.text).toBe(first.text);
		expect(web.hits('/articles/obsidian-pricing') - before).toBe(1);
	});

	it('another workspace fetches again and gets its own cache entry', async () => {
		const url = `${web.url}/articles/obsidian-pricing?v=teams`;
		const before = web.hits('/articles/obsidian-pricing');
		await scraper.read(url, mayaWs);
		const raj = await scraper.read(url, rajWs);
		expect(raj.fromCache).toBe(false);
		expect(web.hits('/articles/obsidian-pricing') - before).toBe(2);
		const entries = await testPrisma.pageCache.findMany({ where: { url } });
		expect(entries.map((e) => e.workspaceId).sort()).toEqual(
			[mayaWs, rajWs].sort(),
		);
	});

	it('follows a redirect chain to the final URL', async () => {
		const page = await scraper.read(`${web.url}/hop1`, mayaWs);
		expect(page.finalUrl).toBe(article());
		expect(page.text).toContain('Obsidian is free');
	});

	it('refuses PDFs and images as unsupported content types', async () => {
		await expect(scraper.read(`${web.url}/paper.pdf`, mayaWs)).rejects.toThrow(
			/Unsupported content type \(application\/pdf\)/,
		);
		await expect(scraper.read(`${web.url}/logo.png`, mayaWs)).rejects.toThrow(
			ScrapeError,
		);
	});

	it('as an agent tool: records a Source at the final URL, a TOOL_CALL, and a numbered Sources list in the doc', async () => {
		agent.script([
			{ text: outlineReply('Pricing') },
			{
				toolCalls: [
					{ toolName: 'read_page', input: { url: `${web.url}/hop1` } },
				],
			},
			{
				toolCalls: [
					{ toolName: 'read_page', input: { url: `${web.url}/paper.pdf` } },
				],
			},
			{ text: '- Obsidian is free for personal use [1]' },
			{ text: 'Obsidian is free for personal use [1].' },
		]);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Read', goal: 'Compare pricing' })
			.expect(201);
		const id = res.body.id as string;
		const outline = await waitFor(() =>
			testPrisma.approval.findFirst({
				where: {
					sessionId: id,
					kind: ApprovalKind.OUTLINE,
					status: ApprovalStatus.PENDING,
				},
			}),
		);
		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${outline.id}`)
			.send({ decision: 'approve' })
			.expect(201);
		await waitFor(
			() =>
				testPrisma.approval.findFirst({
					where: { sessionId: id, kind: ApprovalKind.MARK_FINAL },
				}),
			{
				timeoutMs: 8000,
			},
		);

		const sources = await testPrisma.source.findMany({
			where: { sessionId: id },
		});
		expect(sources.map((s) => s.url)).toEqual([article()]);
		const calls = await testPrisma.timelineEvent.findMany({
			where: { sessionId: id, type: EventType.TOOL_CALL },
			orderBy: { seq: 'asc' },
		});
		expect(calls.map((c) => c.payload)).toEqual([
			expect.objectContaining({
				tool: 'read_page',
				url: article(),
				title: 'Obsidian Pricing – Plans for individuals and teams',
				source: 1,
			}),
			expect.objectContaining({
				tool: 'read_page',
				error: expect.stringContaining('Unsupported content type'),
			}),
		]);
		// The writing prompt lists the source for [n] citations.
		expect(agent.model.promptText(4)).toContain(
			`[1] Obsidian Pricing – Plans for individuals and teams — ${article()}`,
		);
		const doc = await ctx.app.get(AgentDocWriter).listSections(id);
		expect(doc.map((s) => s.title)).toEqual(['Pricing', 'Sources']);
		expect(doc[1].text).toBe(
			`[1] Obsidian Pricing – Plans for individuals and teams — ${article()}`,
		);
	});
});
