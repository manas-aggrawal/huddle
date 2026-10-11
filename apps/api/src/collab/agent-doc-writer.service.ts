import {
	DocNode,
	HUMAN_MARK,
	HumanRange,
	SECTION_HEADING_LEVEL,
	SECTION_ID_ATTR,
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
	humanRanges,
	SectionBounds,
	sectionText,
} from './doc-structure';

/** Text the agent writes carries no human mark, even when typed right after a person's text. */
const AGENT_FORMAT = { [HUMAN_MARK]: null };

/**
 * The agent's pen: edits a session's document as one more peer, so everyone
 * connected sees its text appear live. Each call opens a server-side
 * connection, applies one change, and lets go; the document stays loaded and
 * is saved on the normal debounce.
 */
@Injectable()
export class AgentDocWriter {
	constructor(private readonly collab: CollabServer) {}

	/** Adds a section at the end of the document: a heading and an empty paragraph. */
	async insertSection(sessionId: string, sectionId: string, title: string) {
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
			fragment.insert(fragment.length, [heading, body]);
		});
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
