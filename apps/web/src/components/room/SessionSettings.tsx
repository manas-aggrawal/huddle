import { Effort, type SessionUsage } from '@huddle/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../lib/api';
import { type SessionDetail, sessionKey } from '../../lib/session';
import { Button, cx, Popover } from '../ui';

const EFFORT_LABEL: Record<Effort, string> = {
	[Effort.LOW]: 'Low',
	[Effort.MEDIUM]: 'Medium',
	[Effort.HIGH]: 'High',
};

const compact = (n: number) =>
	new Intl.NumberFormat('en', {
		notation: 'compact',
		maximumFractionDigits: 1,
	}).format(n);

/** Green under 80%, orange from 80%, red at 100%. */
const tone = (ratio: number) =>
	ratio >= 1 ? 'bg-danger' : ratio >= 0.8 ? 'bg-warn' : 'bg-ok';

function Meter({
	label,
	used,
	of,
}: {
	label: string;
	used: number;
	of: number | null;
}) {
	const ratio = of ? used / of : 0;
	return (
		<div
			className="flex min-w-0 flex-col gap-0.5"
			title={`${used.toLocaleString()} ${of ? `of ${of.toLocaleString()} ` : ''}tokens`}
		>
			<span className="text-[11px] text-muted">
				{label}: {compact(used)}
				{of ? ` / ${compact(of)}` : ''}
			</span>
			{of ? (
				<span className="h-1 w-20 overflow-hidden rounded-full bg-surface-2">
					<span
						className={cx(
							'block h-full rounded-full transition-all',
							tone(ratio),
						)}
						style={{ width: `${Math.min(100, ratio * 100)}%` }}
					/>
				</span>
			) : null}
		</div>
	);
}

/**
 * The session's model, effort and token use, in the header. Everyone sees the
 * meters; only the Owner gets the settings popover.
 */
export function SessionSettings({
	session,
	usage,
	canChange,
}: {
	session: SessionDetail;
	/** Latest live numbers (null until the first model call after joining). */
	usage: SessionUsage | null;
	canChange: boolean;
}) {
	const tokensUsed = usage?.tokensUsed ?? session.tokensUsed;
	const tokenBudget = usage ? usage.tokenBudget : session.tokenBudget;
	const pool = usage?.workspace ?? session.workspaceUsage;
	const summary = `${session.modelId} · ${EFFORT_LABEL[session.effort as Effort] ?? session.effort}`;

	return (
		<div className="flex items-center gap-3">
			<Meter label="Session" used={tokensUsed} of={tokenBudget} />
			<Meter
				label="Pool"
				used={pool.tokensUsedThisPeriod}
				of={pool.tokenAllowance}
			/>
			{canChange ? (
				<Popover
					label="Model and budget"
					trigger={
						<span className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-surface-2">
							{summary}
						</span>
					}
				>
					{(close) => <SettingsForm session={session} onDone={close} />}
				</Popover>
			) : (
				<span className="text-xs text-muted">{summary}</span>
			)}
		</div>
	);
}

function SettingsForm({
	session,
	onDone,
}: {
	session: SessionDetail;
	onDone: () => void;
}) {
	const queryClient = useQueryClient();
	const models = useQuery({
		queryKey: ['models'],
		queryFn: () => unwrap(api.GET('/models')),
		staleTime: 5 * 60_000,
	});
	const [model, setModel] = useState(
		`${session.modelProvider}:${session.modelId}`,
	);
	const [effort, setEffort] = useState(session.effort as Effort);
	const [cap, setCap] = useState(
		session.tokenBudget ? String(session.tokenBudget) : '',
	);

	const save = useMutation({
		mutationFn: () => {
			const i = model.indexOf(':');
			const capNumber = cap.trim() ? Number(cap.replace(/[^\d]/g, '')) : null;
			return unwrap(
				api.PATCH('/sessions/{id}/settings', {
					params: { path: { id: session.id } },
					body: {
						modelProvider: model.slice(0, i),
						modelId: model.slice(i + 1),
						effort,
						tokenBudget: capNumber,
					},
				}),
			);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: sessionKey(session.id) });
			onDone();
		},
	});

	return (
		<form
			className="flex flex-col gap-3 text-sm"
			onSubmit={(e) => {
				e.preventDefault();
				save.mutate();
			}}
		>
			<label className="flex flex-col gap-1 font-medium">
				Model
				<select
					value={model}
					onChange={(e) => setModel(e.target.value)}
					className="h-9 rounded-lg border border-line bg-surface px-2 font-normal outline-none focus:border-focus"
				>
					{(
						models.data ?? [
							{
								provider: session.modelProvider,
								modelId: session.modelId,
								label: summaryLabel(session),
							},
						]
					).map((m) => (
						<option
							key={`${m.provider}:${m.modelId}`}
							value={`${m.provider}:${m.modelId}`}
						>
							{m.label}
						</option>
					))}
				</select>
			</label>
			<fieldset className="flex flex-col gap-1">
				<legend className="mb-1 font-medium">Effort</legend>
				<div className="flex gap-1">
					{Object.values(Effort).map((e) => (
						<button
							key={e}
							type="button"
							aria-pressed={effort === e}
							onClick={() => setEffort(e)}
							className={cx(
								'flex-1 rounded-md border px-2 py-1 text-xs',
								effort === e
									? 'border-accent bg-accent-soft text-accent'
									: 'border-line text-muted',
							)}
						>
							{EFFORT_LABEL[e]}
						</button>
					))}
				</div>
			</fieldset>
			<label className="flex flex-col gap-1 font-medium">
				Token cap for this session
				<input
					inputMode="numeric"
					value={cap}
					onChange={(e) => setCap(e.target.value)}
					placeholder="No cap"
					className="h-9 rounded-lg border border-line bg-surface px-2 font-normal outline-none placeholder:text-muted focus:border-focus"
				/>
				<span className="text-xs font-normal text-muted">
					Leave empty for no cap. Changes apply from the agent’s next step.
				</span>
			</label>
			{save.error && (
				<p role="alert" className="text-xs text-danger">
					{save.error.message}
				</p>
			)}
			<div className="flex justify-end gap-2">
				<Button type="button" size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
				<Button type="submit" size="sm" loading={save.isPending}>
					Save
				</Button>
			</div>
		</form>
	);
}

const summaryLabel = (s: SessionDetail) => `${s.modelProvider} · ${s.modelId}`;
