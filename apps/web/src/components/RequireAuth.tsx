import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from '../lib/auth';
import { loginPath } from '../lib/next';

/** Pages behind login. Logged-out visitors go to /login and come back afterwards. */
export function RequireAuth() {
	const { isLoggedIn } = useAuth();
	const location = useLocation();
	if (!isLoggedIn) {
		return (
			<Navigate to={loginPath(location.pathname + location.search)} replace />
		);
	}
	return <Outlet />;
}

/** Pages for logged-out visitors (login, register). Logged-in users skip ahead. */
export function GuestOnly({ to = '/' }: { to?: string }) {
	const { isLoggedIn } = useAuth();
	return isLoggedIn ? <Navigate to={to} replace /> : <Outlet />;
}
