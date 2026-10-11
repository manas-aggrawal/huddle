import type { ReactNode } from 'react';
import { cx } from '../ui';

/** A titled column of the room. Scrolls on its own on wide screens. */
export function Pane({
	title,
	aside,
	children,
	className,
	bodyClassName,
}: {
	title: string;
	aside?: ReactNode;
	children: ReactNode;
	className?: string;
	bodyClassName?: string;
}) {
	return (
		<section
			aria-label={title}
			className={cx('flex min-h-0 min-w-0 flex-col bg-surface', className)}
		>
			<div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
				<h2 className="text-xs font-semibold tracking-wide text-muted uppercase">
					{title}
				</h2>
				{aside}
			</div>
			<div className={cx('min-h-0 flex-1', bodyClassName)}>{children}</div>
		</section>
	);
}
