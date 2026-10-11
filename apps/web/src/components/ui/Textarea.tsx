import { forwardRef, type TextareaHTMLAttributes, useId } from 'react';
import { cx } from './cx';

export interface TextareaProps
	extends TextareaHTMLAttributes<HTMLTextAreaElement> {
	label: string;
	hint?: string;
	error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
	function Textarea({ label, hint, error, className, id, ...rest }, ref) {
		const autoId = useId();
		const inputId = id ?? autoId;
		const noteId = `${inputId}-note`;
		return (
			<div className={cx('flex flex-col gap-1.5', className)}>
				<label htmlFor={inputId} className="text-sm font-medium">
					{label}
				</label>
				<textarea
					ref={ref}
					id={inputId}
					aria-invalid={error ? true : undefined}
					aria-describedby={error || hint ? noteId : undefined}
					className={cx(
						'min-h-20 rounded-lg border bg-surface px-3 py-2 text-sm text-ink outline-none transition',
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
	},
);
