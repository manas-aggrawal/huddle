// How the shared document is laid out, so the web editor (Tiptap), the API and
// the agent all read and write it the same way.
//
// The Yjs doc for a session is named after the session id and holds one
// ProseMirror fragment. It's a flat list of blocks; a heading with a sectionId
// starts a section, which runs until the next such heading:
//
//   heading { level: 2, sectionId: "s-pricing" }   "Pricing"
//   paragraph                                       "Notion charges …"
//   paragraph                                       "Obsidian is free …"
//   heading { level: 2, sectionId: "s-verdict" }   "Verdict"
//   …
//
// Text a person typed carries the `human` mark with their user id. The agent's
// text carries no mark. In HTML the attribute renders as data-section-id.

/** Name of the Y.XmlFragment that Tiptap's Collaboration extension binds to. */
export const DOC_FRAGMENT = 'default';

/** WebSocket path of the document server, on the API's port. */
export const COLLAB_PATH = '/collab';

export const DocNode = {
	HEADING: 'heading',
	PARAGRAPH: 'paragraph',
} as const;

/** Heading attribute that marks the start of a section. */
export const SECTION_ID_ATTR = 'sectionId';

/** HTML attribute the editor renders the section id as. */
export const SECTION_ID_HTML_ATTR = 'data-section-id';

/** Level the agent uses for section headings. */
export const SECTION_HEADING_LEVEL = 2;

/** Mark on text people typed: { userId }. Missing means the agent wrote it. */
export const HUMAN_MARK = 'human';
export interface HumanMarkAttrs {
	userId: string;
}

/** A run of human-written text inside a section. Offsets are into getSectionText's result. */
export interface HumanRange {
	userId: string;
	text: string;
	from: number;
	to: number;
}

/** At most one DOC_EDITED timeline event per person per section in this window. */
export const DOC_EDITED_THROTTLE_MS = 60_000;
