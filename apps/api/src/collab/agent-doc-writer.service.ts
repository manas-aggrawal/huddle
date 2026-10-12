import {
	DocNode,
	HUMAN_MARK,
	HumanRange,
	SECTION_HEADING_LEVEL,
	SECTION_ID_ATTR,
	SOURCES_SECTION_ID,
} from '@huddle/shared';
import {
	ConflictException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import * as Y from 'yjs';
import { CollabServer } from './collab.server';
import {
	findSection,
	fragmentOf,
	headingText,
	humanRanges,
	listSections,
	SectionBounds,
	sectionText,
} from './doc-structure';

/** Text the agent writes carries no human mark, even when typed right after a person's text. */
const AGENT_FORMAT = { [HUMAN_MARK]: null };

/** The agent tried to change text a person wrote. It must ask (REWRITE_HUMAN_TEXT) first. */
export class HumanTextProtectedError extends Error {
	constructor(readonly ranges: HumanRange[]) {
		super(
			`That text was written by a person (${ranges.map((r) => `"${r.text.slice(0, 40)}"`).join(', ')}); ask before changing it`,
		);
		this.name = 'HumanTextProtectedError';
	}
}

/** The text to replace isn't in the section (someone changed it), or spans paragraphs. */
export class TextNotFoundError extends Error {
	constructor(readonly before: string) {
		super(
			`Couldn't find "${before.slice(0, 60)}" in a single paragraph of the section`,
		);
		this.name = 'TextNotFoundError';
	}
}

/**
 * The agent's pen: edits a session's document as one more peer, so everyone
 * connected sees its text appear live. Each call opens a server-side
 * connection, applies one change, and lets go; the document stays loaded and
 * is saved on the normal debounce.
 */
@Injectable()
export class AgentDocWriter {
	constructor(private readonly collab: CollabServer) {}

	/**
	 * Adds a section: a heading and an empty paragraph. It goes right after the
	 * `after` section when that exists, else before `before`, else at the end.
	 */
	async insertSection(
		sessionId: string,
		sectionId: string,
		title: string,
		place: { after?: string | null; before?: string | null } = {},
	) {
		await this.write(sessionId, (doc) => {
			if (findSection(doc, sectionId)) {
				throw new ConflictException(`Section ${sectionId} already exists`);
			}
			const heading = new Y.XmlElement(DocNode.HEADING);
			heading.setAttribute('level', SECTION_HEADING_LEVEL as unknown as string);
			heading.setAttribute(SECTION_ID_ATTR, sectionId);
			heading.insert(0, [new Y.XmlText(title)]);
			const body = new Y.XmlElement(DocNode.PARAGRAPH);
			body.insert(0, [new Y.XmlText()]);
			const fragment = fragmentOf(doc);
			const after = place.after ? findSection(doc, place.after) : null;
			const before = place.before ? findSection(doc, place.before) : null;
			const at = after?.end ?? before?.heading ?? fragment.length;
			fragment.insert(at, [heading, body]);
		});
	}

	/**
	 * Keeps the numbered Sources list at the end of the doc. Rewritten whole
	 * each time, unless someone typed in it, in which case only new lines are
	 * added.
	 */
	async setSources(sessionId: string, lines: string[]) {
		if (!(await this.hasSection(sessionId, SOURCES_SECTION_ID))) {
			await this.insertSection(sessionId, SOURCES_SECTION_ID, 'Sources');
		}
		await this.write(sessionId, (doc) => {
			const bounds = this.require(doc, SOURCES_SECTION_ID);
			const fragment = fragmentOf(doc);
			if (humanRanges(doc, bounds).length > 0) {
				const have = sectionText(doc, bounds);
				const missing = lines.filter((l) => !have.includes(l));
				fragment.insert(
					bounds.end,
					missing.map((l) => this.newParagraph(l)),
				);
				return;
			}
			fragment.delete(bounds.heading + 1, bounds.end - bounds.heading - 1);
			fragment.insert(
				bounds.heading + 1,
				(lines.length ? lines : ['']).map((l) => this.newParagraph(l)),
			);
		});
	}

	/** Whether the section's heading is still in the document (people can delete it). */
	async hasSection(sessionId: string, sectionId: string): Promise<boolean> {
		return this.read(sessionId, (doc) => findSection(doc, sectionId) !== null);
	}

	/** Every section in document order, with its heading and body text. */
	async listSections(
		sessionId: string,
	): Promise<{ sectionId: string; title: string; text: string }[]> {
		return this.read(sessionId, (doc) =>
			listSections(doc).map((bounds) => ({
				sectionId: bounds.sectionId,
				title: headingText(doc, bounds),
				text: sectionText(doc, bounds),
			})),
		);
	}

	/**
	 * Adds text at the end of a section, as the agent streams it. A blank line
	 * ("\n\n") in the chunk starts a new paragraph.
	 */
	async appendToSection(sessionId: string, sectionId: string, chunk: string) {
		if (chunk.length === 0) return;
		await this.write(sessionId, (doc) => {
			const bounds = this.require(doc, sectionId);
			const fragment = fragmentOf(doc);
			const [first, ...rest] = chunk.split(/\n{2,}/);

			let paragraph = this.lastParagraph(fragment, bounds);
			if (!paragraph) {
				paragraph = this.newParagraph();
				fragment.insert(bounds.end, [paragraph]);
			}
			let insertAt = fragment.toArray().indexOf(paragraph) + 1;
			const text = this.textOf(paragraph);
			if (first) text.insert(text.length, first, AGENT_FORMAT);

			for (const part of rest) {
				const next = this.newParagraph(part);
				fragment.insert(insertAt, [next]);
				insertAt++;
			}
		});
	}

	/**
	 * Replaces the first occurrence of `before` in the section with `after`.
	 * Refuses (HumanTextProtectedError) when that overlaps text a person wrote,
	 * unless `allowHuman` is set, which only an approved REWRITE_HUMAN_TEXT may
	 * do; the new text is the agent's, so it carries no human mark.
	 */
	async replaceText(
		sessionId: string,
		sectionId: string,
		before: string,
		after: string,
		{ allowHuman = false } = {},
	) {
		await this.write(sessionId, (doc) => {
			const bounds = this.require(doc, sectionId);
			const full = sectionText(doc, bounds);
			const from = before ? full.indexOf(before) : -1;
			if (from === -1) throw new TextNotFoundError(before);
			const to = from + before.length;
			const overlapping = humanRanges(doc, bounds).filter(
				(r) => r.from < to && r.to > from,
			);
			if (overlapping.length && !allowHuman) {
				throw new HumanTextProtectedError(overlapping);
			}

			// Find the paragraph (and the text node in it) holding [from, to).
			const fragment = fragmentOf(doc);
			let offset = 0;
			for (let i = bounds.heading + 1; i < bounds.end; i++) {
				if (i > bounds.heading + 1) offset += 2; // "\n\n" between paragraphs
				const block = fragment.get(i);
				const texts =
					block instanceof Y.XmlElement
						? (block
								.toArray()
								.filter((c) => c instanceof Y.XmlText) as Y.XmlText[])
						: block instanceof Y.XmlText
							? [block]
							: [];
				for (const text of texts) {
					const start = offset;
					const end = offset + text.length;
					if (from >= start && to <= end) {
						text.delete(from - start, before.length);
						text.insert(from - start, after, AGENT_FORMAT);
						return;
					}
					offset = end;
				}
			}
			throw new TextNotFoundError(before);
		});
	}

	async getSectionText(sessionId: string, sectionId: string): Promise<string> {
		return this.read(sessionId, (doc) =>
			sectionText(doc, this.require(doc, sectionId)),
		);
	}

	/** The parts of a section people wrote; the agent must ask before rewriting these. */
	async getHumanOwnedRanges(
		sessionId: string,
		sectionId: string,
	): Promise<HumanRange[]> {
		return this.read(sessionId, (doc) =>
			humanRanges(doc, this.require(doc, sectionId)),
		);
	}

	private async write(sessionId: string, change: (doc: Y.Doc) => void) {
		const connection = await this.collab.openDirectConnection(sessionId);
		try {
			// Errors thrown inside are rethrown here, after Yjs ends the transaction.
			let failure: unknown;
			await connection.transact((doc) => {
				try {
					change(doc);
				} catch (error) {
					failure = error;
				}
			});
			if (failure) throw failure;
		} finally {
			await connection.disconnect({ unloadImmediately: false });
		}
	}

	private async read<T>(sessionId: string, fn: (doc: Y.Doc) => T): Promise<T> {
		const connection = await this.collab.openDirectConnection(sessionId);
		try {
			if (!connection.document) throw new Error('Document not loaded');
			return fn(connection.document);
		} finally {
			await connection.disconnect({ unloadImmediately: false });
		}
	}

	private require(doc: Y.Doc, sectionId: string): SectionBounds {
		const bounds = findSection(doc, sectionId);
		if (!bounds) throw new NotFoundException(`Section ${sectionId} not found`);
		return bounds;
	}

	private lastParagraph(
		fragment: Y.XmlFragment,
		bounds: SectionBounds,
	): Y.XmlElement | null {
		for (let i = bounds.end - 1; i > bounds.heading; i--) {
			const block = fragment.get(i);
			if (
				block instanceof Y.XmlElement &&
				block.nodeName === DocNode.PARAGRAPH
			) {
				return block;
			}
		}
		return null;
	}

	private newParagraph(text = ''): Y.XmlElement {
		const paragraph = new Y.XmlElement(DocNode.PARAGRAPH);
		const content = new Y.XmlText();
		if (text) content.insert(0, text, AGENT_FORMAT);
		paragraph.insert(0, [content]);
		return paragraph;
	}

	private textOf(paragraph: Y.XmlElement): Y.XmlText {
		const texts = paragraph.toArray().filter((c) => c instanceof Y.XmlText);
		const last = texts.at(-1) as Y.XmlText | undefined;
		if (last) return last;
		const text = new Y.XmlText();
		paragraph.insert(paragraph.length, [text]);
		return text;
	}
}
