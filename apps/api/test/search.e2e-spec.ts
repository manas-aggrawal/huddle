import { ApprovalKind, ApprovalStatus, EventType } from '@huddle/shared';
import { SearchService } from '@src/research/search.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import { type FixtureServer, startFixtureServer } from './utils/fixture-server';
import { E2EContext, setupE2E } from './utils/setup';

describe('web_search through SearXNG', () => {
	const agent = agentHarness({ research: true });
	let ctx: E2EContext<'maya'>;
	let web: FixtureServer;
	let search: SearchService;

	beforeAll(async () => {
		web = await startFixtureServer();
		ctx = await setupE2E({ users: ['maya'], overrides: agent.overrides });
		search = ctx.app.get(SearchService);
	});
	afterAll(async () => {
		await ctx.close();
		await web.close();
	});

	it('search() returns normalized results from SearXNG JSON', async () => {
		search.configure({ baseUrl: web.url, timeoutMs: 2000 });
		const results = await search.search('obsidian pricing');
		expect(results).toEqual([
			{
				title: 'Obsidian pricing',
				url: `${web.url}/articles/obsidian-pricing`,
				snippet: 'Plans and pricing for Obsidian, matching "obsidian pricing".',
			},
			{
				title: 'A page crawlers may not read',
				url: `${web.url}/private/secret`,
				snippet: 'Disallowed by robots.txt.',
			},
		]);
	});

	it('the same query within 10 minutes is served from the cache', async () => {
		search.configure({ baseUrl: web.url, timeoutMs: 2000 });
		const before = web.hits('/search');
		await search.search('Bear app pricing');
		await search.search('bear app pricing ');
		expect(web.hits('/search') - before).toBe(1);
	});

	/** One section, with a research call that searches once and then writes notes. */
	async function runOneSection(query: string) {
		agent.script([
			{ text: outlineReply('Pricing') },
			{ toolCalls: [{ toolName: 'web_search', input: { query } }] },
			{ text: '- Obsidian is free for personal use [web]' },
			{ text: 'Obsidian is free for personal use.' },
		]);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Search', goal: 'Compare note app pricing' })
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
			{ what: 'the section to finish', timeoutMs: 8000 },
		);
		return id;
	}

	it('when the model calls web_search, a TOOL_CALL event records the query and result count', async () => {
		search.configure({ baseUrl: web.url, timeoutMs: 2000 });
		const id = await runOneSection('obsidian pricing 2026');
		const call = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: id, type: EventType.TOOL_CALL },
		});
		expect(call.payload).toMatchObject({
			tool: 'web_search',
			query: 'obsidian pricing 2026',
			resultCount: 2,
		});
		// The model got the results back, and the notes reached the writing step.
		expect(agent.model.promptText(2)).toContain('Obsidian pricing');
		expect(agent.model.promptText(3)).toContain(
			'Obsidian is free for personal use [web]',
		);
	});

	it('a search that never answers times out; the tool says so and the section still completes', async () => {
		web.route('/search', () => {
			// never responds
		});
		search.configure({ baseUrl: web.url, timeoutMs: 300 });
		const id = await runOneSection('something slow');
		const call = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: id, type: EventType.TOOL_CALL },
		});
		expect(call.payload).toMatchObject({
			tool: 'web_search',
			resultCount: 0,
			error: 'it timed out',
		});
		expect(agent.model.promptText(2)).toContain('Search failed (it timed out)');
		const step = await testPrisma.planStep.findFirstOrThrow({
			where: { sessionId: id },
		});
		expect(step.status).toBe('DONE');
	});
});
