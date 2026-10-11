import { Outlet } from 'react-router';
import { AppHeader } from './AppHeader';

export function AppLayout() {
	return (
		<div className="min-h-screen">
			<AppHeader />
			<Outlet />
		</div>
	);
}
