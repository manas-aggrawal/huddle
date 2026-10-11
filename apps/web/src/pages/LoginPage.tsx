import { type FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { CenteredPage, FormError } from '../components/CenteredPage';
import { Button, Input } from '../components/ui';
import { useAuth } from '../lib/auth';
import { safeNext } from '../lib/next';

export function LoginPage() {
	const { login } = useAuth();
	const navigate = useNavigate();
	const { search } = useLocation();
	const [usernameOrEmail, setUsernameOrEmail] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await login(usernameOrEmail.trim(), password);
			navigate(safeNext(search), { replace: true });
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Login failed');
		} finally {
			setBusy(false);
		}
	}

	return (
		<CenteredPage title="Log in" subtitle="Welcome back to Huddle.">
			<form onSubmit={submit} className="flex flex-col gap-4">
				<FormError message={error} />
				<Input
					label="Username or email"
					autoComplete="username"
					value={usernameOrEmail}
					onChange={(e) => setUsernameOrEmail(e.target.value)}
					required
					autoFocus
				/>
				<Input
					label="Password"
					type="password"
					autoComplete="current-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					required
				/>
				<Button type="submit" loading={busy}>
					Log in
				</Button>
				<p className="text-center text-sm text-muted">
					New here?{' '}
					<Link
						to={`/register${search}`}
						className="font-medium text-accent hover:underline"
					>
						Create an account
					</Link>
				</p>
			</form>
		</CenteredPage>
	);
}
