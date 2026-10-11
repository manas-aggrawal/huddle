import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useSyncExternalStore,
} from 'react';
import { api, type Schemas, unwrap } from './api';
import { getTokens, setTokens, subscribeTokens, type Tokens } from './tokens';

export type User = Schemas['UserProfileDto_Output'];
// The password's several regex rules come out as `unknown` in the generated type.
export type RegisterInput = Omit<Schemas['CreateUserDto'], 'password'> & {
	password: string;
};

interface AuthState {
	/** Logged in (has tokens). The profile may still be loading. */
	isLoggedIn: boolean;
	user: User | undefined;
	login: (usernameOrEmail: string, password: string) => Promise<void>;
	register: (input: RegisterInput) => Promise<void>;
	logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function useTokens(): Tokens | null {
	return useSyncExternalStore(subscribeTokens, getTokens);
}

function saveTokens(body: { access_token?: string; refresh_token?: string }) {
	if (!body.access_token || !body.refresh_token) {
		throw new Error('The server did not return tokens');
	}
	setTokens({
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
	});
}

export function AuthProvider({ children }: { children: ReactNode }) {
	const tokens = useTokens();
	const queryClient = useQueryClient();
	const isLoggedIn = tokens !== null;

	const { data: user } = useQuery({
		queryKey: ['me'],
		queryFn: () => unwrap(api.GET('/users/me')),
		enabled: isLoggedIn,
		staleTime: 5 * 60_000,
	});

	const login = useCallback(
		async (usernameOrEmail: string, password: string) => {
			saveTokens(
				await unwrap(
					api.POST('/users/login', { body: { usernameOrEmail, password } }),
				),
			);
			queryClient.clear();
		},
		[queryClient],
	);

	const register = useCallback(
		async (input: RegisterInput) => {
			saveTokens(await unwrap(api.POST('/users/register', { body: input })));
			queryClient.clear();
		},
		[queryClient],
	);

	const logout = useCallback(() => {
		setTokens(null);
		queryClient.clear();
	}, [queryClient]);

	const value = useMemo(
		() => ({
			isLoggedIn,
			user: isLoggedIn ? user : undefined,
			login,
			register,
			logout,
		}),
		[isLoggedIn, user, login, register, logout],
	);
	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
	return ctx;
}

export function fullName(u: { firstname: string; lastname: string }): string {
	return `${u.firstname} ${u.lastname}`.trim();
}
