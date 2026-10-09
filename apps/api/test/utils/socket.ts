import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import { appUrl } from './create-app';

/**
 * Opens a real Socket.IO connection to the test app, sending the JWT in the
 * handshake (`auth.token`), the way the web app will. Resolves once connected;
 * rejects if the server refuses the connection.
 */
export function connectSocket(
	app: NestExpressApplication,
	token?: string,
	namespace = '/',
): Promise<Socket> {
	const socket = io(`${appUrl(app)}${namespace}`, {
		auth: token ? { token } : {},
		transports: ['websocket'],
		reconnection: false,
		forceNew: true,
	});
	return new Promise((resolve, reject) => {
		socket.once('connect', () => resolve(socket));
		socket.once('connect_error', (err) => {
			socket.close();
			reject(err);
		});
	});
}

/**
 * Resolves with the payload of the next `event` that matches `predicate`.
 * Rejects after `timeoutMs` so a missing event fails the test instead of hanging it.
 */
export function waitForEvent<T = unknown>(
	socket: Socket,
	event: string,
	predicate: (payload: T) => boolean = () => true,
	timeoutMs = 2000,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.off(event, handler);
			reject(
				new Error(`Timed out after ${timeoutMs}ms waiting for "${event}"`),
			);
		}, timeoutMs);
		function handler(payload: T) {
			if (!predicate(payload)) return;
			clearTimeout(timer);
			socket.off(event, handler);
			resolve(payload);
		}
		socket.on(event, handler);
	});
}

/** Asserts that `event` does NOT arrive within `windowMs`. */
export async function expectNoEvent(
	socket: Socket,
	event: string,
	windowMs = 300,
): Promise<void> {
	let received: unknown;
	const handler = (payload: unknown) => {
		received = payload;
	};
	socket.on(event, handler);
	await new Promise((r) => setTimeout(r, windowMs));
	socket.off(event, handler);
	if (received !== undefined) {
		throw new Error(
			`Expected no "${event}" but got ${JSON.stringify(received)}`,
		);
	}
}
