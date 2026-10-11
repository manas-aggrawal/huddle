import {
	DOC_FRAGMENT,
	DocNode,
	HUMAN_MARK,
	HumanMarkAttrs,
	HumanRange,
	SECTION_ID_ATTR,
} from '@huddle/shared';
import * as Y from 'yjs';

// Reading and writing the section layout described in @huddle/shared/doc.ts,
// directly on Yjs types (the server has no ProseMirror).

type Block = Y.XmlElement | Y.XmlText;

interface DeltaInsert {
	insert: string | object;
	attributes?: Record<string, unknown>;
}

export function fragmentOf(doc: Y.Doc): Y.XmlFragment {
	return doc.getXmlFragment(DOC_FRAGMENT);
}

export function sectionIdOf(block: Block): string | null {
	if (!(block instanceof Y.XmlElement) || block.nodeName !== DocNode.HEADING) {
		return null;
	}
	const id = block.getAttribute(SECTION_ID_ATTR);
	return typeof id === 'string' && id.length > 0 ? id : null;
}

export interface SectionBounds {
	sectionId: string;
	/** Index of the section's heading in the fragment. */
	heading: number;
	/** Index just past the section's last block. */
	end: number;
}

/** Every section in document order. Blocks before the first section heading belong to none. */
export function listSections(doc: Y.Doc): SectionBounds[] {
	const blocks = fragmentOf(doc).toArray() as Block[];
	const sections: SectionBounds[] = [];
	blocks.forEach((block, i) => {
		const id = sectionIdOf(block);
		if (!id) return;
		const previous = sections.at(-1);
		if (previous) previous.end = i;
		sections.push({ sectionId: id, heading: i, end: blocks.length });
	});
	return sections;
}

export function findSection(
	doc: Y.Doc,
	sectionId: string,
): SectionBounds | null {
	return listSections(doc).find((s) => s.sectionId === sectionId) ?? null;
}

/** The text runs of a block, with their marks. Inline non-text nodes are skipped. */
function runsOf(
	block: Block,
): { text: string; attributes?: Record<string, unknown> }[] {
	const texts =
		block instanceof Y.XmlText
			? [block]
			: (block.toArray().filter((c) => c instanceof Y.XmlText) as Y.XmlText[]);
	return texts.flatMap((t) =>
		(t.toDelta() as DeltaInsert[])
			.filter(
				(d): d is DeltaInsert & { insert: string } =>
					typeof d.insert === 'string',
			)
			.map((d) => ({ text: d.insert, attributes: d.attributes })),
	);
}

function bodyBlocks(doc: Y.Doc, bounds: SectionBounds): Block[] {
	return (fragmentOf(doc).toArray() as Block[]).slice(
		bounds.heading + 1,
		bounds.end,
	);
}

export function headingText(doc: Y.Doc, bounds: SectionBounds): string {
	const heading = fragmentOf(doc).get(bounds.heading) as Block;
	return runsOf(heading)
		.map((r) => r.text)
		.join('');
}

/** A section's body as plain text, paragraphs separated by a blank line. */
export function sectionText(doc: Y.Doc, bounds: SectionBounds): string {
	return bodyBlocks(doc, bounds)
		.map((b) =>
			runsOf(b)
				.map((r) => r.text)
				.join(''),
		)
		.join('\n\n');
}

/** Runs of text in the section that carry the human mark, with offsets into sectionText(). */
export function humanRanges(doc: Y.Doc, bounds: SectionBounds): HumanRange[] {
	const ranges: HumanRange[] = [];
	let offset = 0;
	bodyBlocks(doc, bounds).forEach((block, i) => {
		if (i > 0) offset += 2; // the "\n\n" between paragraphs
		for (const run of runsOf(block)) {
			const mark = run.attributes?.[HUMAN_MARK] as HumanMarkAttrs | undefined;
			if (mark?.userId) {
				const last = ranges.at(-1);
				// Merge neighbouring runs by the same person (Yjs may split them).
				if (last && last.userId === mark.userId && last.to === offset) {
					last.text += run.text;
					last.to += run.text.length;
				} else {
					ranges.push({
						userId: mark.userId,
						text: run.text,
						from: offset,
						to: offset + run.text.length,
					});
				}
			}
			offset += run.text.length;
		}
	});
	return ranges;
}

/**
 * A fingerprint of each section's content (heading, text and marks), used to
 * tell which sections an edit touched by comparing before and after.
 */
export function sectionFingerprints(doc: Y.Doc): Map<string, string> {
	const blocks = fragmentOf(doc).toArray() as Block[];
	const prints = new Map<string, string>();
	for (const s of listSections(doc)) {
		prints.set(
			s.sectionId,
			JSON.stringify(blocks.slice(s.heading, s.end).map((b) => runsOf(b))),
		);
	}
	return prints;
}
