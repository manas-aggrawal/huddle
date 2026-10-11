import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cx(
				'rounded-xl border border-line bg-surface shadow-card',
				className,
			)}
			{...rest}
		/>
	);
}
