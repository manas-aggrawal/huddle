import {
	Controller,
	Get,
	HttpCode,
	NotFoundException,
	Param,
	Post,
	Query,
	Request,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@src/prisma/prisma.service';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';

class NotificationsQueryDto extends createZodDto(
	z.object({
		unread: z
			.enum(['true', 'false'])
			.optional()
			.describe('true: only unread ones'),
	}),
) {}

const NotificationSchema = z.object({
	id: z.uuid(),
	sessionId: z.uuid(),
	sessionTitle: z.string(),
	type: z.string(),
	title: z.string(),
	refId: z.string().max(64).nullable(),
	readAt: z.iso.datetime().nullable(),
	createdAt: z.string(),
});
class NotificationDto extends createZodDto(NotificationSchema) {}

/** Your inbox: approvals waiting on you, mentions, conflicts, handoffs. */
@ApiTags('Notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationsController {
	constructor(private readonly prisma: PrismaService) {}

	/** Newest first, at most 50. */
	@Get()
	@ApiOperation({ summary: 'List my notifications' })
	@ZodResponse({ status: 200, type: [NotificationDto] })
	async list(
		@Request() req,
		@Query() query: NotificationsQueryDto,
	): Promise<NotificationDto[]> {
		const rows = await this.prisma.notification.findMany({
			where: {
				userId: req.user.id,
				...(query.unread === 'true' ? { readAt: null } : {}),
			},
			orderBy: { createdAt: 'desc' },
			take: 50,
			include: { session: { select: { title: true } } },
		});
		return rows.map((n) => ({
			id: n.id,
			sessionId: n.sessionId,
			sessionTitle: n.session.title,
			type: n.type,
			title: n.title,
			refId: n.refId,
			readAt: n.readAt?.toISOString() ?? null,
			createdAt: n.createdAt.toISOString(),
		}));
	}

	/** Someone else's notification is a 404, like one that doesn't exist. */
	@Post(':id/read')
	@HttpCode(204)
	@ApiOperation({ summary: 'Mark a notification read' })
	async read(@Request() req, @Param('id') id: string): Promise<void> {
		const { count } = await this.prisma.notification.updateMany({
			where: { id, userId: req.user.id },
			data: { readAt: new Date() },
		});
		if (count === 0) throw new NotFoundException('Notification not found');
	}

	@Post('read-all')
	@HttpCode(204)
	@ApiOperation({ summary: 'Mark all my notifications read' })
	async readAll(@Request() req): Promise<void> {
		await this.prisma.notification.updateMany({
			where: { userId: req.user.id, readAt: null },
			data: { readAt: new Date() },
		});
	}
}
