import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Database } from '@hocuspocus/extension-database';
import { Hocuspocus, onAuthenticatePayload } from '@hocuspocus/server';
import {
	ApprovalKind,
	ApprovalStatus,
	COLLAB_PATH,
	EventType,
	SessionRole,
	SessionStatus,
} from '@huddle/shared';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { TimelineEvent } from '@prisma/client';
import { UserPayload } from '@src/auth/interfaces/token.interfaces';
import { JWT_ACCESS_TOKEN_SECRET } from '@src/configs/env-vars';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { z } from 'zod';
import { DocActivityService } from './doc-activity.service';

/** What we attach to each connection: a person after they log in, or the agent. */
export interface CollabContext {
	userId?: string;
	sessionId?: string;
	role?: SessionRole;
	agent?: true;
}

/** Context of the agent's server-side connections. */
export const AGENT_CONTEXT: CollabContext = { agent: true };

/** Save at most 2 s after the last edit, and at least every 10 s while edits keep coming. */
const SAVE_DEBOUNCE_MS = 2000;
const SAVE_MAX_DEBOUNCE_MS = 10_000;

/** Close code that tells the provider to reconnect (and so log in again). */
const RECONNECT = { code: 4205, reason: 'Permissions changed, reconnect' };

const uuid = z.string().uuid();

/**
 * The live document server (Hocuspocus over Yjs), sharing the API's HTTP
 * server at /collab. One document per session, named by the session id.
 * Viewers connect read-only; their edits are dropped by the server.
 */
