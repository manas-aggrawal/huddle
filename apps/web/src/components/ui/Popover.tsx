import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cx } from './cx';

/** A button that opens a panel below it. Closes on outside click and Esc. */
export function Popover({
	trigger,
	label,
	children,
	align = 'end',
	className,
}: {
	trigger: ReactNode;
	label: string;
	children: ReactNode | ((close: () => void) => ReactNode);
	align?: 'start' | 'end';
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!root.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false);
		};
		document.addEventListener('pointerdown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('pointerdown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	}, [open]);
	const close = () => setOpen(false);
	return (
		<div ref={root} className="relative">
			<button
				type="button"
				aria-label={label}
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="rounded-full"
			>
				{trigger}
			</button>
			{open && (
				<div
					role="dialog"
					aria-label={label}
					className={cx(
						'absolute top-full z-20 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-3 shadow-card',
						align === 'end' ? 'right-0' : 'left-0',
						className,
					)}
				>
					{typeof children === 'function' ? children(close) : children}
				</div>
			)}
		</div>
	);
}
