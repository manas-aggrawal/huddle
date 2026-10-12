import { Effort, SessionLimits } from '@huddle/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, api, unwrap } from '../lib/api';
import { FormError } from './CenteredPage';
import { Button, cx, Dialog, Input, Textarea } from './ui';

const EFFORTS = [
	{ value: Effort.LOW, label: 'Low', hint: 'Quick and cheap' },
	{ value: Effort.MEDIUM, label: 'Medium', hint: 'Balanced' },
	{ value: Effort.HIGH, label: 'High', hint: 'More research and steps' },
] as const;

type Errors = Partial<Record<'title' | 'goal' | 'context', string>>;

/** The same rules as the API's schema (SessionLimits), so mistakes show before any request. */
function validate(title: string, goal: string, context: string): Errors {
	const errors: Errors = {};
	if (!title.trim()) errors.title = 'Give the session a title';
	else if (title.trim().length > SessionLimits.TITLE_MAX)
		errors.title = `At most ${SessionLimits.TITLE_MAX} characters`;
	if (!goal.trim()) errors.goal = 'Describe what the team wants done';
	else if (goal.trim().length > SessionLimits.GOAL_MAX)
		errors.goal = `At most ${SessionLimits.GOAL_MAX.toLocaleString()} characters`;
	if (context.trim().length > SessionLimits.CONTEXT_MAX)
		errors.context = `At most ${SessionLimits.CONTEXT_MAX.toLocaleString()} characters`;
	return errors;
}

export function NewSessionDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [title, setTitle] = useState('');
	const [goal, setGoal] = useState('');
	const [context, setContext] = useState('');
	const [model, setModel] = useState<string | null>(null);
	const [effort, setEffort] = useState<Effort>(Effort.MEDIUM);
	const [errors, setErrors] = useState<Errors>({});

	const models = useQuery({
		queryKey: ['models'],
		queryFn: () => unwrap(api.GET('/models')),
		enabled: open,
		staleTime: Infinity,
	});
	const chosen =
		models.data?.find((m) => `${m.provider}:${m.modelId}` === model) ??
		models.data?.find((m) => m.isDefault);

	const create = useMutation({
		mutationFn: () =>
			unwrap(
				api.POST('/sessions', {
					body: {
						title: title.trim(),
						goal: goal.trim(),
						context: context.trim() || undefined,
						modelProvider: chosen?.provider,
						modelId: chosen?.modelId,
						effort,
					},
				}),
			),
		onSuccess: (session) => {
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			onClose();
			navigate(`/s/${session.id}`);
		},
	});

	function submit(e: FormEvent) {
		e.preventDefault();
		const found = validate(title, goal, context);
		setErrors(found);
		if (Object.keys(found).length === 0) create.mutate();
	}

	const serverError =
		create.error instanceof ApiError || create.error
			? create.error.message
			: null;

	return (
		<Dialog open={open} onClose={onClose} title="New session">
			<form onSubmit={submit} noValidate className="flex flex-col gap-4">
				<FormError message={serverError} />
				<Input
					label="Title"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					error={errors.title}
					placeholder="Competitive analysis"
					autoFocus
				/>
				<Textarea
					label="Goal"
					value={goal}
					onChange={(e) => setGoal(e.target.value)}
					error={errors.goal}
					placeholder="Compare the top 5 note-taking apps on pricing, collaboration and offline support"
					rows={3}
				/>
				<Textarea
					label="Context (optional)"
					value={context}
					onChange={(e) => setContext(e.target.value)}
					error={errors.context}
					hint="Notes or links for the agent. It's sent as your first suggestion."
					rows={3}
				/>
				<div className="grid gap-4 sm:grid-cols-2">
					<label className="flex flex-col gap-1.5 text-sm">
						<span className="font-medium">Model</span>
						<select
							value={chosen ? `${chosen.provider}:${chosen.modelId}` : ''}
							onChange={(e) => setModel(e.target.value)}
							className="h-10 rounded-lg border border-line bg-surface px-2 text-sm"
						>
							{models.data?.map((m) => (
								<option
									key={`${m.provider}:${m.modelId}`}
									value={`${m.provider}:${m.modelId}`}
								>
									{m.label}
									{m.isDefault ? ' (default)' : ''}
								</option>
							))}
						</select>
					</label>
					<fieldset className="flex flex-col gap-1.5">
						<legend className="mb-1.5 text-sm font-medium">Effort</legend>
						<div className="grid grid-cols-3 rounded-lg border border-line p-0.5">
							{EFFORTS.map((x) => (
								<label
									key={x.value}
									title={x.hint}
									className={cx(
										'cursor-pointer rounded-md py-1.5 text-center text-sm',
										effort === x.value
											? 'bg-accent-soft font-medium text-accent'
											: 'text-muted',
									)}
								>
									<input
										type="radio"
										name="effort"
										value={x.value}
										checked={effort === x.value}
										onChange={() => setEffort(x.value)}
										className="sr-only"
									/>
									{x.label}
								</label>
							))}
						</div>
					</fieldset>
				</div>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button type="submit" loading={create.isPending}>
						Start session
					</Button>
				</div>
			</form>
		</Dialog>
	);
}