@Injectable()
export class CollabServer
	implements OnApplicationBootstrap, BeforeApplicationShutdown
{
	readonly hocuspocus: Hocuspocus<CollabContext>;
	private readonly logger = new Logger(CollabServer.name);
	private readonly wss = new WebSocketServer({ noServer: true });
	private httpServer?: HttpServer;
	private unsubscribe?: () => void;

	constructor(
		private readonly adapterHost: HttpAdapterHost,
		private readonly jwt: JwtService,
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly activity: DocActivityService,
	) {
		this.hocuspocus = new Hocuspocus<CollabContext>({
			name: 'huddle-collab',
			quiet: true,
			debounce: SAVE_DEBOUNCE_MS,
			maxDebounce: SAVE_MAX_DEBOUNCE_MS,
			onAuthenticate: (data) => this.authenticate(data),
			afterLoadDocument: async ({ documentName, document }) => {
				this.activity.remember(documentName, document);
			},
			onChange: async ({ documentName, document, connection }) => {
				this.activity.changed(
					documentName,
					document,
					connection?.context.userId ?? null,
				);
			},
			afterUnloadDocument: async ({ documentName }) => {
				this.activity.forget(documentName);
			},
			extensions: [
				new Database({
					fetch: ({ documentName }) => this.load(documentName),
					store: ({ documentName, state }) => this.save(documentName, state),
				}),
			],
		});
	}

	onApplicationBootstrap() {
		this.httpServer = this.adapterHost.httpAdapter.getHttpServer();
		this.httpServer?.on('upgrade', this.onUpgrade);
		// Someone removed, or moved between Editor and Viewer, gets reconnected,
		// which logs them in again with their new rights (or refuses them).
		this.unsubscribe = this.timeline.onCommitted((event) =>
			this.onTimelineEvent(event),
		);
	}

	/** Saves every open document before the process exits, then disconnects everyone. */
	async beforeApplicationShutdown() {
		this.unsubscribe?.();
		this.httpServer?.off('upgrade', this.onUpgrade);
		await Promise.all(
			[...this.hocuspocus.documents.values()].map((doc) =>
				this.save(doc.name, Y.encodeStateAsUpdate(doc)).catch((error) =>
					this.logger.error(`Couldn't save document ${doc.name}`, error),
				),
			),
		);
		for (const client of this.wss.clients) client.terminate();
		this.wss.close();
	}

	/** A server-side peer on a session's document, used by the agent. Disconnect when done. */
	openDirectConnection(sessionId: string) {
		return this.hocuspocus.openDirectConnection(sessionId, AGENT_CONTEXT);
	}

	/** Only upgrades to /collab are ours; Socket.IO handles its own path. */
	private readonly onUpgrade = (
		request: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => {
		const { pathname } = new URL(request.url ?? '/', 'http://localhost');
		if (pathname !== COLLAB_PATH) return;
		this.wss.handleUpgrade(request, socket, head, (ws) =>
			this.connect(ws, request),
		);
	};

	private connect(ws: WebSocket, request: IncomingMessage) {
		const headers = new Headers();
		for (const [key, value] of Object.entries(request.headers)) {
			if (typeof value === 'string') headers.set(key, value);
			else if (Array.isArray(value)) headers.set(key, value.join(', '));
		}
		const url = new URL(
			request.url ?? COLLAB_PATH,
			`http://${request.headers.host ?? 'localhost'}`,
		);
		const client = this.hocuspocus.handleConnection(
			ws,
			new Request(url, { headers }),
		);
		ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
			const bytes = Array.isArray(data)
				? Buffer.concat(data)
				: Buffer.from(data as ArrayBuffer);
			client.handleMessage(new Uint8Array(bytes));
		});
		ws.on('close', (code, reason) =>
			client.handleClose({ code, reason: reason.toString() }),
		);
		ws.on('error', (error) =>
			this.logger.warn(`Document socket error: ${error.message}`),
		);
	}

	/** Runs for each document a connection opens. Throwing refuses it. */
	private async authenticate({
		token,
		documentName,
		connectionConfig,
	}: onAuthenticatePayload<CollabContext>): Promise<CollabContext> {
		let payload: UserPayload;
		try {
			payload = await this.jwt.verifyAsync<UserPayload>(token, {
				secret: JWT_ACCESS_TOKEN_SECRET,
			});
		} catch {
			throw new Error('Invalid or expired access token');
		}
		// Same answer for "doesn't exist" and "not yours".
		if (!uuid.safeParse(documentName).success)
			throw new Error('Session not found');
		const membership = await this.prisma.sessionMember.findUnique({
			where: {
				sessionId_userId: { sessionId: documentName, userId: payload.id },
			},
		});
		if (!membership) throw new Error('Session not found');

		const role = membership.role as SessionRole;
		const session = await this.prisma.session.findUnique({
			where: { id: documentName },
			select: { status: true },
		});
		// A finished document is read-only for everyone.
		connectionConfig.readOnly =
			role === SessionRole.VIEWER || session?.status === SessionStatus.DONE;
		return { userId: payload.id, sessionId: documentName, role };
	}

	private async load(sessionId: string): Promise<Uint8Array | null> {
		const row = await this.prisma.document.findUnique({ where: { sessionId } });
		return row ? new Uint8Array(row.ydocState) : null;
	}

	private async save(sessionId: string, state: Uint8Array) {
		const ydocState = Buffer.from(state);
		try {
			await this.prisma.document.upsert({
				where: { sessionId },
				create: { sessionId, ydocState },
				update: { ydocState },
			});
		} catch (error) {
			// The session was deleted while its document was open: nothing to keep.
			const exists = await this.prisma.session.count({
				where: { id: sessionId },
			});
			if (exists) throw error;
		}
	}

	private onTimelineEvent(event: TimelineEvent) {
		// The session just ended (final draft approved, or the Owner ended it):
		// reconnect everyone, which brings them back read-only.
		const p = event.payload as { kind?: string; status?: string; to?: unknown };
		const ended =
			(event.type === EventType.APPROVAL_RESOLVED &&
				p.kind === ApprovalKind.MARK_FINAL &&
				p.status === ApprovalStatus.APPROVED) ||
			(event.type === EventType.STATUS_CHANGED && p.to === SessionStatus.DONE);
		if (ended) {
			const doc = this.hocuspocus.documents.get(event.sessionId);
			for (const connection of doc?.getConnections() ?? []) {
				connection.webSocket.close(RECONNECT.code, RECONNECT.reason);
			}
			return;
		}
		if (
			event.type !== EventType.MEMBER_REMOVED &&
			event.type !== EventType.ROLE_CHANGED
		) {
			return;
		}
		const payload = event.payload as {
			member?: { id?: string };
			from?: { role?: string };
			to?: { role?: string };
		};
		// Toggling "can approve" doesn't change what someone can do in the doc.
		if (
			event.type === EventType.ROLE_CHANGED &&
			payload.from?.role === payload.to?.role
		) {
			return;
		}
		const memberId = payload.member?.id;
		const doc = this.hocuspocus.documents.get(event.sessionId);
		if (!memberId || !doc) return;
		for (const connection of doc.getConnections()) {
			if (connection.context.userId === memberId) {
				connection.webSocket.close(RECONNECT.code, RECONNECT.reason);
			}
		}
	}
}
