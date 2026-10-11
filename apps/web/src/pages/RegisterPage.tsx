import { type FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { CenteredPage, FormError } from '../components/CenteredPage';
import { Button, Input } from '../components/ui';
import { ApiError } from '../lib/api';
import { type RegisterInput, useAuth } from '../lib/auth';
import { safeNext } from '../lib/next';

type Field = keyof RegisterInput;
const EMPTY: RegisterInput = {
	firstname: '',
	lastname: '',
	username: '',
	email: '',
	password: '',
};

/** Splits the API's validation errors by field, so each shows under its input. */
function fieldErrors(err: unknown): Partial<Record<Field, string>> {
	if (!(err instanceof ApiError)) return {};
	const out: Partial<Record<Field, string>> = {};
	for (const e of err.body?.errors ?? []) {
		const field = e.path?.[0] as Field | undefined;
		if (field && e.message && !out[field]) out[field] = e.message;
	}
	return out;
}

export function RegisterPage() {
	const { register } = useAuth();
	const navigate = useNavigate();
	const { search } = useLocation();
	const [form, setForm] = useState<RegisterInput>(EMPTY);
	const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const set = (field: Field) => (e: { target: { value: string } }) =>
		setForm((f) => ({ ...f, [field]: e.target.value }));

	async function submit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		setErrors({});
		try {
			await register({
				...form,
				username: form.username.trim().toLowerCase(),
				email: form.email.trim(),
			});
			navigate(safeNext(search), { replace: true });
		} catch (err) {
			const byField = fieldErrors(err);
			setErrors(byField);
			setError(
				Object.keys(byField).length
					? null
					: err instanceof Error
						? err.message
						: 'Sign-up failed',
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<CenteredPage
			title="Create your account"
			subtitle="Research and write together with an agent."
		>
			<form onSubmit={submit} className="flex flex-col gap-4">
				<FormError message={error} />
				<div className="grid grid-cols-2 gap-3">
					<Input
						label="First name"
						autoComplete="given-name"
						value={form.firstname}
						onChange={set('firstname')}
						error={errors.firstname}
						required
						autoFocus
					/>
					<Input
						label="Last name"
						autoComplete="family-name"
						value={form.lastname}
						onChange={set('lastname')}
						error={errors.lastname}
						required
					/>
				</div>
				<Input
					label="Username"
					autoComplete="username"
					value={form.username}
					onChange={set('username')}
					error={errors.username}
					hint="5+ lowercase letters or numbers"
					required
				/>
				<Input
					label="Email"
					type="email"
					autoComplete="email"
					value={form.email}
					onChange={set('email')}
					error={errors.email}
					required
				/>
				<Input
					label="Password"
					type="password"
					autoComplete="new-password"
					value={form.password}
					onChange={set('password')}
					error={errors.password}
					hint="8+ characters with upper and lower case, a number and a symbol"
					required
				/>
				<Button type="submit" loading={busy}>
					Create account
				</Button>
				<p className="text-center text-sm text-muted">
					Already have an account?{' '}
					<Link
						to={`/login${search}`}
						className="font-medium text-accent hover:underline"
					>
						Log in
					</Link>
				</p>
			</form>
		</CenteredPage>
	);
}
