/** "obsidian.md/pricing" from a full URL, for compact link text. */
export function shortUrl(url: string): string {
	try {
		const u = new URL(url);
		const path = u.pathname.replace(/\/$/, '');
		return `${u.hostname.replace(/^www\./, '')}${path}`.slice(0, 60);
	} catch {
		return url.slice(0, 60);
	}
}

const linkClass =
	'truncate text-xs text-accent underline-offset-2 hover:underline';

/**
 * Under a TOOL_CALL row: the page that was read, or the top search results,
 * each opening in a new tab.
 */
export function ToolCallLinks({
	payload,
}: {
	payload: Record<string, unknown>;
}) {
	if (payload.error) return null;
	if (payload.tool === 'read_page' && typeof payload.url === 'string') {
		return (
			<p className="mt-0.5 flex min-w-0 items-center gap-1.5">
				{typeof payload.source === 'number' && (
					<span className="shrink-0 text-xs text-muted">
						[{payload.source}]
					</span>
				)}
				<a
					href={payload.url}
					target="_blank"
					rel="noreferrer noopener"
					className={linkClass}
				>
					{shortUrl(payload.url)}
				</a>
			</p>
		);
	}
	const results = Array.isArray(payload.results)
		? (payload.results as { title?: string; url?: string }[]).filter(
				(r) => r.url,
			)
		: [];
	if (payload.tool !== 'web_search' || results.length === 0) return null;
	return (
		<ul className="mt-0.5 flex min-w-0 flex-col">
			{results.slice(0, 3).map((r) => (
				<li key={r.url} className="min-w-0 truncate">
					<a
						href={r.url}
						target="_blank"
						rel="noreferrer noopener"
						className={linkClass}
						title={r.title}
					>
						{shortUrl(r.url as string)}
					</a>
				</li>
			))}
		</ul>
	);
}
