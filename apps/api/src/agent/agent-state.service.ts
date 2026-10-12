import { ActorType, AgentState, EventType, SocketEvent } from '@huddle/shared';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@src/prisma/prisma.service';
import { BroadcastService } from '@src/realtime/broadcast.service';
import { TimelineService } from '@src/timeline/timeline.service';

/** The agent's voice and status light: what it says on the timeline, and what it's doing now. */
@Injectable()
export class AgentStateService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly broadcast: BroadcastService,
	) {}

	async set(
		sessionId: string,
		agentState: AgentState,
		stepId: string | null = null,
	) {
		await this.prisma.session.updateMany({
			where: { id: sessionId },
			data: { agentState },
		});
		this.broadcast.toSession(sessionId, SocketEvent.AGENT_STATE, {
			sessionId,
			agentState,
			stepId,
		});
	}

	/** Posts an AGENT_MESSAGE. Pass `tx` to save it with other changes. */
	async say(
		sessionId: string,
		text: string,
		extra: Record<string, Prisma.InputJsonValue | null> = {},
		tx?: Prisma.TransactionClient,
	) {
		const event = {
			type: EventType.AGENT_MESSAGE,
			actorType: ActorType.AGENT,
			payload: { text, ...extra },
		};
		if (tx) return this.timeline.append(tx, sessionId, event);
		return this.timeline.record(sessionId, event);
	}
}
