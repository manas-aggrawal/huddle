import { useEffect, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';
const KEY = 'huddle.theme';
const NEXT: Record<Theme, Theme> = {
	system: 'light',
	light: 'dark',
	dark: 'system',
};
const LABEL: Record<Theme, string> = {
	system: 'Theme: system',
	light: 'Theme: light',
	dark: 'Theme: dark',
};
const ICON: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' };

function stored(): Theme {
	try {
		const t = localStorage.getItem(KEY);
		return t === 'light' || t === 'dark' ? t : 'system';
	} catch {
		return 'system';
	}
}

/** Applies the saved theme before React renders, so there's no flash. */
export function applyStoredTheme() {
	apply(stored());
}

function apply(theme: Theme) {
	const root = document.documentElement;
	if (theme === 'system') root.removeAttribute('data-theme');
	else root.setAttribute('data-theme', theme);
}

export function ThemeToggle() {
	const [theme, setTheme] = useState<Theme>(stored);
	useEffect(() => {
		apply(theme);
		try {
			if (theme === 'system') localStorage.removeItem(KEY);
			else localStorage.setItem(KEY, theme);
		} catch {
			// Storage blocked: the choice lasts for this page only.
		}
	}, [theme]);
	return (
		<button
			type="button"
			onClick={() => setTheme(NEXT[theme])}
			title={LABEL[theme]}
			aria-label={LABEL[theme]}
			className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
		>
			<span aria-hidden>{ICON[theme]}</span>
		</button>
	);
}
