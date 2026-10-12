import { MessageStatus } from '@huddle/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEffect, useState } from 'react';
import { api, type Schemas, unwrap } from '../../lib/api';
import {
	sectionAt,
	setCommentRanges,
	toAbsolute,
	toRelative,
} from '../../lib/doc/comments';
import { MESSAGE_STATUS } from '../../lib/messages';
import { Avatar, Badge, Button, XIcon } from '../ui';

type Comment = Schemas['MessageWithAuthorDto_Output'];
type Anchor = { sectionId: string; quote: string; from?: string; to?: string };

export const commentsKey = (sessionId: string) =>
	['comments', sessionId] as const;

export function useComments(sessionId: string) {
	return useQuery({
		queryKey: commentsKey(sessionId),
		queryFn: () =>
			unwrap(
				api.GET('/sessions/{id}/messages', {
					params: { path: { id: sessionId }, query: { mode: 'COMMENT' } },
				}),
			),
	});
}

/**
 * Comments on the doc: select text → Comment (everyone, Viewers too). Commented
 * text is highlighted; clicking it opens the thread with the agent's reply.
 */
export function DocComments({
	editor,
	sessionId,
	active,
	onActive,
}: {
	editor: Editor;
	sessionId: string;
	active: string | null;
	onActive: (id: string | null) => void;
}) {
	const comments = useComments(sessionId);
	const queryClient = useQueryClient();
	const [writing, setWriting] = useState(false);
	const [text, setText] = useState('');

	// Resolve each anchor to where its words are now, and highlight them.
	useEffect(() => {
		const ranges = (comments.data ?? [])
			.map((c) => {
				const a = (c.anchor ?? {}) as Anchor;
				const from = toAbsolute(editor, a.from);
				const to = toAbsolute(editor, a.to);
				return from !== null && to !== null && to > from
					? { id: c.id, from, to }
					: null;
			})
			.filter((r): r is { id: string; from: number; to: number } => r !== null);
		setCommentRanges(editor, ranges, active);
	}, [editor, comments.data, active]);

	const post = useMutation({
		mutationFn: async () => {
			const { from, to } = editor.state.selection;
			const anchor: Anchor = {
				sectionId: sectionAt(editor.state.doc, from) ?? 'none',
				quote: editor.state.doc.textBetween(from, to, ' ').slice(0, 1000),
				from: toRelative(editor, from) ?? undefined,
				to: toRelative(editor, to) ?? undefined,
			};
			return unwrap(
				api.POST('/sessions/{id}/messages', {
					params: { path: { id: sessionId } },
					body: { mode: 'COMMENT', content: text.trim(), anchor },
				}),
			);
		},
		onSuccess: (c) => {
			setWriting(false);
			setText('');
			onActive(c.id);
			void queryClient.invalidateQueries({ queryKey: commentsKey(sessionId) });
		},
	});

	const open = comments.data?.find((c) => c.id === active);

	return (
		<>
			<BubbleMenu
				editor={editor}
				shouldShow={({ state }) =>
					!state.selection.empty &&
					state.doc.textBetween(state.selection.from, state.selection.to).trim()
						.length > 0
				}
				options={{ placement: 'top' }}
			>
				<div className="rounded-lg border border-line bg-surface p-1.5 shadow-card">
					{writing ? (
						<form
							className="flex w-72 flex-col gap-1.5"
							onSubmit={(e) => {
								e.preventDefault();
								if (text.trim()) post.mutate();
							}}
						>
							<textarea
								aria-label="Your comment"
								value={text}
								onChange={(e) => setText(e.target.value)}
								maxLength={4000}
								rows={3}
								placeholder="e.g. Be more skeptical here"
								className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm outline-none focus:border-focus"
								onKeyDown={(e) => {
									if (e.key === 'Enter' && !e.shiftKey) {
										e.preventDefault();
										if (text.trim()) post.mutate();
									}
									if (e.key === 'Escape') setWriting(false);
								}}
							/>
							{post.error && (
								<p className="text-xs text-danger">{post.error.message}</p>
							)}
							<div className="flex justify-end gap-1">
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => setWriting(false)}
								>
									Cancel
								</Button>
								<Button
									type="submit"
									size="sm"
									loading={post.isPending}
									disabled={!text.trim()}
								>
									Comment
								</Button>
							</div>
						</form>
					) : (
						<Button size="sm" variant="ghost" onClick={() => setWriting(true)}>
							Comment
						</Button>
					)}
				</div>
			</BubbleMenu>
			{open && <Thread comment={open} onClose={() => onActive(null)} />}
		</>
	);
}

function Thread({
	comment,
	onClose,
}: {
	comment: Comment;
	onClose: () => void;
}) {
	const anchor = (comment.anchor ?? {}) as Anchor;
	const status = MESSAGE_STATUS[comment.status as MessageStatus];
	return (
		<aside
			aria-label="Comment thread"
			className="sticky bottom-3 z-10 mx-5 mt-3 rounded-xl border border-line bg-surface p-3 text-sm shadow-card sm:mx-8"
		>
			<div className="flex items-start justify-between gap-2">
				<p className="line-clamp-2 border-l-2 border-warn pl-2 text-muted italic">
					“{anchor.quote}”
				</p>
				<button
					type="button"
					aria-label="Close"
					onClick={onClose}
					className="text-muted hover:text-ink"
				>
					<XIcon size={14} />
				</button>
			</div>
			<div className="mt-2 flex gap-2">
				<Avatar
					userId={comment.author.id}
					name={comment.author.name}
					size="sm"
				/>
				<div className="min-w-0">
					<p>
						<span className="font-medium">
							{comment.author.name.split(' ')[0]}
						</span>{' '}
						{comment.content}
					</p>
					{status && (
						<Badge tone={status.tone} className="mt-1">
							{status.label}
						</Badge>
					)}
				</div>
			</div>
			{comment.response && (
				<p className="mt-2 rounded-lg bg-accent-soft/60 px-2.5 py-1.5">
					<span className="font-medium text-accent">Agent</span>{' '}
					{comment.response}
				</p>
			)}
		</aside>
	);
}
