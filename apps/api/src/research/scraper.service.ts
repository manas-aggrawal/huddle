import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { Injectable, Logger } from '@nestjs/common';
import { SCRAPER_ALLOW_HOSTS } from '@src/configs/env-vars';
import { PrismaService } from '@src/prisma/prisma.service';
import { JSDOM, VirtualConsole } from 'jsdom';

/** The bit of Playwright's API the fallback uses (it's an optional dependency). */
interface HeadlessBrowser {
	newPage(options: object): Promise<{
		goto(url: string, options: object): Promise<unknown>;
		content(): Promise<string>;
	}>;
	close(): Promise<void>;
}

/** Why a page couldn't be read. The message goes to the model as is. */
export class ScrapeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ScrapeError';
	}
}

export interface Page {
	/** Where it ended up after redirects. */
	finalUrl: string;
	title: string | null;
	/** Clean main text, cut to fit a prompt. */
	text: string;
	fromCache: boolean;
}

const USER_AGENT =
	'Mozilla/5.0 (compatible; HuddleBot/0.1; +https://github.com/manas-aggrawal/huddle)';
const ROBOTS_AGENT = 'huddlebot';
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** What the model gets from one page (about 3k tokens). */
export const PAGE_TEXT_MAX = 12_000;
const CACHE_MS = 24 * 3600_000;
/** Below this, plain fetching probably missed a script-rendered page. */
const SUSPICIOUSLY_SHORT = 200;

/** Private, loopback, link-local and other non-public addresses. */
function isPrivateAddress(address: string): boolean {
	if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice(7));
	if (isIP(address) === 4) {
		const [a, b] = address.split('.').map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			a >= 224
		);
	}
	const v6 = address.toLowerCase();
	return (
		v6 === '::' ||
		v6 === '::1' ||
		v6.startsWith('fc') ||
		v6.startsWith('fd') ||
		v6.startsWith('fe80')
	);
}

interface RobotsRules {
	allow: string[];
	disallow: string[];
}

/** The rules for our agent from a robots.txt: our own group if present, else "*". */
export function parseRobots(body: string): RobotsRules {
	const groups = new Map<string, RobotsRules>();
	let agents: string[] = [];
	let lastWasAgent = false;
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.replace(/#.*/, '').trim();
		const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
		if (!m) continue;
		const [, field, value] = m;
		const key = field.toLowerCase();
		if (key === 'user-agent') {
			if (!lastWasAgent) agents = [];
			agents.push(value.toLowerCase());
			for (const a of agents)
				if (!groups.has(a)) groups.set(a, { allow: [], disallow: [] });
			lastWasAgent = true;
			continue;
		}
		lastWasAgent = false;
		if (key !== 'allow' && key !== 'disallow') continue;
		for (const a of agents) {
			const g = groups.get(a);
			if (g && value) g[key].push(value);
		}
	}
	return (
		groups.get(ROBOTS_AGENT) ?? groups.get('*') ?? { allow: [], disallow: [] }
	);
}

/** Longest matching rule wins; Allow wins ties. `*` and `$` are supported. */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
	const match = (rule: string) => {
		const pattern = rule
			.replace(/[.+?^{}()|[\]\\]/g, '\\$&')
			.replace(/\*/g, '.*')
			.replace(/\\\$$/, '$');
		return new RegExp(`^${pattern}`).test(path);
	};
	const best = (rules_: string[]) =>
		Math.max(-1, ...rules_.filter(match).map((r) => r.length));
	const allow = best(rules.allow);
	const disallow = best(rules.disallow);
	return disallow === -1 || allow >= disallow;
}

/**
 * Reads a web page for the agent and returns its main text. Polite and safe:
 * respects robots.txt, refuses private addresses (SSRF) on every redirect hop,
 * stops at 2 MB and 10 s, and only reads HTML or plain text. Results are
 * cached per workspace for 24 hours, so teams never see each other's fetches.
 */
