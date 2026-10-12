import { ActorType, EventType, TimelineEventDto } from '@huddle/shared';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEvent } from '@prisma/client';
import { PrismaService } from '@src/prisma/prisma.service';

export interface NewTimelineEvent {
	type: EventType;
	actorType: ActorType;
	/** The user who did it. Null for the agent and the system. */
	actorId?: string | null;
	/** Ids of the records it's about, plus the display details the timeline needs. */
	payload: Prisma.InputJsonValue;
}

export type CommittedListener = (event: TimelineEvent) => void;

export function toTimelineEventDto(e: TimelineEvent): TimelineEventDto {
	return {
		id: e.id,
		sessionId: e.sessionId,
		seq: e.seq,
		type: e.type as EventType,
		actorType: e.actorType as ActorType,
		actorId: e.actorId,
		payload: e.payload as Record<string, unknown>,
		createdAt: e.createdAt.toISOString(),
	};
}

/**
 * The session's append-only log. Every event gets the session's next number
 * (1, 2, 3…), with no gaps or repeats, even when many events arrive at once.
 * Clients use that number to catch up: "give me everything after 41".
 */
@Injectable()
export class TimelineService {
	private readonly logger = new Logger(TimelineService.name);
	/** Events appended inside each open timeline transaction, announced on commit. */
	private readonly pending = new WeakMap<
		Prisma.TransactionClient,
		TimelineEvent[]
	>();
	private readonly listeners = new Set<CommittedListener>();
	/** Callbacks to run once each open timeline transaction commits. */
	private readonly afterCommits = new WeakMap<
		Prisma.TransactionClient,
		(() => void)[]
	>();

	constructor(private readonly prisma: PrismaService) {}

	/**
	 * Use this instead of prisma.$transaction whenever the work appends events.
	 * Events are announced to listeners (the realtime gateway) only after the
	 * transaction commits, in seq order; a rollback announces nothing.
	 */
	async transaction<T>(
		fn: (tx: Prisma.TransactionClient) => Promise<T>,
	): Promise<T> {
		let events: TimelineEvent[] = [];
		let callbacks: (() => void)[] = [];
		const result = await this.prisma.$transaction(async (tx) => {
			events = [];
			callbacks = [];
			this.pending.set(tx, events);
			this.afterCommits.set(tx, callbacks);
			return fn(tx);
		});
		for (const event of events) this.announce(event);
		for (const cb of callbacks) {
			try {
				cb();
			} catch (error) {
				this.logger.error('After-commit callback failed', error);
			}
		}
		return result;
	}

	/** Runs `fn` after the timeline transaction `tx` commits (never on rollback). */
	afterCommit(tx: Prisma.TransactionClient, fn: () => void) {
		const queue = this.afterCommits.get(tx);
		if (!queue) {
			throw new Error(
				'timeline.afterCommit must run inside timeline.transaction()',
			);
		}
		queue.push(fn);
	}

	/** Called with every committed event. Returns a function that unsubscribes. */
	onCommitted(listener: CommittedListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Events after `sinceSeq`, oldest first, for catching up after a (re)connect. */
	listSince(
		sessionId: string,
		sinceSeq: number,
		limit: number,
	): Promise<TimelineEvent[]> {
		return this.prisma.timelineEvent.findMany({
			where: { sessionId, seq: { gt: sinceSeq } },
			orderBy: { seq: 'asc' },
			take: limit,
		});
	}

	/**
	 * Appends an event inside a timeline.transaction(), so the event and the
	 * change it describes are saved together or not at all, and the event is
	 * announced once they are.
	 *
	 * Numbering: incrementing Session.lastEventSeq locks the session row until the
	 * transaction ends, so concurrent appends to one session queue up and each
	 * gets the next number. If the transaction rolls back, the increment rolls
	 * back with it, which keeps the sequence gapless.
	 */
	async append(
		tx: Prisma.TransactionClient,
		sessionId: string,
		event: NewTimelineEvent,
	): Promise<TimelineEvent> {
		const queue = this.pending.get(tx);
		if (!queue) {
			// A plain prisma.$transaction would save the event but never announce it.
			throw new Error('timeline.append must run inside timeline.transaction()');
		}
		const rows = await tx.$queryRaw<{ lastEventSeq: number }[]>`
			UPDATE "Session"
			SET "lastEventSeq" = "lastEventSeq" + 1, "updatedAt" = now()
			WHERE "id" = ${sessionId}
			RETURNING "lastEventSeq"`;
		if (rows.length === 0) {
			throw new NotFoundException('Session not found');
		}
		const created = await tx.timelineEvent.create({
			data: {
				sessionId,
				seq: rows[0].lastEventSeq,
				type: event.type,
				actorType: event.actorType,
				actorId: event.actorId ?? null,
				payload: event.payload,
			},
		});
		queue.push(created);
		return created;
	}

	/**
	 * Display details for a person, stored in event payloads (`actor`, `member`)
	 * so the timeline renders without extra lookups.
	 */
	async actorSnapshot(
		tx: Prisma.TransactionClient,
		userId: string,
	): Promise<{ id: string; name: string }> {
		const user = await tx.user.findUniqueOrThrow({
			where: { id: userId },
			select: { id: true, firstname: true, lastname: true },
		});
		return { id: user.id, name: `${user.firstname} ${user.lastname}`.trim() };
	}

	/** Appends an event on its own, when there's no other change to save with it. */
	record(sessionId: string, event: NewTimelineEvent): Promise<TimelineEvent> {
		return this.transaction((tx) => this.append(tx, sessionId, event));
	}

	private announce(event: TimelineEvent) {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				// The event is already saved; a broken listener must not fail the request.
				this.logger.error(
					`Timeline listener failed for event ${event.id}`,
					error,
				);
			}
		}
	}
}
