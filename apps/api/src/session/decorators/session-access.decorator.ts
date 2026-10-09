import { SessionAction } from '@huddle/shared';
import {
	applyDecorators,
	createParamDecorator,
	ExecutionContext,
	SetMetadata,
	UseGuards,
} from '@nestjs/common';
import { ApiForbiddenResponse, ApiNotFoundResponse } from '@nestjs/swagger';
import { SessionMember } from '@prisma/client';
import { SessionAccessGuard } from '../guards/session-access.guard';

export const SESSION_ACTION = 'sessionAction';

/**
 * Protects a `/sessions/:id/...` route: the caller must be a member of the
 * session (404 otherwise) and their role must allow `action` (403 otherwise),
 * per the shared `can()` permission table the web app also uses.
 */
export const RequireSessionAction = (action: SessionAction) =>
	applyDecorators(
		SetMetadata(SESSION_ACTION, action),
		UseGuards(SessionAccessGuard),
		ApiNotFoundResponse({
			description: 'Session not found, or you are not a member',
		}),
		ApiForbiddenResponse({
			description: `Your role in this session can't ${action}`,
		}),
	);

/** The caller's membership in the session, loaded by SessionAccessGuard. */
export const CurrentMembership = createParamDecorator(
	(_data: unknown, ctx: ExecutionContext): SessionMember =>
		ctx.switchToHttp().getRequest().sessionMembership,
);
