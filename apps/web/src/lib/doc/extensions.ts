import {
	HUMAN_MARK,
	SECTION_HEADING_LEVEL,
	SECTION_ID_ATTR,
	SECTION_ID_HTML_ATTR,
	SOURCES_SECTION_ID,
} from '@huddle/shared';
import { Extension, Mark } from '@tiptap/core';
import Heading from '@tiptap/extension-heading';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
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

const CITATION = /\[(\d{1,3})\]/g;

/** Highlights each [n] citation, outside the Sources list itself. */
function citationDecorations(doc: PMNode): DecorationSet {
	const decorations: Decoration[] = [];
	let inSources = false;
	doc.forEach((block, offset) => {
		if (
			block.type.name === 'heading' &&
			block.attrs.level === SECTION_HEADING_LEVEL
		) {
			inSources = block.attrs[SECTION_ID_ATTR] === SOURCES_SECTION_ID;
			return;
		}
		if (inSources) return;
		block.descendants((node, pos) => {
			if (!node.isText || !node.text) return;
			for (const m of node.text.matchAll(CITATION)) {
				const from = offset + 1 + pos + (m.index ?? 0);
				decorations.push(
					Decoration.inline(from, from + m[0].length, {
						class: 'huddle-cite',
						'data-cite': m[1],
						title: `Source ${m[1]}: click to see it in Sources`,
					}),
				);
			}
		});
	});
	return DecorationSet.create(doc, decorations);
}

/**
 * Makes the agent's [n] citations clickable: a click scrolls to that line of
 * the Sources list at the end of the doc and highlights it for a moment.
 * (The highlight is a decoration: ProseMirror undoes direct DOM changes.)
 */
export const CitationLinks = Extension.create({
	name: 'citationLinks',
	addProseMirrorPlugins() {
		type CiteState = { cites: DecorationSet; target: number | null };
		const key = new PluginKey<CiteState>('citationLinks');
		return [
			new Plugin<CiteState>({
				key,
				state: {
					init: (_, state): CiteState => ({
						cites: citationDecorations(state.doc),
						target: null,
					}),
					apply: (tr, old) => {
						const meta = tr.getMeta(key) as
							| { target: number | null }
							| undefined;
						return {
							cites: tr.docChanged ? citationDecorations(tr.doc) : old.cites,
							target:
								meta !== undefined
									? meta.target
									: old.target === null
										? null
										: tr.mapping.map(old.target),
						};
					},
				},
				props: {
					decorations(state) {
						const s = key.getState(state);
						if (!s) return null;
						if (s.target === null) return s.cites;
						const node = state.doc.nodeAt(s.target);
						if (!node) return s.cites;
						return s.cites.add(state.doc, [
							Decoration.node(s.target, s.target + node.nodeSize, {
								class: 'huddle-cite-target',
							}),
						]);
					},
					handleClick(view, _pos, event) {
						const cite = (event.target as HTMLElement).closest('[data-cite]');
						if (!cite) return false;
						const n = cite.getAttribute('data-cite');
						// Find the Sources line "[n] …" in the document itself.
						let inSources = false;
						let target: number | null = null;
						let heading: number | null = null;
						view.state.doc.forEach((block, offset) => {
							if (
								block.type.name === 'heading' &&
								block.attrs.level === SECTION_HEADING_LEVEL
							) {
								inSources = block.attrs[SECTION_ID_ATTR] === SOURCES_SECTION_ID;
								if (inSources) heading = offset;
								return;
							}
							if (
								inSources &&
								target === null &&
								block.textContent.startsWith(`[${n}]`)
							) {
								target = offset;
							}
						});
						const goal = target ?? heading;
						if (goal === null) return false;
						const dom = view.nodeDOM(goal);
						if (dom instanceof HTMLElement)
							dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
						view.dispatch(view.state.tr.setMeta(key, { target: goal }));
						setTimeout(() => {
							if (!view.isDestroyed)
								view.dispatch(view.state.tr.setMeta(key, { target: null }));
						}, 1600);
						return true;
					},
				},
			}),
		];
	},
});
