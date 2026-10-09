import { can, SessionAction, SessionRole } from '@huddle/shared';
import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@src/prisma/prisma.service';
import { SESSION_ACTION } from '../decorators/session-access.decorator';

/**
 * Runs after the global AccessTokenGuard, so req.user is set. Loads the caller's
 * membership for the session in the `:id` route param and checks it against the
 * action the route requires.
 */
@Injectable()
export class SessionAccessGuard implements CanActivate {
	constructor(
		private readonly reflector: Reflector,
		private readonly prisma: PrismaService,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const req = context.switchToHttp().getRequest();
		const action =
			this.reflector.get<SessionAction>(SESSION_ACTION, context.getHandler()) ??
			'watch';

		const membership = await this.prisma.sessionMember.findUnique({
			where: {
				sessionId_userId: { sessionId: req.params.id, userId: req.user.id },
			},
		});
		// Same answer for "doesn't exist" and "not yours": outsiders can't probe for sessions.
		if (!membership) {
			throw new NotFoundException('Session not found');
		}

		const role = membership.role as SessionRole;
		if (!can({ role, canApprove: membership.canApprove }, action)) {
			throw new ForbiddenException(
				`As ${role.toLowerCase()} of this session, you can't ${action}`,
			);
		}

		req.sessionMembership = membership;
		return true;
	}
}
