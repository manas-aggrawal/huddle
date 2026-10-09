// Tests for the test harness itself, so later tickets can trust it.
import {
	ConnectedSocket,
	MessageBody,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer,
} from '@nestjs/websockets';
import { generateText, streamText, tool } from 'ai';
import { Server, Socket as ServerSocket } from 'socket.io';
import { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testPrisma } from './utils/db';
import { FixtureServer, startFixtureServer } from './utils/fixture-server';
import { scriptedModel } from './utils/mock-llm';
import { E2EContext, setupE2E } from './utils/setup';
import { connectSocket, expectNoEvent, waitForEvent } from './utils/socket';

/** Test-only gateway: broadcasts whatever it receives to every client. */
@WebSocketGateway()
class EchoGateway {
	@WebSocketServer() server!: Server;

	@SubscribeMessage('shout')
	shout(@MessageBody() text: string, @ConnectedSocket() from: ServerSocket) {
		this.server.emit('heard', { text, token: from.handshake.auth.token });
	}
}

describe('e2e harness', () => {
	let ctx: E2EContext<'maya' | 'leo'>;
	const sockets: Socket[] = [];

	beforeAll(async () => {
		ctx = await setupE2E({ users: ['maya', 'leo'], providers: [EchoGateway] });
	});

	afterAll(async () => {
		for (const s of sockets) s.close();
		await ctx.close();
	});

	it('starts each file with an empty database, then registers the requested users', async () => {
		const usernames = (await testPrisma.user.findMany()).map((u) => u.username);
		expect(usernames.sort()).toEqual(['leo00', 'maya0']);
	});

	it('gives each user a working token', async () => {
		const me = await ctx.as('maya').get('/users/me').expect(200);
		expect(me.body.username).toBe('maya0');
	});

	it('two users on two sockets both receive a broadcast, with their handshake token', async () => {
		const maya = await connectSocket(ctx.app, ctx.users.maya.token);
		const leo = await connectSocket(ctx.app, ctx.users.leo.token);
		sockets.push(maya, leo);

		const mayaGets = waitForEvent<{ text: string }>(maya, 'heard');
		const leoGets = waitForEvent<{ text: string; token: string }>(leo, 'heard');
		maya.emit('shout', 'hello room');

		expect((await mayaGets).text).toBe('hello room');
		const heard = await leoGets;
		expect(heard.text).toBe('hello room');
		expect(heard.token).toBe(ctx.users.maya.token);
	});

	it('waitForEvent times out instead of hanging; expectNoEvent passes on silence', async () => {
		const s = await connectSocket(ctx.app, ctx.users.leo.token);
		sockets.push(s);
		await expect(waitForEvent(s, 'never', undefined, 100)).rejects.toThrow(
			/Timed out/,
		);
		await expectNoEvent(s, 'heard', 100);
	});

	describe('scripted mock model', () => {
		it('returns scripted text and records the prompt', async () => {
			const mock = scriptedModel([{ text: 'Notion leads on templates.' }]);
			const res = await generateText({
				model: mock.model,
				prompt: 'Compare note apps',
			});
			expect(res.text).toBe('Notion leads on templates.');
			expect(res.usage.outputTokens).toBe(4);
			expect(mock.promptText(0)).toContain('Compare note apps');
			expect(mock.remaining()).toBe(0);
		});

		it('streams text in chunks', async () => {
			const mock = scriptedModel([{ text: 'one two three' }]);
			const result = streamText({ model: mock.model, prompt: 'count' });
			const chunks: string[] = [];
			for await (const delta of result.textStream) chunks.push(delta);
			expect(chunks).toEqual(['one ', 'two ', 'three']);
		});

		it('drives tool calls: the model calls a tool, then answers with its result', async () => {
			const mock = scriptedModel([
				{
					toolCalls: [
						{ toolName: 'web_search', input: { query: 'obsidian pricing' } },
					],
				},
				{ text: 'Obsidian is free for personal use.' },
			]);
			const searched: string[] = [];
			const res = await generateText({
				model: mock.model,
				prompt: 'What does Obsidian cost?',
				tools: {
					web_search: tool({
						description: 'Search the web',
						inputSchema: z.object({ query: z.string() }),
						execute: async ({ query }) => {
							searched.push(query);
							return [{ title: 'Obsidian pricing' }];
						},
					}),
				},
				stopWhen: ({ steps }) => steps.length >= 2,
			});
			expect(searched).toEqual(['obsidian pricing']);
			expect(res.text).toBe('Obsidian is free for personal use.');
			// The second call carried the tool result back to the model.
			expect(mock.promptText(1)).toContain('Obsidian pricing');
		});

		it('can make a call fail, and says so when the script runs out', async () => {
			const mock = scriptedModel([{ error: new Error('provider down') }]);
			await expect(
				generateText({ model: mock.model, prompt: 'x', maxRetries: 0 }),
			).rejects.toThrow(/provider down/);
			await expect(
				generateText({ model: mock.model, prompt: 'x', maxRetries: 0 }),
			).rejects.toThrow(/ran out of scripted steps/);
		});
	});

	describe('fixture web server', () => {
		let web: FixtureServer;
		beforeAll(async () => {
			web = await startFixtureServer();
		});
		afterAll(async () => {
			await web.close();
		});

		it('serves SearXNG-shaped search results that point back at itself', async () => {
			const res = await fetch(`${web.url}/search?q=obsidian&format=json`);
			const body = await res.json();
			expect(body.results[0]).toMatchObject({
				title: 'Obsidian pricing',
				url: `${web.url}/articles/obsidian-pricing`,
			});
		});

		it('serves pages and robots.txt, counts hits, and accepts custom routes', async () => {
			const page = await (
				await fetch(`${web.url}/articles/obsidian-pricing`)
			).text();
			expect(page).toContain('free for personal use');
			expect(await (await fetch(`${web.url}/robots.txt`)).text()).toContain(
				'Disallow: /private/',
			);
			expect(web.hits('/articles/obsidian-pricing')).toBe(1);

			web.route('/custom', (_req, res) => res.end('ok'));
			expect(await (await fetch(`${web.url}/custom`)).text()).toBe('ok');
		});
	});
});
