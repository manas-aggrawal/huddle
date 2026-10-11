import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cx } from './cx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
	primary: 'bg-accent text-accent-ink hover:opacity-90',
	secondary: 'bg-surface text-ink border border-line hover:bg-surface-2',
	ghost: 'text-ink hover:bg-surface-2',
	danger: 'bg-danger text-white hover:opacity-90',
};

const SIZES: Record<Size, string> = {
	sm: 'h-8 px-3 text-sm',
	md: 'h-10 px-4 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: Variant;
	size?: Size;
	/** Shows a spinner and blocks clicks while a request is in flight. */
	loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
	function Button(
		{
			variant = 'primary',
			size = 'md',
			loading,
			disabled,
			className,
			children,
			...rest
		},
		ref,
	) {
		return (
			<button
				ref={ref}
				type="button"
				disabled={disabled || loading}
				className={cx(
					'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition',
					'disabled:cursor-not-allowed disabled:opacity-60',
					VARIANTS[variant],
					SIZES[size],
					className,
				)}
				{...rest}
			>
				{loading && (
					<span
						aria-hidden
						className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
					/>
				)}
				{children}
			</button>
		);
	},
);