@Injectable()
export class ScraperService {
	private readonly logger = new Logger(ScraperService.name);
	private readonly robots = new Map<
		string,
		{ at: number; rules: RobotsRules }
	>();
	private allowHosts = new Set(
		(SCRAPER_ALLOW_HOSTS ?? '')
			.split(',')
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean),
	);

	constructor(private readonly prisma: PrismaService) {}

	/** For tests: hosts that skip the private-address check (the fixture server). */
	configure(options: { allowHosts?: string[] }) {
		if (options.allowHosts) {
			this.allowHosts = new Set(options.allowHosts.map((h) => h.toLowerCase()));
		}
		this.robots.clear();
	}

	async read(rawUrl: string, workspaceId: string): Promise<Page> {
		const url = this.parse(rawUrl);
		const urlHash = createHash('sha256').update(url.href).digest('hex');
		const cached = await this.prisma.pageCache.findUnique({
			where: { workspaceId_urlHash: { workspaceId, urlHash } },
		});
		if (cached && cached.expiresAt > new Date()) {
			return {
				finalUrl: cached.finalUrl,
				title: cached.title,
				text: cached.content,
				fromCache: true,
			};
		}

		const page = await this.fetchPage(url);
		await this.prisma.pageCache.upsert({
			where: { workspaceId_urlHash: { workspaceId, urlHash } },
			create: {
				workspaceId,
				urlHash,
				url: url.href,
				finalUrl: page.finalUrl,
				title: page.title?.slice(0, 300) ?? null,
				content: page.text,
				httpStatus: page.status,
				expiresAt: new Date(Date.now() + CACHE_MS),
			},
			update: {
				finalUrl: page.finalUrl,
				title: page.title?.slice(0, 300) ?? null,
				content: page.text,
				httpStatus: page.status,
				fetchedAt: new Date(),
				expiresAt: new Date(Date.now() + CACHE_MS),
			},
		});
		return {
			finalUrl: page.finalUrl,
			title: page.title,
			text: page.text,
			fromCache: false,
		};
	}

	private parse(raw: string): URL {
		let url: URL;
		try {
			url = new URL(raw.trim());
		} catch {
			throw new ScrapeError('That isn’t a valid URL');
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new ScrapeError('Only http and https pages can be read');
		}
		url.hash = '';
		return url;
	}

	/** Refuses hosts that resolve to private or local addresses (unless allowlisted for tests). */
	private async checkHost(url: URL) {
		const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
		if (this.allowHosts.has(host)) return;
		if (
			host === 'localhost' ||
			host.endsWith('.localhost') ||
			host.endsWith('.internal')
		) {
			throw new ScrapeError('Refused: that address is on a private network');
		}
		const addresses = isIP(host)
			? [host]
			: await lookup(host, { all: true })
					.then((r) => r.map((a) => a.address))
					.catch(() => {
						throw new ScrapeError(`Couldn’t resolve ${host}`);
					});
		if (addresses.some(isPrivateAddress)) {
			throw new ScrapeError('Refused: that address is on a private network');
		}
	}

	private async robotsAllow(url: URL): Promise<boolean> {
		const origin = url.origin;
		let entry = this.robots.get(origin);
		if (!entry || Date.now() - entry.at > CACHE_MS) {
			let rules: RobotsRules = { allow: [], disallow: [] };
			try {
				const res = await fetch(`${origin}/robots.txt`, {
					headers: { 'User-Agent': USER_AGENT },
					signal: AbortSignal.timeout(5000),
					redirect: 'follow',
				});
				if (res.ok) rules = parseRobots((await res.text()).slice(0, 100_000));
			} catch {
				// No robots.txt reachable: allowed, as crawlers treat it.
			}
			entry = { at: Date.now(), rules };
			this.robots.set(origin, entry);
		}
		return robotsAllows(entry.rules, `${url.pathname}${url.search}`);
	}

	private async fetchPage(start: URL) {
		let url = start;
		let res: Response | undefined;
		const signal = AbortSignal.timeout(TIMEOUT_MS);
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			await this.checkHost(url);
			if (!(await this.robotsAllow(url))) {
				throw new ScrapeError(
					'Refused: the site’s robots.txt doesn’t allow reading this page',
				);
			}
			try {
				res = await fetch(url, {
					redirect: 'manual',
					signal,
					headers: {
						'User-Agent': USER_AGENT,
						Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
					},
				});
			} catch (err) {
				const name = (err as Error).name;
				throw new ScrapeError(
					name === 'TimeoutError' || name === 'AbortError'
						? 'The page took too long to load'
						: `Couldn’t load the page: ${(err as Error).message}`,
				);
			}
			const location = res.headers.get('location');
			if (res.status >= 300 && res.status < 400 && location) {
				await res.body?.cancel();
				url = this.parse(new URL(location, url).href);
				continue;
			}
			break;
		}
		if (!res || (res.status >= 300 && res.status < 400)) {
			throw new ScrapeError('Too many redirects');
		}
		if (!res.ok) {
			await res.body?.cancel();
			throw new ScrapeError(`The page returned HTTP ${res.status}`);
		}
		const type = (res.headers.get('content-type') ?? '')
			.split(';')[0]
			.trim()
			.toLowerCase();
		if (
			type !== 'text/html' &&
			type !== 'text/plain' &&
			type !== 'application/xhtml+xml'
		) {
			await res.body?.cancel();
			throw new ScrapeError(
				`Unsupported content type (${type || 'unknown'}); only web pages and plain text can be read`,
			);
		}

		const raw = await this.readCapped(res);
		let { title, text } =
			type === 'text/plain'
				? { title: null, text: raw }
				: this.extract(raw, url.href);
		if (type !== 'text/plain' && text.length < SUSPICIOUSLY_SHORT) {
			const rendered = await this.renderWithBrowser(url.href);
			if (rendered && rendered.text.length > text.length)
				({ title, text } = rendered);
		}
		text = text.replace(/\n{3,}/g, '\n\n').trim();
		if (!text) throw new ScrapeError('The page has no readable text');
		return {
			finalUrl: url.href,
			title,
			text:
				text.length > PAGE_TEXT_MAX ? `${text.slice(0, PAGE_TEXT_MAX)}…` : text,
			status: res.status,
		};
	}

	/** Reads the body, stopping at 2 MB. */
	private async readCapped(res: Response): Promise<string> {
		const reader = res.body?.getReader();
		if (!reader) return '';
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const room = MAX_BYTES - size;
			chunks.push(value.length > room ? value.slice(0, room) : value);
			size += Math.min(value.length, room);
			if (size >= MAX_BYTES) {
				await reader.cancel();
				break;
			}
		}
		return new TextDecoder('utf-8', { fatal: false }).decode(
			Buffer.concat(chunks),
		);
	}

	/** Mozilla Readability: the article without navigation, ads and footers. */
	private extract(
		html: string,
		url: string,
	): { title: string | null; text: string } {
		const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
		try {
			const article = new Readability(dom.window.document).parse();
			const title =
				(article?.title || dom.window.document.title || '').trim() || null;
			const text = (
				article?.textContent ??
				dom.window.document.body?.textContent ??
				''
			)
				.split('\n')
				.map((l) => l.replace(/\s+/g, ' ').trim())
				.join('\n');
			return { title, text };
		} finally {
			dom.window.close();
		}
	}

	/**
	 * Fallback for script-rendered pages, when Playwright is installed
	 * (`npm i -w apps/api playwright && npx playwright install chromium`).
	 * Without it, the plain-fetch text is used.
	 */
	private async renderWithBrowser(
		url: string,
	): Promise<{ title: string | null; text: string } | null> {
		let playwright: { chromium: { launch(o: object): Promise<unknown> } };
		try {
			const name = 'playwright';
			playwright = await import(name);
		} catch {
			return null;
		}

		const browser = (await playwright.chromium.launch({
			headless: true,
		})) as HeadlessBrowser;
		try {
			const page = await browser.newPage({ userAgent: USER_AGENT });
			await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT_MS });
			return this.extract(await page.content(), url);
		} catch (err) {
			this.logger.warn(
				`Browser render failed for ${url}: ${(err as Error).message}`,
			);
			return null;
		} finally {
			await browser.close();
		}
	}
}
