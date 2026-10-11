import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AppLayout } from './components/AppLayout';
import { GuestOnly, RequireAuth } from './components/RequireAuth';
import { AuthProvider } from './lib/auth';
import { HomePage } from './pages/HomePage';
import { InvitePage } from './pages/InvitePage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RegisterPage } from './pages/RegisterPage';
import { SessionRoomPage } from './pages/SessionRoomPage';

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
								<Route path="/s/:sessionId" element={<SessionRoomPage />} />
							</Route>
						</Route>
						<Route path="*" element={<NotFoundPage />} />
					</Routes>
				</BrowserRouter>
			</AuthProvider>
		</QueryClientProvider>
	);
}
