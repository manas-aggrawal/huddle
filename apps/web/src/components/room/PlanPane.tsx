import { StepStatus } from '@huddle/shared';
import type { ReactNode } from 'react';
import type { PlanStep } from '../../lib/session';
import {
	AlertIcon,
	CheckIcon,
	CircleIcon,
	cx,
	DotIcon,
	LockIcon,
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

export function PlanPane({
	steps,
	planning,
	gatedStepIds = new Set(),
	className,
}: {
	steps: PlanStep[];
	/** Steps with a pending approval of their own. */
	gatedStepIds?: Set<string>;
	/** Session is in PLANNING: the agent is drafting the outline. */
	planning: boolean;
	className?: string;
}) {
	const done = steps.filter((s) => s.status === StepStatus.DONE).length;
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
					{steps.map((step, i) => {
						const status = STATUS[step.status as StepStatus] ?? STATUS.PENDING;
						const current = step.status === StepStatus.IN_PROGRESS;
						return (
							<li
								key={step.id}
								aria-current={current ? 'step' : undefined}
								className={cx(
									'flex gap-2.5 rounded-lg px-2 py-2',
									current && 'bg-accent-soft',
								)}
							>
								<span
									className={cx('mt-0.5 shrink-0', status.className)}
									title={status.label}
								>
									{status.icon}
									<span className="sr-only">{status.label}</span>
								</span>
								<div className="min-w-0 flex-1">
									<p
										className={cx(
											'text-sm leading-snug',
											step.status === StepStatus.SKIPPED &&
												'text-muted line-through',
											current && 'font-medium',
										)}
									>
										<span className="text-muted">{i + 1}. </span>
										{step.title}
									</p>
									{gatedStepIds.has(step.id) && (
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
							</li>
						);
					})}
				</ol>
			)}
		</Pane>
	);
}
