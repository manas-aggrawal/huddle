import type {
	ClientToServerEvents,
	ServerToClientEvents,
} from '@huddle/shared';
import { io, type Socket } from 'socket.io-client';
import { getFreshAccessToken, refreshAccessToken } from './api';
import { API_URL } from './config';
import { getTokens, subscribeTokens } from './tokens';

export type HuddleSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: HuddleSocket | null = null;

/**
 * The app's one Socket.IO connection, opened on first use. It sends the
 * current access token on every (re)connect; if the server refuses an expired
 * token, it refreshes once and tries again.
 */
export function getSocket(): HuddleSocket {
	if (socket) return socket;
	const s: HuddleSocket = io(API_URL, {
		transports: ['websocket'],
		auth: (cb) => {
			void getFreshAccessToken().then((token) => cb({ token }));
		},
	});

	let refreshedForThisFailure = false;
	s.on('connect', () => {
		refreshedForThisFailure = false;
	});
	s.on('connect_error', async (err) => {
		// The server refused the handshake (bad token); Socket.IO won't retry on its own.
		if (!/token/i.test(err.message) || refreshedForThisFailure) return;
		refreshedForThisFailure = true;
		if (await refreshAccessToken()) s.connect();
	});

	socket = s;
	return s;
}

// Logging out closes the connection; the next getSocket() opens a fresh one.
subscribeTokens(() => {
	if (!getTokens() && socket) {
		socket.disconnect();
		socket = null;
	}
});
