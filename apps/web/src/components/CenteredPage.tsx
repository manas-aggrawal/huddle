import type { ReactNode } from 'react';
import { Logo } from './AppHeader';
import { Card, ThemeToggle } from './ui';

/** Layout for login, register and invite: a single card in the middle of the page. */
export function CenteredPage({
	title,
	subtitle,
	children,
}: {
	title: string;
	subtitle?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex min-h-screen flex-col">
			<div className="flex items-center justify-between px-4 py-3">
				<Logo />
				<ThemeToggle />
			</div>
			<main className="flex flex-1 items-start justify-center px-4 pt-10 pb-16 sm:pt-20">
				<Card className="w-full max-w-sm p-6">
					<h1 className="text-xl font-semibold">{title}</h1>
					{subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
					<div className="mt-6">{children}</div>
				</Card>
			</main>
		</div>
	);
}

export function FormError({ message }: { message: string | null | undefined }) {
	if (!message) return null;
	return (
		<p
			role="alert"
			className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
		>
			{message}
		</p>
	);
}
