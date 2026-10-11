/** Where to go after logging in: the `next` query param, if it's a path inside this app. */
export function safeNext(search: string, fallback = '/'): string {
	const next = new URLSearchParams(search).get('next');
	// Only same-app paths: "/s/123" yes, "//evil.com" or "https://…" no.
	return next?.startsWith('/') && !next.startsWith('//') ? next : fallback;
}

export function loginPath(next: string): string {
	return `/login?next=${encodeURIComponent(next)}`;
}
