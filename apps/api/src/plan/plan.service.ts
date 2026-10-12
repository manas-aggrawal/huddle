import {
	ActorType,
	AgentState,
	ApprovalKind,
	ApprovalStatus,
	BLOCKING_APPROVAL_KINDS,
	EventType,
	SessionStatus,
	StepStatus,
} from '@huddle/shared';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { PlanStep, Prisma, SessionMember } from '@prisma/client';
import { PlanStepDto } from '@src/session/dto/session.response';
import { TimelineService } from '@src/timeline/timeline.service';
import { AddStepDto, ReorderStepsDto, UpdateStepDto } from './dto/plan.dto';

export function toPlanStepDto(p: PlanStep): PlanStepDto {
	return {
		id: p.id,
		position: p.position,
		title: p.title,
		description: p.description,
		status: p.status as StepStatus,
		sectionId: p.sectionId,
		requiresApproval: p.requiresApproval,
	};
}

interface Diff {
	added: string[];
	removed: string[];
	changed: string[];
	moved: string[];
}
const diff = (d: Partial<Diff>): Diff => ({
	added: [],
	removed: [],
	changed: [],
	moved: [],
	...d,
});
const ordered: Pick<Prisma.PlanStepFindManyArgs, 'orderBy'> = {
	orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
};

/**
 * People editing the plan directly. Changes sync live through PLAN_UPDATED,
 * and the agent picks them up at its next step. The step being written can't
 * be moved, deleted or skipped: interrupt the agent first.
 */
@Injectable()
export class PlanService {
	constructor(private readonly timeline: TimelineService) {}

	async add(
		membership: SessionMember,
		dto: AddStepDto,
	): Promise<PlanStepDto[]> {
		return this.edit(membership, async (tx, steps) => {
			let index = steps.length;
			if (dto.after === null) index = 0;
			else if (dto.after) {
				const i = steps.findIndex((s) => s.id === dto.after);
				if (i === -1)
					throw new BadRequestException('That step is not in this plan');
				index = i + 1;
			}
			const created = await tx.planStep.create({
				data: {
					sessionId: membership.sessionId,
					position: index + 1,
					title: dto.title,
					description: dto.description ?? null,
					requiresApproval: dto.requiresApproval ?? false,
					createdById: membership.userId,
				},
			});
			const next = [...steps];
			next.splice(index, 0, created);
			await this.renumber(tx, next);
			// New work after the agent asked to finish: that request no longer stands.
			await this.reopenIfFinishing(tx, membership.sessionId);
			return diff({ added: [dto.title] });
		});
	}

	async update(
		membership: SessionMember,
		stepId: string,
		dto: UpdateStepDto,
	): Promise<PlanStepDto[]> {
		return this.edit(membership, async (tx, steps) => {
			const step = steps.find((s) => s.id === stepId);
			if (!step) throw new NotFoundException('Step not found');
			const data: Prisma.PlanStepUpdateInput = {};
			const changed: string[] = [];
			if (dto.title !== undefined && dto.title !== step.title) {
				data.title = dto.title;
				changed.push(`${step.title} → ${dto.title}`);
			}
			if (
				dto.description !== undefined &&
				dto.description !== step.description
			) {
				data.description = dto.description;
				if (!changed.length) changed.push(step.title);
			}
			if (
				dto.requiresApproval !== undefined &&
				dto.requiresApproval !== step.requiresApproval
			) {
				data.requiresApproval = dto.requiresApproval;
				changed.push(
					`${dto.title ?? step.title} ${dto.requiresApproval ? 'needs approval' : 'no longer needs approval'}`,
				);
			}
			const result = diff({ changed });
			if (dto.skipped !== undefined) {
				if (step.status === StepStatus.IN_PROGRESS) {
					throw new ConflictException(
						'The agent is writing this step. Interrupt it first.',
					);
				}
				if (dto.skipped && step.status !== StepStatus.SKIPPED) {
					if (step.status === StepStatus.DONE) {
						throw new ConflictException('This step is already written');
					}
					data.status = StepStatus.SKIPPED;
					result.removed.push(step.title);
				} else if (!dto.skipped && step.status === StepStatus.SKIPPED) {
					data.status = StepStatus.PENDING;
					result.added.push(step.title);
				}
			}
			if (Object.keys(data).length) {
				await tx.planStep.update({ where: { id: stepId }, data });
			}
			if (data.status === StepStatus.PENDING) {
				await this.reopenIfFinishing(tx, membership.sessionId);
			}
			return result;
		});
	}

