import { forwardRef, type InputHTMLAttributes, useId } from 'react';
import { cx } from './cx';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
	label: string;
	hint?: string;
	error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
	{ label, hint, error, className, id, ...rest },
	ref,
) {
	const autoId = useId();
	const inputId = id ?? autoId;
	const noteId = `${inputId}-note`;
	return (
		<div className={cx('flex flex-col gap-1.5', className)}>
			<label htmlFor={inputId} className="text-sm font-medium">
				{label}
			</label>
			<input
				ref={ref}
				id={inputId}
				aria-invalid={error ? true : undefined}
				aria-describedby={error || hint ? noteId : undefined}
				className={cx(
					'h-10 rounded-lg border bg-surface px-3 text-sm text-ink outline-none transition',
					'placeholder:text-muted focus:border-focus',
					error ? 'border-danger' : 'border-line',
				)}
				{...rest}
			/>
			{(error || hint) && (
				<p
					id={noteId}
					className={cx('text-xs', error ? 'text-danger' : 'text-muted')}
				>
					{error ?? hint}
				</p>
			)}
		</div>
	);
});
