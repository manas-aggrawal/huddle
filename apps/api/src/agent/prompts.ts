// Every prompt the agent sends, in one place. Inputs from people always carry
// their name and role, so the agent can tell who asked for what.

export const AGENT_SYSTEM = `You are Huddle's research agent. You work with a team of people in a shared live document: they watch you, steer you, and edit the document alongside you.
- Be accurate and specific. Prefer concrete facts, numbers and names over generalities.
- When you don't know something, say so plainly instead of inventing it.
- Respect the team's pinned decisions; they override your own judgment.
- Never rewrite or contradict text people wrote in the document unless asked.`;

export interface PlanStepBrief {
	position: number;
	title: string;
	description?: string | null;
	status?: string;
}

export interface TeamInput {
	author: string;
	role: string;
	content: string;
}

const bullets = (lines: string[]) => lines.map((l) => `- ${l}`).join('\n');

export function decisionsBlock(decisions: string[]): string {
	return decisions.length
		? `Pinned decisions (the team agreed on these; follow them):\n${bullets(decisions)}`
		: '';
}

export function teamInputBlock(inputs: TeamInput[]): string {
	return inputs.length
		? `Input from the team:\n${bullets(inputs.map((i) => `${i.author} (${i.role.toLowerCase()}): ${i.content}`))}`
		: '';
}

export function outlineBlock(steps: PlanStepBrief[], currentPosition?: number) {
	return steps
		.map(
			(s, i) =>
				`${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}${s.position === currentPosition ? '   ← you are writing this one' : ''}`,
		)
		.join('\n');
}

const join = (...parts: string[]) => parts.filter(Boolean).join('\n\n');

export function outlinePrompt(input: {
	title: string;
	goal: string;
	teamInput: TeamInput[];
	decisions: string[];
	/** A rejected outline and why, when revising. */
	rejected?: { steps: PlanStepBrief[]; note: string | null; by: string };
}): string {
	return join(
		`Session: ${input.title}\nGoal: ${input.goal}`,
		teamInputBlock(input.teamInput),
		decisionsBlock(input.decisions),
		input.rejected
			? `${input.rejected.by} rejected your previous outline${input.rejected.note ? `, saying: "${input.rejected.note}"` : ''}.\nPrevious outline:\n${outlineBlock(input.rejected.steps)}\nRevise it to address that feedback.`
			: '',
		`Propose an outline for the document as 3 to 7 sections, in reading order. Each section gets a short title (at most 8 words) and a one-sentence description of what it will cover.

Reply with only JSON in this exact shape:
{"steps":[{"title":"...","description":"..."}]}`,
	);
}

export function sectionPrompt(input: {
	goal: string;
	steps: PlanStepBrief[];
	step: PlanStepBrief;
	decisions: string[];
	/** Earlier sections, shortened. */
	previous: { title: string; excerpt: string }[];
	/** Text already in this section (a person's edits, or a write that was cut off). */
	existing: string;
}): string {
	const { step } = input;
	return join(
		`Goal of the document: ${input.goal}`,
		`Outline:\n${outlineBlock(input.steps, step.position)}`,
		decisionsBlock(input.decisions),
		input.previous.length
			? `Earlier sections (shortened):\n${input.previous.map((p) => `## ${p.title}\n${p.excerpt}`).join('\n\n')}`
			: '',
		input.existing.trim()
			? `This section already contains the text below. Continue from where it stops; don't repeat it.\n"""\n${input.existing.trim()}\n"""`
			: '',
		`Write the body of the section "${step.title}"${step.description ? ` (${step.description})` : ''}.
- 2 to 4 paragraphs of plain prose, separated by blank lines.
- No heading, no title line, no markdown headers or bold.
- Don't repeat what earlier sections already said.`,
	);
}
