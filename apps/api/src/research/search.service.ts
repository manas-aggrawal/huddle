import { Injectable, Logger } from '@nestjs/common';
import { SEARCH_TIMEOUT_MS, SEARXNG_URL } from '@src/configs/env-vars';

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const CACHE_MS = 10 * 60_000;
const MAX_CACHED = 500;

interface SearxngResponse {
	results?: { title?: string; url?: string; content?: string }[];
}

/**
 * Web search through our own SearXNG (JSON API). Results are cached in memory
 * for 10 minutes, so the agent re-asking the same thing costs nothing.
 */
@Injectable()
export class SearchService {
	private readonly logger = new Logger(SearchService.name);
	private readonly cache = new Map<
		string,
		{ at: number; results: SearchResult[] }
	>();
	private baseUrl = SEARXNG_URL;
	private timeoutMs = Number(SEARCH_TIMEOUT_MS) || 8000;

	/** For tests: point at a fixture server, shorten the timeout. */
	configure(options: { baseUrl?: string; timeoutMs?: number }) {
		if (options.baseUrl) this.baseUrl = options.baseUrl;
		if (options.timeoutMs) this.timeoutMs = options.timeoutMs;
		this.cache.clear();
	}

	/** Throws on network errors, timeouts and bad responses; the tool turns that into a message. */
	async search(query: string, { limit = 8 } = {}): Promise<SearchResult[]> {
		const key = `${limit}:${query.trim().toLowerCase()}`;
		const hit = this.cache.get(key);
		if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

		const url = new URL('/search', this.baseUrl);
		url.searchParams.set('q', query);
		url.searchParams.set('format', 'json');
		const res = await fetch(url, {
			signal: AbortSignal.timeout(this.timeoutMs),
			headers: { Accept: 'application/json' },
		});
		if (!res.ok) throw new Error(`search returned HTTP ${res.status}`);
		const body = (await res.json()) as SearxngResponse;
		const seen = new Set<string>();
		const results = (body.results ?? [])
			.filter((r): r is { title: string; url: string; content?: string } =>
				Boolean(r.url && r.title),
			)
			.filter((r) => !seen.has(r.url) && seen.add(r.url))
			.slice(0, limit)
			.map((r) => ({
				title: r.title.trim(),
				url: r.url,
				snippet: (r.content ?? '').trim().slice(0, 300),
			}));

		if (this.cache.size >= MAX_CACHED) {
			this.cache.delete(this.cache.keys().next().value as string);
		}
		this.cache.set(key, { at: Date.now(), results });
		return results;
	}
}
