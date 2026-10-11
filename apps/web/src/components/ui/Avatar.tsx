import { cx } from './cx';

/** Stable hue from the user id, so a person has the same color everywhere (not stored). */
export function avatarHue(userId: string): number {
	let hash = 0;
	for (let i = 0; i < userId.length; i++)
		hash = (hash * 31 + userId.charCodeAt(i)) | 0;
	return Math.abs(hash) % 360;
}

export function avatarColor(userId: string): string {
	return `hsl(${avatarHue(userId)} 55% 45%)`;
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const letters =
		parts.length > 1
			? parts[0][0] + parts.at(-1)?.[0]
			: (parts[0] ?? '?').slice(0, 2);
	return letters.toUpperCase();
}

const SIZES = { sm: 'size-7 text-[11px]', md: 'size-9 text-xs' } as const;

export function Avatar({
	userId,
	name,
	size = 'md',
	dashed = false,
	typing = false,
	className,
}: {
	userId: string;
	name: string;
	size?: keyof typeof SIZES;
	/** Viewers get a dashed ring. */
	dashed?: boolean;
	/** Shows a small dot while the person is typing. */
	typing?: boolean;
	className?: string;
}) {
	return (
		<span
			className={cx('relative inline-flex shrink-0', className)}
			title={name}
		>
			<span
				className={cx(
					'inline-flex items-center justify-center rounded-full font-semibold text-white',
					SIZES[size],
					dashed && 'outline-2 outline-dashed outline-offset-2 outline-muted',
				)}
				style={{ backgroundColor: avatarColor(userId) }}
				aria-label={name}
			>
				{initials(name)}
			</span>
			{typing && (
				<span
					aria-label={`${name} is typing`}
					className="absolute -right-0.5 -bottom-0.5 size-2.5 animate-pulse rounded-full border-2 border-surface bg-accent"
				/>
			)}
		</span>
	);
}
