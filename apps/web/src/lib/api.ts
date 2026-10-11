import createClient from 'openapi-fetch';
import type { components, paths } from './api-schema';
import { API_URL } from './config';
import { getTokens, setTokens } from './tokens';

// Typed client for the Huddle API. Types come from the API's OpenAPI document:
// run `npm run gen:api` after changing an endpoint.

export type Schemas = components['schemas'];

/** Error body from the API: Nest's { message } plus nestjs-zod's validation details. */
export interface ApiErrorBody {
	statusCode?: number;
	message?: string | string[];
	errors?: { message?: string; path?: (string | number)[] }[];
}

export class ApiError extends Error {
	readonly status: number;
	readonly body: ApiErrorBody | undefined;

	constructor(status: number, body: ApiErrorBody | undefined) {
		super(apiErrorMessage(body) ?? `Request failed (${status})`);
		this.status = status;
		this.body = body;
	}
}

function apiErrorMessage(body: ApiErrorBody | undefined): string | undefined {
	if (!body) return undefined;
	const details = body.errors?.map((e) => e.message).filter(Boolean);
	if (details?.length) return details.join('. ');
	if (Array.isArray(body.message)) return body.message.join('. ');
	return body.message;
}

/** Requests that must never trigger a refresh-and-retry. */
const NO_REFRESH = ['/users/login', '/users/register', '/auth/refresh-token'];

let refreshing: Promise<string | null> | null = null;

/**
 * Gets a new token pair with the refresh token. Concurrent callers share one
 * request. Returns the new access token, or null (and logs out) if the
 * refresh token is missing, expired or rejected.
 */
export function refreshAccessToken(): Promise<string | null> {
	refreshing ??= (async () => {
		const refreshToken = getTokens()?.refreshToken;
		if (!refreshToken) return null;
		try {
			const res = await fetch(`${API_URL}/auth/refresh-token`, {
				headers: { Authorization: `Bearer ${refreshToken}` },
			});
			if (!res.ok) {
				setTokens(null);
				return null;
			}
			const body = (await res.json()) as {
				access_token: string;
				refresh_token: string;
			};
			setTokens({
				accessToken: body.access_token,
				refreshToken: body.refresh_token,
			});
			return body.access_token;
		} catch {
			// Network error: keep the tokens, the next request can try again.
			return null;
		} finally {
			refreshing = null;
		}
	})();
	return refreshing;
}

/** fetch with the access token attached; on a 401 it refreshes once and retries. */
async function authFetch(input: Request): Promise<Response> {
	const retry = input.clone();
	const token = getTokens()?.accessToken;
	if (token) input.headers.set('Authorization', `Bearer ${token}`);
	const res = await fetch(input);

	const path = new URL(input.url).pathname;
	if (res.status !== 401 || !token || NO_REFRESH.includes(path)) return res;

	const fresh = await refreshAccessToken();
	if (!fresh) return res;
	retry.headers.set('Authorization', `Bearer ${fresh}`);
	return fetch(retry);
}

export const api = createClient<paths>({ baseUrl: API_URL, fetch: authFetch });

/**
 * Unwraps an openapi-fetch result for React Query: returns the data or throws
 * an ApiError with the server's message.
 */
export async function unwrap<T>(
	promise: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
	const { data, error, response } = await promise;
	if (!response.ok) throw new ApiError(response.status, error as ApiErrorBody);
	return data as T;
}
