import { Body, Controller, Param, Post } from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiConflictResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { Approval, SessionMember } from '@prisma/client';
import {
	CurrentMembership,
	RequireSessionAction,
} from '@src/session/decorators/session-access.decorator';
import { ZodResponse } from 'nestjs-zod';
import { ApprovalService } from './approval.service';
import { ApprovalDto, ResolveApprovalDto } from './dto/approval.dto';

export function toApprovalDto(a: Approval): ApprovalDto {
	return {
		id: a.id,
		sessionId: a.sessionId,
		kind: a.kind as ApprovalDto['kind'],
		title: a.title,
		details: a.details ?? null,
		planStepId: a.planStepId,
		status: a.status as ApprovalDto['status'],
		requestedAt: a.requestedAt.toISOString(),
		resolvedById: a.resolvedById,
		resolvedAt: a.resolvedAt?.toISOString() ?? null,
		note: a.note,
	};
}

@ApiTags('Approvals')
@ApiBearerAuth('access-token')
@Controller('sessions/:id/approvals')
export class ApprovalsController {
	constructor(private readonly approvals: ApprovalService) {}

	/** Approve or reject a gate. The Owner, and Editors the Owner lets approve. */
	@Post(':approvalId')
	@RequireSessionAction('approve')
	@ApiOperation({ summary: 'Approve or reject' })
	@ApiConflictResponse({ description: 'Someone already answered it' })
	@ZodResponse({ status: 201, type: ApprovalDto })
	async resolve(
		@Param('id') _id: string,
		@Param('approvalId') approvalId: string,
		@CurrentMembership() membership: SessionMember,
		@Body() body: ResolveApprovalDto,
	): Promise<ApprovalDto> {
		return toApprovalDto(
			await this.approvals.resolve(membership, approvalId, body),
		);
	}
}
