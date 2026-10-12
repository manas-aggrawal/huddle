import { StepStatus } from '@huddle/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { api, unwrap } from '../../lib/api';
import { type PlanStep, sessionKey } from '../../lib/session';
import {
	AlertIcon,
	CheckIcon,
	CircleIcon,
	cx,
	DotIcon,
	GripIcon,
	LockIcon,
	MoreIcon,
	PlusIcon,
	Popover,
	SkipIcon,
} from '../ui';
import { Pane } from './Pane';

const STATUS: Record<
	StepStatus,
	{ icon: ReactNode; label: string; className: string }
> = {
	[StepStatus.PENDING]: {
		icon: <CircleIcon size={14} />,
		label: 'Not started',
		className: 'text-muted',
	},
	[StepStatus.IN_PROGRESS]: {
		icon: <DotIcon size={14} className="animate-pulse" />,
		label: 'In progress',
		className: 'text-accent',
	},
	[StepStatus.DONE]: {
		icon: <CheckIcon size={14} />,
		label: 'Done',
		className: 'text-ok',
	},
	[StepStatus.SKIPPED]: {
		icon: <SkipIcon size={14} />,
		label: 'Skipped',
		className: 'text-muted',
	},
	[StepStatus.BLOCKED]: {
		icon: <AlertIcon size={14} />,
		label: 'Blocked',
		className: 'text-warn',
	},
};

type StepPatch = {
	title?: string;
	requiresApproval?: boolean;
	skipped?: boolean;
};

/** Plan edits. Each call returns the whole plan, which replaces the cached one. */
function usePlanEdits(sessionId: string) {
	const queryClient = useQueryClient();
	const key = sessionKey(sessionId);
	const apply = (planSteps: PlanStep[]) =>
		queryClient.setQueryData(
			key,
			(old: { planSteps: PlanStep[] } | undefined) =>
				old ? { ...old, planSteps } : old,
		);
	const onError = () => queryClient.invalidateQueries({ queryKey: key });
	const path = { params: { path: { id: sessionId } } };
	return {
		add: useMutation({
			mutationFn: (body: { title: string; after?: string | null }) =>
				unwrap(api.POST('/sessions/{id}/plan-steps', { ...path, body })),
			onSuccess: apply,
			onError,
		}),
		update: useMutation({
			mutationFn: ({ stepId, ...body }: StepPatch & { stepId: string }) =>
				unwrap(
					api.PATCH('/sessions/{id}/plan-steps/{stepId}', {
						params: { path: { id: sessionId, stepId } },
						body,
					}),
				),
			onSuccess: apply,
			onError,
		}),
		remove: useMutation({
			mutationFn: (stepId: string) =>
				unwrap(
					api.DELETE('/sessions/{id}/plan-steps/{stepId}', {
						params: { path: { id: sessionId, stepId } },
					}),
				),
			onSuccess: apply,
			onError,
		}),
		reorder: useMutation({
			mutationFn: (orderedIds: string[]) =>
				unwrap(
					api.POST('/sessions/{id}/plan-steps/reorder', {
						...path,
						body: { orderedIds },
					}),
				),
			onSuccess: apply,
			onError,
		}),
	};
}

