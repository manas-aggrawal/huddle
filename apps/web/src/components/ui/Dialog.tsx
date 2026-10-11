import { type ReactNode, useEffect, useRef } from 'react';
import { XIcon } from './icons';

/** A modal on the native <dialog>: focus trap, Esc to close and a backdrop for free. */
export function Dialog({
	open,
	onClose,
	title,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const d = ref.current;
		if (!d) return;
		if (open && !d.open) d.showModal();
		if (!open && d.open) d.close();
	}, [open]);

	return (
		<dialog
			ref={ref}
			onClose={onClose}
			onClick={(e) => {
				if (e.target === ref.current) onClose(); // click on the backdrop
			}}
			className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-ink shadow-card backdrop:bg-black/40"
		>
			{open && (
				<div className="p-5">
					<div className="flex items-center justify-between gap-3">
						<h2 className="text-lg font-semibold">{title}</h2>
						<button
							type="button"
							onClick={onClose}
							aria-label="Close"
							className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
						>
							<XIcon />
						</button>
					</div>
					<div className="mt-4">{children}</div>
				</div>
			)}
		</dialog>
	);
}
