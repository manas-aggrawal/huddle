import { cx } from './cx';

export function Switch({
	checked,
	onChange,
	label,
	busy,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
	busy?: boolean;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={busy}
			onClick={() => onChange(!checked)}
			className={cx(
				'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:opacity-60',
				checked ? 'bg-accent' : 'bg-line',
			)}
		>
			<span
				className={cx(
					'inline-block size-4 rounded-full bg-white shadow transition',
					checked ? 'translate-x-4.5' : 'translate-x-0.5',
				)}
			/>
		</button>
	);
}
