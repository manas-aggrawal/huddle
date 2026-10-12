import { Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiConflictResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { SessionMember } from '@prisma/client';
import {
	CurrentMembership,
	RequireSessionAction,
} from '@src/session/decorators/session-access.decorator';
import { PlanStepDto } from '@src/session/dto/session.response';
import { ZodResponse } from 'nestjs-zod';
import { AddStepDto, ReorderStepsDto, UpdateStepDto } from './dto/plan.dto';
import { PlanService } from './plan.service';

/** Editing the plan by hand. Editors and Owner. Each call returns the whole plan. */
@ApiTags('Plan')
@ApiBearerAuth('access-token')
@Controller('sessions/:id/plan-steps')
export class PlanController {
	constructor(private readonly plan: PlanService) {}

	@Post()
	@RequireSessionAction('editPlan')
	@ApiOperation({ summary: 'Add a step' })
	@ZodResponse({ status: 201, type: [PlanStepDto] })
	add(
		@Param('id') _id: string,
		@CurrentMembership() m: SessionMember,
		@Body() body: AddStepDto,
	): Promise<PlanStepDto[]> {
		return this.plan.add(m, body);
	}

	@Post('reorder')
	@RequireSessionAction('editPlan')
	@ApiOperation({ summary: 'Reorder the steps' })
	@ApiConflictResponse({ description: 'Tried to move the step being written' })
	@ZodResponse({ status: 201, type: [PlanStepDto] })
	reorder(
		@Param('id') _id: string,
		@CurrentMembership() m: SessionMember,
		@Body() body: ReorderStepsDto,
	): Promise<PlanStepDto[]> {
		return this.plan.reorder(m, body);
	}

	@Patch(':stepId')
	@RequireSessionAction('editPlan')
	@ApiOperation({ summary: 'Rename, describe, skip or gate a step' })
	@ApiConflictResponse({ description: 'Tried to skip the step being written' })
	@ZodResponse({ status: 200, type: [PlanStepDto] })
	update(
		@Param('id') _id: string,
		@Param('stepId') stepId: string,
		@CurrentMembership() m: SessionMember,
		@Body() body: UpdateStepDto,
	): Promise<PlanStepDto[]> {
		return this.plan.update(m, stepId, body);
	}

	@Delete(':stepId')
	@RequireSessionAction('editPlan')
	@ApiOperation({ summary: 'Delete a step' })
	@ApiConflictResponse({
		description: 'Tried to delete the step being written',
	})
	@ZodResponse({ status: 200, type: [PlanStepDto] })
	remove(
		@Param('id') _id: string,
		@Param('stepId') stepId: string,
		@CurrentMembership() m: SessionMember,
	): Promise<PlanStepDto[]> {
		return this.plan.remove(m, stepId);
	}
}
