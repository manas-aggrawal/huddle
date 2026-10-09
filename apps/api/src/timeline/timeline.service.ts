import { ActorType, EventType } from '@huddle/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
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

/**
 * The session's append-only log. Every event gets the session's next number
 * (1, 2, 3…), with no gaps or repeats, even when many events arrive at once.
 * Clients use that number to catch up: "give me everything after 41".
 */
@Injectable()
export class TimelineService {
	constructor(private readonly prisma: PrismaService) {}

	/**
	 * Appends an event inside the caller's transaction, so the event and the
	 * change it describes are saved together or not at all.
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
		const rows = await tx.$queryRaw<{ lastEventSeq: number }[]>`
			UPDATE "Session"
			SET "lastEventSeq" = "lastEventSeq" + 1, "updatedAt" = now()
			WHERE "id" = ${sessionId}
			RETURNING "lastEventSeq"`;
		if (rows.length === 0) {
			throw new NotFoundException('Session not found');
		}
		return tx.timelineEvent.create({
			data: {
				sessionId,
				seq: rows[0].lastEventSeq,
				type: event.type,
				actorType: event.actorType,
				actorId: event.actorId ?? null,
				payload: event.payload,
			},
		});
	}

	/** Appends an event on its own, when there's no other change to save with it. */
	record(sessionId: string, event: NewTimelineEvent): Promise<TimelineEvent> {
		return this.prisma.$transaction((tx) => this.append(tx, sessionId, event));
	}
}