export function PlanPane({
	sessionId,
	steps,
	planning,
	canEdit,
	gatedStepIds = new Set(),
	footer,
	className,
}: {
	sessionId: string;
	steps: PlanStep[];
	/** Session is in PLANNING: the agent is drafting the outline. */
	planning: boolean;
	/** Editors and the Owner. Viewers get a plain list: no handles, menus or inputs. */
	canEdit: boolean;
	/** Steps with a pending approval of their own. */
	gatedStepIds?: Set<string>;
	/** Shown under the plan (the pinned decisions). */
	footer?: ReactNode;
	className?: string;
}) {
	const edits = usePlanEdits(sessionId);
	const [order, setOrder] = useState(steps);
	const [dragging, setDragging] = useState<string | null>(null);
	const [adding, setAdding] = useState('');
	// Server data wins whenever it changes (others' edits arrive live).
	useEffect(() => setOrder(steps), [steps]);

	const done = steps.filter((s) => s.status === StepStatus.DONE).length;
	const error =
		edits.add.error ??
		edits.update.error ??
		edits.remove.error ??
		edits.reorder.error;

	const moveOver = (overId: string) => {
		if (!dragging || dragging === overId) return;
		setOrder((list) => {
			const from = list.findIndex((s) => s.id === dragging);
			const to = list.findIndex((s) => s.id === overId);
			if (from === -1 || to === -1) return list;
			const next = [...list];
			const [moved] = next.splice(from, 1);
			next.splice(to, 0, moved);
			return next;
		});
	};
	const drop = () => {
		setDragging(null);
		const ids = order.map((s) => s.id);
		if (ids.join() !== steps.map((s) => s.id).join()) edits.reorder.mutate(ids);
	};

	return (
		<Pane
			title="Plan"
			aside={
				steps.length > 0 && (
					<span className="text-xs text-muted">
						{done}/{steps.length} done
					</span>
				)
			}
			className={className}
			bodyClassName="overflow-y-auto"
		>
			{steps.length === 0 && planning ? (
				<div
					className="flex items-center gap-2 p-4 text-sm text-muted"
					role="status"
				>
					<span
						aria-hidden
						className="size-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent"
					/>
					Agent is drafting an outline…
				</div>
			) : steps.length === 0 ? (
				<p className="p-4 text-sm text-muted">No plan yet.</p>
			) : (
				<ol className="flex flex-col gap-0.5 p-2">
					{order.map((step, i) => (
						<StepRow
							key={step.id}
							step={step}
							number={i + 1}
							canEdit={canEdit}
							gated={gatedStepIds.has(step.id)}
							dragging={dragging === step.id}
							onDragStart={() => setDragging(step.id)}
							onDragOver={() => moveOver(step.id)}
							onDrop={drop}
							onPatch={(patch) =>
								edits.update.mutate({ stepId: step.id, ...patch })
							}
							onDelete={() => edits.remove.mutate(step.id)}
						/>
					))}
				</ol>
			)}
			{canEdit && steps.length > 0 && (
				<form
					className="flex gap-1.5 px-3 pb-3"
					onSubmit={(e) => {
						e.preventDefault();
						if (!adding.trim()) return;
						edits.add.mutate({ title: adding.trim() });
						setAdding('');
					}}
				>
					<label className="flex h-8 flex-1 items-center gap-1.5 rounded-lg border border-dashed border-line px-2 text-sm focus-within:border-focus">
						<PlusIcon size={13} className="text-muted" />
						<input
							aria-label="Add a step"
							value={adding}
							onChange={(e) => setAdding(e.target.value)}
							maxLength={200}
							placeholder="Add a step…"
							className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
						/>
					</label>
				</form>
			)}
			{error && (
				<p role="alert" className="px-3 pb-2 text-xs text-danger">
					{error.message}
				</p>
			)}
			{footer}
		</Pane>
	);
}