	async remove(
		membership: SessionMember,
		stepId: string,
	): Promise<PlanStepDto[]> {
		return this.edit(membership, async (tx, steps) => {
			const step = steps.find((s) => s.id === stepId);
			if (!step) throw new NotFoundException('Step not found');
			if (step.status === StepStatus.IN_PROGRESS) {
				throw new ConflictException(
					'The agent is writing this step. Interrupt it first.',
				);
			}
			await tx.planStep.delete({ where: { id: stepId } });
			await this.renumber(
				tx,
				steps.filter((s) => s.id !== stepId),
			);
			return diff({ removed: [step.title] });
		});
	}

	async reorder(
		membership: SessionMember,
		dto: ReorderStepsDto,
	): Promise<PlanStepDto[]> {
		return this.edit(membership, async (tx, steps) => {
			const ids = new Set(dto.orderedIds);
			if (
				ids.size !== dto.orderedIds.length ||
				ids.size !== steps.length ||
				steps.some((s) => !ids.has(s.id))
			) {
				throw new BadRequestException(
					'orderedIds must list every step exactly once',
				);
			}
			const byId = new Map(steps.map((s) => [s.id, s]));
			const next = dto.orderedIds.map((id) => byId.get(id) as PlanStep);
			const writing = steps.findIndex(
				(s) => s.status === StepStatus.IN_PROGRESS,
			);
			if (writing !== -1 && next[writing]?.id !== steps[writing].id) {
				throw new ConflictException(
					'The step the agent is writing can’t move. Interrupt it first.',
				);
			}
			const moved = next
				.filter((s, i) => s.id !== steps[i].id)
				.map((s) => s.title);
			await this.renumber(tx, next);
			return diff({ moved });
		});
	}

	/** Runs one edit in a transaction and records it as PLAN_UPDATED. Returns the new plan. */
	private async edit(
		membership: SessionMember,
		change: (tx: Prisma.TransactionClient, steps: PlanStep[]) => Promise<Diff>,
	): Promise<PlanStepDto[]> {
		const { sessionId, userId } = membership;
		return this.timeline.transaction(async (tx) => {
			const session = await tx.session.findUniqueOrThrow({
				where: { id: sessionId },
				select: { status: true },
			});
			if (session.status === SessionStatus.DONE) {
				throw new ConflictException('This session is done');
			}
			const steps = await tx.planStep.findMany({
				where: { sessionId },
				...ordered,
			});
			const d = await change(tx, steps);
			const changedSomething =
				d.added.length ||
				d.removed.length ||
				d.changed.length ||
				d.moved.length;
			if (changedSomething) {
				const by = await this.timeline.actorSnapshot(tx, userId);
				await this.timeline.append(tx, sessionId, {
					type: EventType.PLAN_UPDATED,
					actorType: ActorType.USER,
					actorId: userId,
					payload: {
						reason: 'edit',
						by,
						actor: by,
						diff: { ...d },
						summary: [
							d.added.length ? `Added ${d.added.join(', ')}` : '',
							d.removed.length ? `Removed ${d.removed.join(', ')}` : '',
							d.changed.length ? `Changed ${d.changed.join(', ')}` : '',
							d.moved.length ? `Moved ${d.moved.join(', ')}` : '',
						]
							.filter(Boolean)
							.join(' · '),
					},
				});
			}
			const fresh = await tx.planStep.findMany({
				where: { sessionId },
				...ordered,
			});
			return fresh.map(toPlanStepDto);
		});
	}

	private async renumber(tx: Prisma.TransactionClient, steps: PlanStep[]) {
		for (const [i, step] of steps.entries()) {
			if (step.position !== i + 1) {
				await tx.planStep.update({
					where: { id: step.id },
					data: { position: i + 1 },
				});
			}
		}
	}

	/** If the agent was waiting to mark the doc final, there's work again: cancel that and go on. */
	private async reopenIfFinishing(
		tx: Prisma.TransactionClient,
		sessionId: string,
	) {
		const { count } = await tx.approval.updateMany({
			where: {
				sessionId,
				kind: ApprovalKind.MARK_FINAL,
				status: ApprovalStatus.PENDING,
			},
			data: { status: ApprovalStatus.CANCELLED, resolvedAt: new Date() },
		});
		if (count === 0) return;
		const blocking = await tx.approval.count({
			where: {
				sessionId,
				status: ApprovalStatus.PENDING,
				kind: { in: [...BLOCKING_APPROVAL_KINDS] },
			},
		});
		if (blocking === 0) {
			await tx.session.updateMany({
				where: { id: sessionId, status: SessionStatus.WAITING },
				data: { status: SessionStatus.RUNNING, agentState: AgentState.IDLE },
			});
		}
	}
}
