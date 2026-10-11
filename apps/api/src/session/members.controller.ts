import {
	Body,
	Controller,
	Delete,
	HttpCode,
	Param,
	Patch,
} from '@nestjs/common';
import {
	ApiBadRequestResponse,
	ApiBearerAuth,
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
import { UpdateMemberDto } from './dto/member.request';
import { MemberDto } from './dto/session.response';
import { MembersService } from './members.service';

/** Managing who's in a session and what they can do. Owner only. */
@ApiTags('Sessions')
@ApiBearerAuth('access-token')
@Controller('sessions/:id/members')
export class MembersController {
	constructor(private readonly members: MembersService) {}

	@Patch(':userId')
	@RequireSessionAction('changeRoles')
	@ApiOperation({ summary: "Change a member's role or approval permission" })
	@ApiBadRequestResponse({
		description:
			'Tried to make someone Owner, change the Owner, or let a Viewer approve',
	})
	@ZodResponse({ status: 200, type: MemberDto })
	update(
		@Param('id') _id: string,
		@Param('userId') userId: string,
		@CurrentMembership() owner: SessionMember,
		@Body() body: UpdateMemberDto,
	): Promise<MemberDto> {
		return this.members.update(owner, userId, body);
	}

	@Delete(':userId')
	@HttpCode(204)
	@RequireSessionAction('changeRoles')
	@ApiOperation({ summary: 'Remove a member from the session' })
	@ApiNoContentResponse({
		description: 'Removed. They lose access immediately.',
	})
	@ApiBadRequestResponse({ description: "The Owner can't be removed" })
	remove(
		@Param('id') _id: string,
		@Param('userId') userId: string,
		@CurrentMembership() owner: SessionMember,
	): Promise<void> {
		return this.members.remove(owner, userId);
	}
}
