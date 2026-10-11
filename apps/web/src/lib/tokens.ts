// The logged-in user's tokens, kept in localStorage so a refresh keeps you
// logged in. Components subscribe through useTokens() (lib/auth.tsx).

export interface Tokens {
	accessToken: string;
	refreshToken: string;
}

const KEY = 'huddle.tokens';
const listeners = new Set<() => void>();
let current: Tokens | null = read();

function read(): Tokens | null {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<Tokens>;
		return parsed.accessToken && parsed.refreshToken
			? { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken }
			: null;
	} catch {
		return null;
	}
}

export function getTokens(): Tokens | null {
	return current;
}

export function setTokens(tokens: Tokens | null) {
	current = tokens;
	try {
		if (tokens) localStorage.setItem(KEY, JSON.stringify(tokens));
		else localStorage.removeItem(KEY);
	} catch {
		// Private mode or blocked storage: stay logged in for this tab only.
	}
	for (const l of listeners) l();
}

export function subscribeTokens(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

// Logging in or out in another tab applies here too.
window.addEventListener('storage', (e) => {
	if (e.key !== KEY) return;
	current = read();
	for (const l of listeners) l();
});
