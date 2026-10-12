import { StepStatus } from '@huddle/shared';
import { PlanStep, Prisma } from '@prisma/client';
import { z } from 'zod';

// Plan changes the model can ask for. Steps are referred to by their number
// in the plan as the model saw it (1, 2, 3…), which models handle far better
// than ids. Only steps that haven't started can be changed.

const position = z.number().int().min(1);
const title = z.string().trim().min(1).max(200);
const description = z.string().trim().max(1000).nullish();

export const PlanOpSchema = z.discriminatedUnion('op', [
	z.object({
		op: z.literal('add'),
		title,
		description,
		/** Goes after this step; 0 puts it first, omitted puts it last. */
		after: z.number().int().min(0).optional(),
	}),
	z.object({
		op: z.literal('edit'),
		position,
		title: title.optional(),
		description,
	}),
	z.object({ op: z.literal('remove'), position }),
	z.object({
		op: z.literal('move'),
		position,
		after: z.number().int().min(0),
	}),
]);
export type PlanOp = z.infer<typeof PlanOpSchema>;

export interface PlanDiff {
	added: string[];
	removed: string[];
	/** "Old title → New title", or the title when only the description changed. */
	changed: string[];
	moved: string[];
}

export const emptyDiff = (): PlanDiff => ({
	added: [],
	removed: [],
	changed: [],
	moved: [],
});

export const diffIsEmpty = (d: PlanDiff) =>
	!d.added.length && !d.removed.length && !d.changed.length && !d.moved.length;

/** One line for the timeline: "Added UX notes · Removed Pricing". */
export function summarizeDiff(d: PlanDiff): string {
	return [
		d.added.length ? `Added ${d.added.join(', ')}` : '',
		d.removed.length ? `Removed ${d.removed.join(', ')}` : '',
		d.changed.length ? `Changed ${d.changed.join(', ')}` : '',
		d.moved.length ? `Moved ${d.moved.join(', ')}` : '',
	]
		.filter(Boolean)
		.join(' · ');
}

const canChange = (s: { status: string }) =>
	s.status === StepStatus.PENDING || s.status === StepStatus.BLOCKED;

type Item =
	| { kind: 'existing'; step: PlanStep }
	| { kind: 'new'; title: string; description: string | null };

/**
 * Applies the ops in order, then renumbers the plan 1..n. Ops on steps that
 * have started, or on numbers that don't exist, are skipped. Returns what
 * changed.
 */
export async function applyPlanOps(
	tx: Prisma.TransactionClient,
	sessionId: string,
	ops: PlanOp[],
	createdById: string | null = null,
): Promise<PlanDiff> {
	const steps = await tx.planStep.findMany({
		where: { sessionId },
		orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
	});
	const diff = emptyDiff();
	// Numbers refer to the plan as it was shown, before any op ran.
	const byNumber = new Map(steps.map((s, i) => [i + 1, s]));
	let order: Item[] = steps.map((step) => ({ kind: 'existing', step }));
	const removed = new Set<string>();
	const edits = new Map<
		string,
		{ title?: string; description?: string | null }
	>();

	const indexAfter = (number: number | undefined): number => {
		if (number === undefined) return order.length;
		if (number === 0) return 0;
		const anchor = byNumber.get(number);
		if (!anchor) return order.length;
		const i = order.findIndex(
			(it) => it.kind === 'existing' && it.step.id === anchor.id,
		);
		return i === -1 ? order.length : i + 1;
	};

	for (const op of ops) {
		if (op.op === 'add') {
			order.splice(indexAfter(op.after), 0, {
				kind: 'new',
				title: op.title,
				description: op.description ?? null,
			});
			diff.added.push(op.title);
			continue;
		}
		const step = byNumber.get(op.position);
		if (!step || !canChange(step) || removed.has(step.id)) continue;
		if (op.op === 'remove') {
			removed.add(step.id);
			// A step with a section keeps its place (skipped); one that never started goes.
			if (!step.sectionId) {
				order = order.filter(
					(it) => !(it.kind === 'existing' && it.step.id === step.id),
				);
			}
			diff.removed.push(step.title);
		} else if (op.op === 'edit') {
			const next = { ...edits.get(step.id) };
			if (op.title && op.title !== step.title) next.title = op.title;
			if (op.description !== undefined && op.description !== step.description) {
				next.description = op.description ?? null;
			}
			if (next.title === undefined && next.description === undefined) continue;
			edits.set(step.id, next);
			diff.changed.push(
				next.title ? `${step.title} → ${next.title}` : step.title,
			);
		} else if (op.op === 'move') {
			if (op.after === op.position) continue;
			const from = order.findIndex(
				(it) => it.kind === 'existing' && it.step.id === step.id,
			);
			const [item] = order.splice(from, 1);
			order.splice(indexAfter(op.after), 0, item);
			diff.moved.push(step.title);
		}
	}

	for (const id of removed) {
		const step = steps.find((s) => s.id === id);
		if (step?.sectionId) {
			await tx.planStep.update({
				where: { id },
				data: { status: StepStatus.SKIPPED },
			});
		} else {
			await tx.planStep.delete({ where: { id } });
		}
	}

	for (const [i, item] of order.entries()) {
		const position = i + 1;
		if (item.kind === 'new') {
			await tx.planStep.create({
				data: {
					sessionId,
					position,
					title: item.title,
					description: item.description,
					createdById,
				},
			});
			continue;
		}
		const edit = edits.get(item.step.id) ?? {};
		if (
			item.step.position !== position ||
			edit.title !== undefined ||
			edit.description !== undefined
		) {
			await tx.planStep.update({
				where: { id: item.step.id },
				data: { position, ...edit },
			});
		}
	}
	return diff;
}
