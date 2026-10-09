import { readFileSync } from 'node:fs';
import {
	createServer,
	IncomingMessage,
	Server,
	ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

export interface FixtureServer {
	/** Base URL, e.g. http://127.0.0.1:53999 */
	url: string;
	/** Add or replace a route for this test. */
	route(path: string, handler: Handler): void;
	/** How many requests a path received, to assert caching (no second fetch). */
	hits(path: string): number;
	close(): Promise<void>;
}

const FIXTURES = join(__dirname, '..', 'fixtures');

export function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), 'utf8');
}

/** Respond with a body and content type. */
export function send(
	res: ServerResponse,
	body: string,
	contentType = 'text/html; charset=utf-8',
	status = 200,
): void {
	res.writeHead(status, { 'Content-Type': contentType });
	res.end(body);
}

/**
 * A local web server standing in for the internet in scraper and search tests.
 *
 * Default routes:
 * - `/robots.txt`: disallows `/private/`
 * - `/articles/obsidian-pricing`: an article page with nav and footer around the main text
 * - `/private/secret`: a page that robots.txt disallows
 * - `/search?q=…&format=json`: SearXNG-shaped JSON results pointing back at this server
 */
export async function startFixtureServer(): Promise<FixtureServer> {
	const routes = new Map<string, Handler>();
	const counts = new Map<string, number>();
	let base = '';

	routes.set('/robots.txt', (_req, res) =>
		send(res, 'User-agent: *\nDisallow: /private/\n', 'text/plain'),
	);
	routes.set('/articles/obsidian-pricing', (_req, res) =>
		send(res, fixture('obsidian-pricing.html')),
	);
	routes.set('/private/secret', (_req, res) =>
		send(res, '<html><body><p>Not for crawlers.</p></body></html>'),
	);
	routes.set('/search', (_req, res, url) => {
		const q = url.searchParams.get('q') ?? '';
		send(
			res,
			JSON.stringify({
				query: q,
				results: [
					{
						title: 'Obsidian pricing',
						url: `${base}/articles/obsidian-pricing`,
						content: `Plans and pricing for Obsidian, matching "${q}".`,
						engine: 'fixture',
					},
					{
						title: 'A page crawlers may not read',
						url: `${base}/private/secret`,
						content: 'Disallowed by robots.txt.',
						engine: 'fixture',
					},
				],
			}),
			'application/json',
		);
	});

	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', base);
		counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
		const handler = routes.get(url.pathname);
		if (handler) return handler(req, res, url);
		send(res, 'Not found', 'text/plain', 404);
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		url: base,
		route: (path, handler) => routes.set(path, handler),
		hits: (path) => counts.get(path) ?? 0,
		close: () =>
			new Promise((resolve, reject) => {
				server.closeAllConnections();
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}
