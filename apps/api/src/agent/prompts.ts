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

export interface HumanPassage {
	position: number;
	title: string;
	author: string;
	text: string;
}

export function humanTextBlock(passages: HumanPassage[]): string {
	return passages.length
		? `Human-authored passages (do not change these; a person wrote them):\n${bullets(passages.map((p) => `in ${p.position}. "${p.title}", by ${p.author}: "${p.text.slice(0, 300)}"`))}`
		: '';
}

export function guidanceBlock(guidance: TeamInput[]): string {
	return guidance.length
		? `Guidance from the team you agreed to follow:\n${bullets(guidance.map((g) => `${g.author}: ${g.content}`))}`
		: '';
}

export function sectionPrompt(input: {
	goal: string;
	steps: PlanStepBrief[];
	step: PlanStepBrief;
	decisions: string[];
	/** Suggestions the agent applied earlier. */
	guidance: TeamInput[];
	/** Earlier sections, shortened. */
	previous: { title: string; excerpt: string }[];
	/** Text already in this section (a person's edits, or a write that was cut off). */
	existing: string;
	humanText?: HumanPassage[];
}): string {
	const { step } = input;
	return join(
		`Goal of the document: ${input.goal}`,
		`Outline:\n${outlineBlock(input.steps, step.position)}`,
		decisionsBlock(input.decisions),
		guidanceBlock(input.guidance),
		input.previous.length
			? `Earlier sections (shortened):\n${input.previous.map((p) => `## ${p.title}\n${p.excerpt}`).join('\n\n')}`
			: '',
		humanTextBlock(input.humanText ?? []),
		input.existing.trim()
			? `This section already contains the text below. Continue from where it stops; don't repeat it.\n"""\n${input.existing.trim()}\n"""`
			: '',
		`Write the body of the section "${step.title}"${step.description ? ` (${step.description})` : ''}.
- 2 to 4 paragraphs of plain prose, separated by blank lines.
- No heading, no title line, no markdown headers or bold.
- Don't repeat what earlier sections already said.`,
	);
}

const statusWord: Record<string, string> = {
	DONE: 'done',
	IN_PROGRESS: 'writing now',
	PENDING: 'not started',
	BLOCKED: 'blocked',
	SKIPPED: 'skipped',
};

/** The plan with numbers and statuses, as the model refers to it in plan ops. */
export function numberedPlan(steps: PlanStepBrief[]): string {
	return steps
		.map(
			(s, i) =>
				`${i + 1}. [${statusWord[s.status ?? 'PENDING'] ?? s.status}] ${s.title}${s.description ? ` — ${s.description}` : ''}`,
		)
		.join('\n');
}

const PLAN_OPS_HELP = `Plan operations (only steps that are "not started" or "blocked" can change; refer to steps by number):
{"op":"add","title":"...","description":"...","after":N}   (after: step number to insert after, 0 = first, omit = last)
{"op":"edit","position":N,"title":"...","description":"..."}
{"op":"remove","position":N}
{"op":"move","position":N,"after":M}`;

export function queuePrompt(input: {
	goal: string;
	steps: PlanStepBrief[];
	decisions: string[];
	humanText?: HumanPassage[];
	messages: (TeamInput & {
		messageId: string;
		mode: string;
		quote?: string;
		section?: string;
	})[];
}): string {
	return join(
		`Goal of the document: ${input.goal}`,
		`Current plan:\n${numberedPlan(input.steps)}`,
		decisionsBlock(input.decisions),
		humanTextBlock(input.humanText ?? []),
		`New input from the team, oldest first:\n${input.messages
			.map(
				(m) =>
					`- id ${m.messageId} | ${m.author} (${m.role.toLowerCase()}) ${m.mode === 'COMMENT' ? `commented on "${m.quote ?? ''}"${m.section ? ` in "${m.section}"` : ''}` : 'suggested'}: ${m.content}`,
			)
			.join('\n')}`,
		`Decide what to do with each input:
- "apply": follow it in the sections you still have to write.
- "plan_change": change the plan (give planOps).
- "decline": don't follow it; say why politely.
To change text already written in a finished section, add "rewrite": {"position":N,"before":"exact text to replace","after":"new text"}. Changing a human-authored passage asks that person's team for approval first.
Reply to each person by first name, briefly, like a helpful teammate ("Got it, Leo — I'll add UX notes to each profile.").

${PLAN_OPS_HELP}

Reply with only JSON in this exact shape:
{"decisions":[{"messageId":"...","decision":"apply","reply":"...","planOps":[],"rewrite":null}]}`,
	);
}

export function askPrompt(input: {
	goal: string;
	steps: PlanStepBrief[];
	decisions: string[];
	sections: { title: string; excerpt: string }[];
	question: TeamInput;
}): string {
	return join(
		`Goal of the document: ${input.goal}`,
		`Plan:\n${numberedPlan(input.steps)}`,
		decisionsBlock(input.decisions),
		input.sections.length
			? `The document so far (shortened):\n${input.sections.map((s) => `## ${s.title}\n${s.excerpt}`).join('\n\n')}`
			: 'The document is still empty.',
		`${input.question.author} (${input.question.role.toLowerCase()}) asks: ${input.question.content}`,
		`Answer ${input.question.author.split(' ')[0]} directly in 1 to 4 sentences. This is a question, not an instruction: don't promise to change the plan. Plain text, no markdown.`,
	);
}

export function replanPrompt(input: {
	goal: string;
	steps: PlanStepBrief[];
	decisions: string[];
	interrupt: TeamInput;
	/** The section that was being written when the interrupt came, and what it had so far. */
	interrupted?: { title: string; text: string };
}): string {
	const first = input.interrupt.author.split(' ')[0];
	return join(
		`Goal of the document: ${input.goal}`,
		`Current plan:\n${numberedPlan(input.steps)}`,
		decisionsBlock(input.decisions),
		input.interrupted
			? `You were writing "${input.interrupted.title}" and stopped here:\n"""\n${input.interrupted.text.slice(-1500)}\n"""`
			: '',
		`${input.interrupt.author} (${input.interrupt.role.toLowerCase()}) interrupted you: ${input.interrupt.content}`,
		`Change the plan so the rest of the work follows ${first}'s instruction. Text already written stays; a stopped step can be edited, moved or removed like any not-started step. Reply to ${first} in one sentence saying what you changed.

${PLAN_OPS_HELP}

Reply with only JSON in this exact shape:
{"reply":"...","planOps":[]}`,
	);
}
