import { Link } from 'react-router';
import { fullName, useAuth } from '../lib/auth';
import { Avatar, Button, ThemeToggle } from './ui';

export function Logo() {
	return (
		<Link
			to="/"
			className="flex items-center gap-2 font-semibold tracking-tight"
		>
			<span
				aria-hidden
				className="inline-flex size-7 items-center justify-center rounded-lg bg-accent text-sm text-accent-ink"
			>
				H
			</span>
			Huddle
		</Link>
	);
}

export function AppHeader() {
	const { user, logout } = useAuth();
	return (
		<header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
			<div className="flex h-14 items-center justify-between gap-3 px-4">
				<Logo />
				<div className="flex items-center gap-1 sm:gap-2">
					<ThemeToggle />
					{user && (
						<span className="hidden items-center gap-2 text-sm sm:flex">
							<Avatar userId={user.id} name={fullName(user)} size="sm" />
							{fullName(user)}
						</span>
					)}
					<Button variant="ghost" size="sm" onClick={logout}>
						Log out
					</Button>
				</div>
			</div>
		</header>
	);
}
