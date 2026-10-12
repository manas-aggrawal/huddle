import { BudgetExceededError, PoolExhaustedError } from '@src/llm/errors';
import { LlmService } from '@src/llm/llm.service';
import { LLM_PROVIDER_OVERRIDE, type ModelFactory } from '@src/llm/providers';
import { tool } from 'ai';
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { z } from 'zod';
import { testPrisma } from './utils/db';
import { type ScriptedModel, scriptedModel } from './utils/mock-llm';
import { E2EContext, setupE2E } from './utils/setup';

// Read once when env-vars loads, so it must be set before any app import.
vi.hoisted(() => {
	process.env.MODELS = 'ollama:qwen2.5:14b';
});

describe('LLM layer', () => {
	let ctx: E2EContext<'maya'>;
	let llm: LlmService;
	/** The mock the next call gets; each test scripts its own. */
	let mock: ScriptedModel;
	/** Which provider/model the service asked the factory for, in order. */
	const requested: string[] = [];
	const factory: ModelFactory = (provider, modelId) => {
		requested.push(`${provider}:${modelId}`);
		return mock.model;
	};

	beforeAll(async () => {
		ctx = await setupE2E({
			users: ['maya'],
			overrides: [{ provide: LLM_PROVIDER_OVERRIDE, useValue: factory }],
		});
		llm = ctx.app.get(LlmService);
	});
	afterAll(async () => {
		await ctx.close();
	});
	beforeEach(() => {
		requested.length = 0;
	});

	async function newSession(over: Record<string, unknown> = {}) {
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Note apps', goal: 'Compare note apps', ...over })
			.expect(201);
		return res.body.id as string;
	}

	const workspaceOf = async (sessionId: string) =>
		testPrisma.workspace.findFirstOrThrow({
			where: { sessions: { some: { id: sessionId } } },
		});

	/** Puts the workspace pool back to empty so earlier tests don't leak into later ones. */
	async function freshPool(sessionId: string) {
		const ws = await workspaceOf(sessionId);
		await testPrisma.workspace.update({
			where: { id: ws.id },
			data: {
				tokensUsedThisPeriod: 0,
				tokenAllowance: 2_000_000,
				periodStart: new Date(),
			},
		});
	}

	it('generate returns the scripted text and records the mock token counts', async () => {
		const id = await newSession();
		mock = scriptedModel([
			{ text: 'Notion leads on templates.', usage: { input: 42, output: 7 } },
		]);

		const res = await llm.generate({
			sessionId: id,
			purpose: 'outline',
			system: 'You are a research agent.',
			prompt: 'Draft an outline',
		});

		expect(res.text).toBe('Notion leads on templates.');
		expect(requested).toEqual(['groq:llama-3.3-70b-versatile']);
		const records = await testPrisma.usageRecord.findMany({
			where: { sessionId: id },
		});
		expect(records).toEqual([
			expect.objectContaining({
				provider: 'groq',
				model: 'llama-3.3-70b-versatile',
				purpose: 'outline',
				inputTokens: 42,
				outputTokens: 7,
			}),
		]);
		expect(mock.promptText(0)).toContain('You are a research agent.');
	});

	it('uses the session effort: LOW caps output at 1024 tokens and temperature 0.3', async () => {
		const id = await newSession({ effort: 'LOW' });
		mock = scriptedModel([{ text: 'ok' }]);
		await llm.generate({ sessionId: id, purpose: 'ack', prompt: 'hi' });
		expect(mock.calls[0]).toMatchObject({
			maxOutputTokens: 1024,
			temperature: 0.3,
		});
	});

	it('after 3 calls, session and workspace totals equal the sum of the UsageRecords', async () => {
		const id = await newSession();
		await freshPool(id);
		mock = scriptedModel([
			{ text: 'a', usage: { input: 10, output: 5 } },
			{ text: 'b', usage: { input: 20, output: 6 } },
			{ text: 'c', usage: { input: 30, output: 7 } },
		]);
		for (let i = 0; i < 3; i++) {
			await llm.generate({ sessionId: id, purpose: 'section', prompt: 'go' });
		}

		const records = await testPrisma.usageRecord.findMany({
			where: { sessionId: id },
		});
		const sum = records.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
		expect(sum).toBe(78);
		const session = await testPrisma.session.findUniqueOrThrow({
			where: { id },
		});
		expect(session.tokensUsed).toBe(78);
		expect((await workspaceOf(id)).tokensUsedThisPeriod).toBe(78);
	});

	it('two sessions in the same workspace draw from the same pool', async () => {
		const a = await newSession();
		const b = await newSession();
		await freshPool(a);
		mock = scriptedModel([
			{ text: 'a', usage: { input: 100, output: 0 } },
			{ text: 'b', usage: { input: 50, output: 0 } },
		]);
		await llm.generate({ sessionId: a, purpose: 'x', prompt: 'go' });
		await llm.generate({ sessionId: b, purpose: 'x', prompt: 'go' });

		expect((await workspaceOf(a)).id).toBe((await workspaceOf(b)).id);
		expect((await workspaceOf(a)).tokensUsedThisPeriod).toBe(150);
	});

	it('a session at its cap throws BudgetExceededError without calling the model; no cap is never stopped', async () => {
		const capped = await newSession({ tokenBudget: 1000 });
		await testPrisma.session.update({
			where: { id: capped },
			data: { tokensUsed: 1000 },
		});
		mock = scriptedModel([]);
		await expect(
			llm.generate({ sessionId: capped, purpose: 'x', prompt: 'go' }),
		).rejects.toBeInstanceOf(BudgetExceededError);
		await expect(
			llm.stream({ sessionId: capped, purpose: 'x', prompt: 'go' }),
		).rejects.toBeInstanceOf(BudgetExceededError);
		expect(mock.calls).toHaveLength(0);

		const uncapped = await newSession();
		await freshPool(uncapped);
		await testPrisma.session.update({
			where: { id: uncapped },
			data: { tokensUsed: 1_000_000 },
		});
		mock = scriptedModel([{ text: 'still going' }]);
		const res = await llm.generate({
			sessionId: uncapped,
			purpose: 'x',
			prompt: 'go',
		});
		expect(res.text).toBe('still going');
	});

	it('an exhausted workspace pool throws PoolExhaustedError even when the session is under its cap', async () => {
		const id = await newSession({ tokenBudget: 500_000 });
		const ws = await workspaceOf(id);
		await testPrisma.workspace.update({
			where: { id: ws.id },
			data: { tokenAllowance: 1000, tokensUsedThisPeriod: 1000 },
		});
		mock = scriptedModel([]);
		const call = llm.generate({ sessionId: id, purpose: 'x', prompt: 'go' });
		await expect(call).rejects.toBeInstanceOf(PoolExhaustedError);
		expect(mock.calls).toHaveLength(0);
		await freshPool(id);
	});

	it('a period over a month old is reset by the next call, which then succeeds', async () => {
		const id = await newSession();
		const ws = await workspaceOf(id);
		const longAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000);
		await testPrisma.workspace.update({
			where: { id: ws.id },
			data: {
				tokenAllowance: 1000,
				tokensUsedThisPeriod: 1000,
				periodStart: longAgo,
			},
		});
		mock = scriptedModel([
			{ text: 'fresh month', usage: { input: 3, output: 2 } },
		]);

		const res = await llm.generate({
			sessionId: id,
			purpose: 'x',
			prompt: 'go',
		});
		expect(res.text).toBe('fresh month');
		const after = await workspaceOf(id);
		expect(after.tokensUsedThisPeriod).toBe(5);
		expect(after.periodStart.getTime()).toBeGreaterThan(longAgo.getTime());
		await freshPool(id);
	});

	it('records each step of a tool loop, and checks the budget between steps', async () => {
		const id = await newSession({ tokenBudget: 100 });
		await freshPool(id);
		mock = scriptedModel([
			{
				toolCalls: [{ toolName: 'web_search', input: { query: 'obsidian' } }],
				usage: { input: 60, output: 50 },
			},
			{ text: 'never reached' },
		]);
		const tools = {
			web_search: tool({
				description: 'Search the web',
				inputSchema: z.object({ query: z.string() }),
				execute: async () => [{ title: 'Obsidian' }],
			}),
		};

		// Step 1 spends 110 of the 100-token cap, so step 2 is refused.
		await expect(
			llm.generate({ sessionId: id, purpose: 'research', prompt: 'go', tools }),
		).rejects.toThrow(BudgetExceededError);
		expect(mock.calls).toHaveLength(1);
		const session = await testPrisma.session.findUniqueOrThrow({
			where: { id },
		});
		expect(session.tokensUsed).toBe(110);
	});

	it('stream records usage when it finishes', async () => {
		const id = await newSession();
		await freshPool(id);
		mock = scriptedModel([
			{ text: 'one two three', usage: { input: 9, output: 3 } },
		]);
		const { result, usageRecorded } = await llm.stream({
			sessionId: id,
			purpose: 'section',
			prompt: 'count',
		});
		let text = '';
		for await (const delta of result.textStream) text += delta;
		await usageRecorded;

		expect(text).toBe('one two three');
		const records = await testPrisma.usageRecord.findMany({
			where: { sessionId: id },
		});
		expect(records).toEqual([
			expect.objectContaining({ inputTokens: 9, outputTokens: 3 }),
		]);
	});

	it('aborting a stream midway stops it, and its partial usage is still recorded', async () => {
		const id = await newSession();
		await freshPool(id);
		const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
		mock = scriptedModel([{ text: words, chunkDelayMs: 5 }]);
		const abort = new AbortController();
		const { result, usageRecorded } = await llm.stream({
			sessionId: id,
			purpose: 'section',
			prompt: 'write a lot',
			abortSignal: abort.signal,
		});

		let received = 0;
		try {
			for await (const _ of result.textStream) {
				if (++received === 5) abort.abort();
			}
		} catch {
			// Depending on timing the stream ends or throws an abort error; both are fine.
		}
		await usageRecorded;

		expect(received).toBeLessThan(200);
		const [record, ...rest] = await testPrisma.usageRecord.findMany({
			where: { sessionId: id },
		});
		expect(rest).toHaveLength(0);
		// The provider never reported usage, so it's estimated from the text that did arrive.
		expect(record.outputTokens).toBeGreaterThan(0);
		expect(record.outputTokens).toBeLessThan(words.length / 4);
		expect(record.inputTokens).toBeGreaterThan(0);
		const session = await testPrisma.session.findUniqueOrThrow({
			where: { id },
		});
		expect(session.tokensUsed).toBe(record.inputTokens + record.outputTokens);
	});

	it('uses the model the session is set to', async () => {
		const id = await newSession({
			modelProvider: 'ollama',
			modelId: 'qwen2.5:14b',
		});
		mock = scriptedModel([{ text: 'local' }]);
		await llm.generate({ sessionId: id, purpose: 'x', prompt: 'go' });
		expect(requested).toEqual(['ollama:qwen2.5:14b']);
		const record = await testPrisma.usageRecord.findFirstOrThrow({
			where: { sessionId: id },
		});
		expect(record).toMatchObject({ provider: 'ollama', model: 'qwen2.5:14b' });
	});

	it('GET /models returns only the default plus the models listed in env', async () => {
		const res = await ctx.as('maya').get('/models').expect(200);
		expect(
			res.body.map(
				(m: { provider: string; modelId: string }) =>
					`${m.provider}:${m.modelId}`,
			),
		).toEqual(['groq:llama-3.3-70b-versatile', 'ollama:qwen2.5:14b']);
	});
});
