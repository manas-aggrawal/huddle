import {
	can,
	type MembershipLike,
	MessageLimits,
	MessageMode,
	type PresenceMember,
} from '@huddle/shared';
import { useMutation } from '@tanstack/react-query';
import {
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { api, unwrap } from '../../lib/api';
import { type Member, memberName } from '../../lib/session';
import { Avatar, Button, cx } from '../ui';

type ComposerMode = 'SUGGEST' | 'INTERRUPT' | 'ASK';

const MODES: {
	mode: ComposerMode;
	label: string;
	action: 'suggest' | 'interrupt' | 'ask';
	placeholder: string;
	hint: string;
}[] = [
	{
		mode: MessageMode.SUGGEST,
		label: 'Suggest',
		action: 'suggest',
		placeholder: 'Suggest something to the agent…',
		hint: 'The agent works it in after the current section.',
	},
	{
		mode: MessageMode.INTERRUPT,
		label: 'Interrupt',
		action: 'interrupt',
		placeholder: 'Tell the agent to stop and change course…',
		hint: 'Stops the agent now. It replans with your message.',
	},
	{
		mode: MessageMode.ASK,
		label: 'Ask',
		action: 'ask',
		placeholder: 'Ask the agent a question…',
		hint: 'Answered right away. Doesn’t change the plan.',
	},
];

/** The "@que" being typed right before the caret, if any. */
function mentionQuery(
	text: string,
	caret: number,
): { start: number; query: string } | null {
	const m = text.slice(0, caret).match(/(^|\s)@([^\s@]{0,30})$/u);
	if (!m) return null;
	return { start: caret - m[2].length - 1, query: m[2].toLowerCase() };
}

/** Swaps the "@Name" of each picked mention for "@[userId]", the form the API stores. */
function encodeMentions(text: string, picked: Map<string, string>): string {
	let out = text;
	for (const [name, id] of picked) out = out.split(`@${name}`).join(`@[${id}]`);
	return out;
}

/**
 * Message box under the timeline. People with several modes get a picker
 * (Suggest by default); Viewers only Ask, so they get a plain box.
 * Enter sends, Shift+Enter adds a line. Typing shows up in presence.
 */
export function Composer({
	sessionId,
	me,
	myUserId,
	members,
	presence,
	askOnly = false,
	onTyping,
	draft,
}: {
	sessionId: string;
	me: MembershipLike;
	myUserId: string;
	members: Member[];
	presence: PresenceMember[];
	/** The session is done: only questions are still answered. */
	askOnly?: boolean;
	onTyping: (typing: boolean) => void;
	/** Text to put in the box (e.g. from "Discuss" on an approval), with a counter so the same text can be sent twice. */
	draft?: { text: string; n: number } | null;
}) {
	const modes = MODES.filter(
		(m) => can(me, m.action) && (!askOnly || m.mode === MessageMode.ASK),
	);
	const [chosen, setMode] = useState<ComposerMode>(modes[0]?.mode ?? 'ASK');
	// The mode list can shrink (session ends); fall back to the first one left.
	const mode = modes.some((m) => m.mode === chosen)
		? chosen
		: (modes[0]?.mode ?? 'ASK');
	const [text, setText] = useState('');
	const [mention, setMention] = useState<{
		start: number;
		query: string;
	} | null>(null);
	const [active, setActive] = useState(0);
	const picked = useRef(new Map<string, string>());
	const box = useRef<HTMLTextAreaElement>(null);
	const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const typing = useRef(false);

	useEffect(() => {
		if (!draft) return;
		setText(draft.text);
		box.current?.focus();
	}, [draft]);

	const setTyping = (on: boolean) => {
		clearTimeout(typingTimer.current);
		if (on) typingTimer.current = setTimeout(() => setTyping(false), 3000);
		if (typing.current === on) return;
		typing.current = on;
		onTyping(on);
	};
	useEffect(() => () => clearTimeout(typingTimer.current), []);

	const candidates = useMemo(() => {
		if (!mention) return [];
		return members
			.filter((m) => m.userId !== myUserId)
			.filter((m) => {
				const name = memberName(m).toLowerCase();
				return (
					name.startsWith(mention.query) ||
					name.split(' ').some((part) => part.startsWith(mention.query)) ||
					m.username.toLowerCase().startsWith(mention.query)
				);
			})
			.slice(0, 6);
	}, [mention, members, myUserId]);

	const send = useMutation({
		mutationFn: (body: { mode: ComposerMode; content: string }) =>
			unwrap(
				api.POST('/sessions/{id}/messages', {
					params: { path: { id: sessionId } },
					body,
				}),
			),
		onSuccess: () => {
			setText('');
			picked.current.clear();
			setMention(null);
		},
	});

	if (modes.length === 0) return null;

	const current = MODES.find((m) => m.mode === mode) ?? MODES[0];
	const othersTyping = presence.filter(
		(p) => p.typing && p.userId !== myUserId,
	);

	const pick = (member: Member) => {
		if (!mention) return;
		const name = memberName(member);
		picked.current.set(name, member.userId);
		const caret = box.current?.selectionStart ?? text.length;
		const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`;
		setText(next);
		setMention(null);
		requestAnimationFrame(() => {
			const at = mention.start + name.length + 2;
			box.current?.setSelectionRange(at, at);
			box.current?.focus();
		});
	};

	const submit = () => {
		const content = encodeMentions(text.trim(), picked.current);
		if (!content || send.isPending) return;
		setTyping(false);
		send.mutate({ mode, content });
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (mention && candidates.length > 0) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const d = e.key === 'ArrowDown' ? 1 : -1;
				setActive((i) => (i + d + candidates.length) % candidates.length);
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				pick(candidates[active] ?? candidates[0]);
				return;
			}
			if (e.key === 'Escape') {
				setMention(null);
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
	};

	return (
		<div className="relative border-t border-line bg-surface p-3">
			{othersTyping.length > 0 && (
				<p className="mb-1.5 text-xs text-muted" aria-live="polite">
					{othersTyping.map((p) => p.name.split(' ')[0]).join(', ')}{' '}
					{othersTyping.length > 1 ? 'are' : 'is'} typing to the agent…
				</p>
			)}
			{modes.length > 1 && (
				<div
					role="radiogroup"
					aria-label="Message type"
					className="mb-2 flex gap-1"
				>
					{modes.map((m) => (
						<button
							key={m.mode}
							type="button"
							role="radio"
							aria-checked={mode === m.mode}
							onClick={() => setMode(m.mode)}
							className={cx(
								'rounded-md px-2.5 py-1 text-xs font-medium transition',
								mode === m.mode
									? m.mode === MessageMode.INTERRUPT
										? 'bg-warn-soft text-warn'
										: 'bg-accent-soft text-accent'
									: 'text-muted hover:bg-surface-2',
							)}
						>
							{m.label}
						</button>
					))}
				</div>
			)}
			{mention && candidates.length > 0 && (
				<ul
					role="listbox"
					aria-label="Mention someone"
					className="absolute bottom-full left-3 z-10 mb-1 w-64 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-card"
				>
					{candidates.map((m, i) => (
						<li
							key={m.userId}
							role="option"
							aria-selected={i === active}
							onPointerDown={(e) => {
								e.preventDefault();
								pick(m);
							}}
							className={cx(
								'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm',
								i === active && 'bg-surface-2',
							)}
						>
							<Avatar userId={m.userId} name={memberName(m)} size="sm" />
							<span className="truncate">{memberName(m)}</span>
						</li>
					))}
				</ul>
			)}
			<form
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
				className="flex items-end gap-2"
			>
				<textarea
					ref={box}
					aria-label={current.placeholder}
					value={text}
					rows={2}
					maxLength={MessageLimits.CONTENT_MAX}
					placeholder={current.placeholder}
					onChange={(e) => {
						setText(e.target.value);
						setMention(mentionQuery(e.target.value, e.target.selectionStart));
						setActive(0);
						setTyping(e.target.value.length > 0);
					}}
					onKeyDown={onKeyDown}
					onBlur={() => setTyping(false)}
					className={cx(
						'max-h-40 min-h-10 flex-1 resize-none rounded-lg border bg-surface px-3 py-2 text-sm text-ink outline-none transition',
						'placeholder:text-muted focus:border-focus',
						mode === MessageMode.INTERRUPT ? 'border-warn' : 'border-line',
					)}
				/>
				<Button
					type="submit"
					size="sm"
					variant={mode === MessageMode.INTERRUPT ? 'danger' : 'primary'}
					loading={send.isPending}
					disabled={!text.trim()}
				>
					{mode === MessageMode.INTERRUPT ? 'Interrupt' : 'Send'}
				</Button>
			</form>
			<p className="mt-1.5 text-xs text-muted">
				{send.error ? (
					<span role="alert" className="text-danger">
						{send.error.message}
					</span>
				) : (
					current.hint
				)}
			</p>
		</div>
	);
}
