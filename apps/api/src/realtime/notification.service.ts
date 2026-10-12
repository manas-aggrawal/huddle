import { SocketEvent } from '@huddle/shared';
import { Injectable } from '@nestjs/common';
import { Notification, Prisma } from '@prisma/client';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { BroadcastService } from './broadcast.service';

export type NewNotification = Pick<
	Notification,
	'userId' | 'sessionId' | 'type' | 'title' | 'refId'
>;

/**
 * Inbox items. Saved with the change they're about, and pushed to the
 * person's open tabs (notification:new) once that change is committed.
 */
@Injectable()
export class NotificationService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly broadcast: BroadcastService,
	) {}

	/** Inside a timeline transaction: pushed after it commits. */
	async create(tx: Prisma.TransactionClient, rows: NewNotification[]) {
		const created = await Promise.all(
			rows.map((r) =>
				tx.notification.create({
					data: { ...r, title: r.title.slice(0, 200) },
				}),
			),
		);
		this.timeline.afterCommit(tx, () => this.push(created));
		return created;
	}

	/** Outside a transaction: saved and pushed now. */
	async createNow(rows: NewNotification[]) {
		const created = await Promise.all(
			rows.map((r) =>
				this.prisma.notification.create({
					data: { ...r, title: r.title.slice(0, 200) },
				}),
			),
		);
		this.push(created);
		return created;
	}

	private push(rows: Notification[]) {
		for (const n of rows) {
			this.broadcast.toUser(n.userId, SocketEvent.NOTIFICATION_NEW, {
				id: n.id,
				sessionId: n.sessionId,
				type: n.type,
				title: n.title,
				refId: n.refId,
				createdAt: n.createdAt.toISOString(),
			});
		}
	}
}
