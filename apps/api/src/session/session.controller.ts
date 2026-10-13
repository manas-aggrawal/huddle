import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Patch,
	Post,
	Query,
	Request,
} from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiConflictResponse,
	ApiNoContentResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { SessionMember } from '@prisma/client';
import { ZodResponse } from 'nestjs-zod';
import {
	CurrentMembership,
	RequireSessionAction,
} from './decorators/session-access.decorator';
import {
	CreateSessionDto,
	ListSessionsQueryDto,
	UpdateSessionStatusDto,
	UpdateSettingsDto,
} from './dto/session.request';
import {
	SessionDetailDto,
	SessionDto,
	SessionListItemDto,
} from './dto/session.response';
import { SessionService } from './session.service';

@ApiTags('Sessions')
@ApiBearerAuth('access-token')
@Controller('sessions')
export class SessionController {
	constructor(private readonly sessions: SessionService) {}

	/**
	 * Creates a session in a workspace you belong to (your personal one by
	 * default). You become its Owner, and the timeline starts with SESSION_CREATED.
	 */
	@Post()
	@ApiOperation({ summary: 'Create a session' })
	@ZodResponse({ status: 201, type: SessionDto })
	create(@Request() req, @Body() body: CreateSessionDto): Promise<SessionDto> {
		return this.sessions.create(req.user.id, body);
	}

	/** Sessions you are a member of, most recently active first. */
	@Get()
	@ApiOperation({ summary: 'List my sessions' })
	@ZodResponse({ status: 200, type: [SessionListItemDto] })
	list(
		@Request() req,
		@Query() query: ListSessionsQueryDto,
	): Promise<SessionListItemDto[]> {
		return this.sessions.listMine(req.user.id, query);
	}

	/** The session with its members, plan and pending approvals. Members only. */
	@Get(':id')
	@RequireSessionAction('watch')
	@ApiOperation({ summary: 'Get a session' })
	@ZodResponse({ status: 200, type: SessionDetailDto })
	get(
		@Param('id') _id: string,
		@CurrentMembership() membership: SessionMember,
	): Promise<SessionDetailDto> {
		return this.sessions.getDetail(membership);
	}

	/** Deletes the session and everything in it, for every member. Owner only. */
	@Delete(':id')
	@HttpCode(204)
	@RequireSessionAction('deleteSession')
	@ApiOperation({ summary: 'Delete a session' })
	@ApiNoContentResponse({ description: 'Deleted' })
	async remove(
		@Param('id') _id: string,
		@CurrentMembership() membership: SessionMember,
	): Promise<void> {
		await this.sessions.delete(membership);
	}

	/** Pause, resume or end the session. Owner only. */
	@Patch(':id/status')
	@RequireSessionAction('pauseOrEnd')
	@ApiOperation({ summary: 'Pause, resume or end a session' })
	@ApiConflictResponse({
		description: "That change isn't possible from the current status",
	})
	@ZodResponse({ status: 200, type: SessionDto })
	changeStatus(
		@Param('id') _id: string,
		@CurrentMembership() membership: SessionMember,
		@Body() body: UpdateSessionStatusDto,
	): Promise<SessionDto> {
		return this.sessions.changeStatus(membership, body);
	}

	/** Model, effort and token cap. Owner only; applies from the agent's next model call. */
	@Patch(':id/settings')
	@RequireSessionAction('changeSettings')
	@ApiOperation({ summary: 'Change model, effort or token cap' })
	@ZodResponse({ status: 200, type: SessionDto })
	updateSettings(
		@Param('id') _id: string,
		@CurrentMembership() membership: SessionMember,
		@Body() body: UpdateSettingsDto,
	): Promise<SessionDto> {
		return this.sessions.updateSettings(membership, body);
	}
}
