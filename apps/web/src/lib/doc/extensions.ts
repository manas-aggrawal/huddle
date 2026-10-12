import {
	HUMAN_MARK,
	SECTION_HEADING_LEVEL,
	SECTION_ID_ATTR,
	SECTION_ID_HTML_ATTR,
} from '@huddle/shared';
import { Mark } from '@tiptap/core';
import Heading from '@tiptap/extension-heading';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';

// The document conventions from @huddle/shared/doc.ts, as Tiptap extensions.

/** Changes that arrived from Yjs (other people, the agent, undo) rather than this user's typing. */
function fromYjs(tr: Transaction): boolean {
	return Boolean(tr.getMeta(ySyncPluginKey)?.isChangeOrigin);
}

const newSectionId = () => `s-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Headings with a section id. Level-2 headings start a section, so one this
 * user creates (or pastes a copy of) gets a fresh, unique id.
 */
export const SectionHeading = Heading.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			[SECTION_ID_ATTR]: {
				default: null,
				parseHTML: (el) => el.getAttribute(SECTION_ID_HTML_ATTR),
				renderHTML: (attrs) =>
					attrs[SECTION_ID_ATTR]
						? { [SECTION_ID_HTML_ATTR]: attrs[SECTION_ID_ATTR] }
						: {},
			},
		};
	},
	addProseMirrorPlugins() {
		const key = new PluginKey('sectionIds');
		return [
			new Plugin({
				key,
				appendTransaction: (trs, _old, state) => {
					if (
						!trs.some((tr) => tr.docChanged && !fromYjs(tr) && !tr.getMeta(key))
					)
						return null;
					const tr = state.tr;
					const seen = new Set<string>();
					state.doc.descendants((node, pos) => {
						if (node.type.name !== this.name) return;
						const id = node.attrs[SECTION_ID_ATTR] as string | null;
						if (
							node.attrs.level === SECTION_HEADING_LEVEL &&
							(!id || seen.has(id))
						) {
							tr.setNodeAttribute(pos, SECTION_ID_ATTR, newSectionId());
						} else if (id) {
							seen.add(id);
						}
					});
					return tr.steps.length ? tr.setMeta(key, true) : null;
				},
			}),
		];
	},
});

/**
 * Marks text people type with their user id. The agent's text has no mark, which is
 * how it knows not to rewrite human text without asking.
 */
export const HumanMark = Mark.create<{
	userId: string | null;
	/** Name for the "Written by …" tooltip. Read at render time. */
	nameOf: (userId: string) => string | undefined;
}>({
	name: HUMAN_MARK,
	inclusive: false,
	addOptions() {
		return { userId: null, nameOf: () => undefined };
	},
	addAttributes() {
		return {
			userId: {
				default: null,
				parseHTML: (el) => el.getAttribute('data-human'),
				renderHTML: (attrs) => {
					const name = attrs.userId
						? this.options.nameOf(attrs.userId)
						: undefined;
					return {
						'data-human': attrs.userId,
						title: `Written by ${name ?? 'a teammate'}. The agent asks before changing it.`,
					};
				},
			},
		};
	},
	parseHTML() {
		return [{ tag: 'span[data-human]' }];
	},
	renderHTML({ HTMLAttributes }) {
		return ['span', HTMLAttributes, 0];
	},
	addProseMirrorPlugins() {
		const userId = this.options.userId;
		const key = new PluginKey('humanMark');
		return [
			new Plugin({
				key,
				appendTransaction: (trs, _old, state) => {
					if (!userId) return null;
					// Collect what this user inserted, in final document positions.
					let ranges: [number, number][] = [];
					for (const tr of trs) {
						ranges = ranges.map(([f, t]) => [
							tr.mapping.map(f, 1),
							tr.mapping.map(t, -1),
						]);
						if (!tr.docChanged || fromYjs(tr) || tr.getMeta(key)) continue;
						tr.mapping.maps.forEach((map, i) => {
							const rest = tr.mapping.slice(i + 1);
							map.forEach((_os, _oe, start, end) => {
								if (end > start)
									ranges.push([rest.map(start, 1), rest.map(end, -1)]);
							});
						});
					}
					const type = state.schema.marks[HUMAN_MARK];
					const mark = type.create({ userId });
					const out = state.tr;
					for (const [from, to] of ranges) {
						if (from >= to) continue;
						let needed = false;
						state.doc.nodesBetween(from, to, (node) => {
							if (node.isText && !mark.isInSet(node.marks)) needed = true;
						});
						if (needed) out.addMark(from, to, mark);
					}
					return out.steps.length
						? out.setMeta(key, true).setMeta('addToHistory', false)
						: null;
				},
			}),
		];
	},
});
