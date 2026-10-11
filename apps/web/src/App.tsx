import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AppLayout } from './components/AppLayout';
import { GuestOnly, RequireAuth } from './components/RequireAuth';
import { AuthProvider } from './lib/auth';
import { HomePage } from './pages/HomePage';
import { InvitePage } from './pages/InvitePage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RegisterPage } from './pages/RegisterPage';

// The room pulls in the editor (Tiptap + Yjs); load it only when a session is opened.
const SessionRoomPage = lazy(() =>
	import('./pages/SessionRoomPage').then((m) => ({
		default: m.SessionRoomPage,
	})),
);

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: true, staleTime: 15_000 },
	},
});

export default function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<AuthProvider>
				<BrowserRouter>
					<Routes>
						<Route element={<GuestOnly />}>
							<Route path="/login" element={<LoginPage />} />
							<Route path="/register" element={<RegisterPage />} />
						</Route>
						{/* Public: shows the preview to anyone; accepting needs login. */}
						<Route path="/invite/:token" element={<InvitePage />} />
						<Route element={<RequireAuth />}>
							<Route element={<AppLayout />}>
								<Route path="/" element={<HomePage />} />
								<Route
									path="/s/:sessionId"
									element={
										<Suspense
											fallback={
												<p className="px-4 py-8 text-sm text-muted">
													Opening session…
												</p>
											}
										>
											<SessionRoomPage />
										</Suspense>
									}
								/>
							</Route>
						</Route>
						<Route path="*" element={<NotFoundPage />} />
					</Routes>
				</BrowserRouter>
			</AuthProvider>
		</QueryClientProvider>
	);
}
