import { ServerToClientEvents, sessionRoom, userRoom } from '@huddle/shared';
import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';

/**
 * Sends live-only messages (not timeline events) to a session's room, for
 * services that shouldn't depend on the gateway itself. Messages sent before
 * the gateway starts are dropped.
 */
@Injectable()
export class BroadcastService {
	private server?: Server;

	attach(server: Server) {
		this.server = server;
	}

	toSession<E extends keyof ServerToClientEvents>(
		sessionId: string,
		event: E,
		...args: Parameters<ServerToClientEvents[E]>
	) {
		this.server?.to(sessionRoom(sessionId)).emit(event, ...args);
	}

	toUser<E extends keyof ServerToClientEvents>(
		userId: string,
		event: E,
		...args: Parameters<ServerToClientEvents[E]>
	) {
		this.server?.to(userRoom(userId)).emit(event, ...args);
	}
}
