import type { ReactNode } from 'react';
import { cx } from './cx';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

const TONES: Record<BadgeTone, string> = {
	neutral: 'bg-surface-2 text-muted',
	accent: 'bg-accent-soft text-accent',
	ok: 'bg-ok-soft text-ok',
	warn: 'bg-warn-soft text-warn',
	danger: 'bg-danger-soft text-danger',
};

export function Badge({
	tone = 'neutral',
	children,
	className,
}: {
	tone?: BadgeTone;
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cx(
				'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
				TONES[tone],
				className,
			)}
		>
			{children}
		</span>
	);
}
