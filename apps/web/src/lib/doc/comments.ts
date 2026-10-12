import { SECTION_HEADING_LEVEL, SECTION_ID_ATTR } from '@huddle/shared';
import type { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
	absolutePositionToRelativePosition,
	relativePositionToAbsolutePosition,
	ySyncPluginKey,
} from '@tiptap/y-tiptap';
import * as Y from 'yjs';

// Comments are anchored with Yjs relative positions, so a highlight stays on
// the same words while people and the agent edit around them.

interface YSyncState {
	doc: Y.Doc;
	type: Y.XmlFragment;
	binding: { mapping: Map<unknown, unknown> } | null;
}
const ySync = (editor: Editor) =>
	ySyncPluginKey.getState(editor.state) as YSyncState | undefined;

/** A document position as a portable string (JSON of a Yjs relative position). */
export function toRelative(editor: Editor, pos: number): string | null {
	const y = ySync(editor);
	if (!y?.binding) return null;
	const rel = absolutePositionToRelativePosition(
		pos,
		y.type,
		y.binding.mapping as never,
	);
	return JSON.stringify(Y.relativePositionToJSON(rel));
}

/** Back to a position in the current document, or null if the text is gone. */
export function toAbsolute(
	editor: Editor,
	encoded: string | undefined,
): number | null {
	const y = ySync(editor);
	if (!y?.binding || !encoded) return null;
	try {
		const rel = Y.createRelativePositionFromJSON(JSON.parse(encoded));
		return relativePositionToAbsolutePosition(
			y.doc,
			y.type,
			rel,
			y.binding.mapping as never,
		);
	} catch {
		return null;
	}
}

/** The section (by its heading's id) that a position falls in. */
export function sectionAt(doc: PMNode, pos: number): string | null {
	let section: string | null = null;
	doc.forEach((block, offset) => {
		if (offset > pos) return;
		if (
			block.type.name === 'heading' &&
			block.attrs.level === SECTION_HEADING_LEVEL &&
			block.attrs[SECTION_ID_ATTR]
		) {
			section = block.attrs[SECTION_ID_ATTR];
		}
	});
	return section;
}

export interface CommentRange {
	id: string;
	from: number;
	to: number;
}

const key = new PluginKey<{ ranges: CommentRange[]; active: string | null }>(
	'comments',
);

/** Ask the editor to show these comment highlights (positions already resolved). */
export function setCommentRanges(
	editor: Editor,
	ranges: CommentRange[],
	active: string | null,
) {
	editor.view.dispatch(editor.state.tr.setMeta(key, { ranges, active }));
}

/**
 * Highlights commented text. A click on a highlight calls `onOpen` with the
 * comment's id.
 */
export const CommentHighlights = Extension.create<{
	onOpen: (id: string) => void;
}>({
	name: 'commentHighlights',
	addOptions() {
		return { onOpen: () => undefined };
	},
	addProseMirrorPlugins() {
		const onOpen = (id: string) => this.options.onOpen(id);
		return [
			new Plugin({
				key,
				state: {
					init: () => ({
						ranges: [] as CommentRange[],
						active: null as string | null,
					}),
					apply: (tr, old) => {
						const meta = tr.getMeta(key) as
							| { ranges: CommentRange[]; active: string | null }
							| undefined;
						if (meta) return meta;
						if (!tr.docChanged) return old;
						return {
							active: old.active,
							ranges: old.ranges.map((r) => ({
								...r,
								from: tr.mapping.map(r.from, 1),
								to: tr.mapping.map(r.to, -1),
							})),
						};
					},
				},
				props: {
					decorations(state) {
						const s = key.getState(state);
						if (!s?.ranges.length) return null;
						return DecorationSet.create(
							state.doc,
							s.ranges
								.filter((r) => r.to > r.from && r.to <= state.doc.content.size)
								.map((r) =>
									Decoration.inline(r.from, r.to, {
										class:
											r.id === s.active
												? 'huddle-comment huddle-comment-active'
												: 'huddle-comment',
										'data-comment': r.id,
									}),
								),
						);
					},
					handleClick(_view, _pos, event) {
						const el = (event.target as HTMLElement).closest('[data-comment]');
						const id = el?.getAttribute('data-comment');
						if (!id) return false;
						onOpen(id);
						return false; // still place the cursor
					},
				},
			}),
		];
	},
});