function StepRow({
	step,
	number,
	canEdit,
	gated,
	dragging,
	onDragStart,
	onDragOver,
	onDrop,
	onPatch,
	onDelete,
}: {
	step: PlanStep;
	number: number;
	canEdit: boolean;
	gated: boolean;
	dragging: boolean;
	onDragStart: () => void;
	onDragOver: () => void;
	onDrop: () => void;
	onPatch: (patch: StepPatch) => void;
	onDelete: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [title, setTitle] = useState(step.title);
	const status = STATUS[step.status as StepStatus] ?? STATUS.PENDING;
	const current = step.status === StepStatus.IN_PROGRESS;
	const skipped = step.status === StepStatus.SKIPPED;
	// The step being written stays put: interrupt the agent to change it.
	const movable = canEdit && !current;

	const save = () => {
		setEditing(false);
		const next = title.trim();
		if (next && next !== step.title) onPatch({ title: next });
		else setTitle(step.title);
	};

	return (
		<li
			aria-current={current ? 'step' : undefined}
			draggable={movable && !editing}
			onDragStart={(e) => {
				e.dataTransfer.effectAllowed = 'move';
				onDragStart();
			}}
			onDragOver={(e) => {
				if (!canEdit) return;
				e.preventDefault();
				onDragOver();
			}}
			onDragEnd={onDrop}
			className={cx(
				'group flex gap-2 rounded-lg px-2 py-2',
				current && 'bg-accent-soft',
				dragging && 'opacity-50',
			)}
		>
			{canEdit && (
				<span
					aria-hidden
					className={cx(
						'mt-0.5 shrink-0 text-muted/60',
						movable
							? 'cursor-grab opacity-0 group-hover:opacity-100'
							: 'invisible',
					)}
				>
					<GripIcon size={13} />
				</span>
			)}
			<span
				className={cx('mt-0.5 shrink-0', status.className)}
				title={status.label}
			>
				{status.icon}
				<span className="sr-only">{status.label}</span>
			</span>
			<div className="min-w-0 flex-1">
				{editing ? (
					<input
						aria-label="Step title"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						onBlur={save}
						onKeyDown={(e) => {
							if (e.key === 'Enter') save();
							if (e.key === 'Escape') {
								setTitle(step.title);
								setEditing(false);
							}
						}}
						maxLength={200}
						autoFocus
						className="w-full rounded border border-focus bg-surface px-1 text-sm outline-none"
					/>
				) : (
					<p
						className={cx(
							'text-sm leading-snug',
							skipped && 'text-muted line-through',
							current && 'font-medium',
						)}
					>
						<span className="text-muted">{number}. </span>
						{canEdit && !current ? (
							<button
								type="button"
								className="text-left hover:underline"
								title="Rename"
								onClick={() => setEditing(true)}
							>
								{step.title}
							</button>
						) : (
							step.title
						)}
					</p>
				)}
				{gated && (
					<p className="mt-0.5 text-xs font-medium text-warn">
						Waiting for approval
					</p>
				)}
				{step.description && (
					<p className="mt-0.5 line-clamp-2 text-xs text-muted">
						{step.description}
					</p>
				)}
			</div>
			{step.requiresApproval && (
				<span
					className="mt-0.5 shrink-0 text-warn"
					title="Needs approval before the agent starts it"
				>
					<LockIcon size={13} />
					<span className="sr-only">Needs approval</span>
				</span>
			)}
			{canEdit && !current && (
				<Popover
					label={`Options for ${step.title}`}
					trigger={
						<span className="flex size-6 items-center justify-center rounded text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-2 focus-visible:opacity-100">
							<MoreIcon size={14} />
						</span>
					}
					className="w-48 p-1"
				>
					{(close) => (
						<div className="flex flex-col text-sm">
							{step.status !== StepStatus.DONE && (
								<MenuItem
									onClick={() => {
										onPatch({ skipped: !skipped });
										close();
									}}
								>
									{skipped ? 'Bring back' : 'Skip'}
								</MenuItem>
							)}
							{step.status !== StepStatus.DONE && !skipped && (
								<MenuItem
									onClick={() => {
										onPatch({ requiresApproval: !step.requiresApproval });
										close();
									}}
								>
									{step.requiresApproval
										? 'Don’t need approval'
										: 'Needs approval'}
								</MenuItem>
							)}
							<MenuItem
								danger
								onClick={() => {
									onDelete();
									close();
								}}
							>
								Delete
							</MenuItem>
						</div>
					)}
				</Popover>
			)}
		</li>
	);
}

function MenuItem({
	children,
	onClick,
	danger,
}: {
	children: ReactNode;
	onClick: () => void;
	danger?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cx(
				'rounded-md px-2.5 py-1.5 text-left hover:bg-surface-2',
				danger && 'text-danger',
			)}
		>
			{children}
		</button>
	);
}
