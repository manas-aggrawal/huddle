import {
	HocuspocusProvider,
	HocuspocusProviderWebsocket,
} from '@hocuspocus/provider';
import {
	COLLAB_PATH,
	DocNode,
	HUMAN_MARK,
	SECTION_HEADING_LEVEL,
	SECTION_ID_ATTR,
} from '@huddle/shared';
import { NestExpressApplication } from '@nestjs/platform-express';
import {
	findSection,
	fragmentOf,
	sectionText,
} from '@src/collab/doc-structure';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { appUrl } from './create-app';

export interface DocClient {
	doc: Y.Doc;
	provider: HocuspocusProvider;
	/** 'read-write' or 'readonly', as granted by the server. */
	scope: string | undefined;
	close: () => void;
}

/**
 * Connects to a session's shared document like the web editor does, and
 * resolves once it's synced. Rejects if the server refuses the connection.
 */
export function connectDoc(
	app: NestExpressApplication,
	token: string,
	sessionId: string,
	timeoutMs = 3000,
): Promise<DocClient> {
	const doc = new Y.Doc();
	const websocketProvider = new HocuspocusProviderWebsocket({
		url: `${appUrl(app).replace('http', 'ws')}${COLLAB_PATH}`,
		WebSocketPolyfill: WebSocket,
	});
	const provider = new HocuspocusProvider({
		websocketProvider,
		name: sessionId,
		document: doc,
		token,
	});
	// A provider given its own socket must be attached to it explicitly (Hocuspocus v4).
	provider.attach();
	const close = () => {
		provider.destroy();
		websocketProvider.destroy();
	};
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			close();
			reject(new Error(`Document ${sessionId} didn't sync in ${timeoutMs}ms`));
		}, timeoutMs);
		provider.on('synced', () => {
			clearTimeout(timer);
			resolve({
				doc,
				provider,
				get scope() {
					return provider.authorizedScope;
				},
				close,
			});
		});
		provider.on('authenticationFailed', ({ reason }: { reason: string }) => {
			clearTimeout(timer);
			close();
			reject(new Error(`Refused: ${reason}`));
		});
	});
}

/** Resolves once `predicate(doc)` holds, checking after every update. */
export function waitForDoc(
	doc: Y.Doc,
	predicate: (doc: Y.Doc) => boolean,
	timeoutMs = 2000,
): Promise<void> {
	if (predicate(doc)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			doc.off('update', check);
			reject(new Error(`Document never matched within ${timeoutMs}ms`));
		}, timeoutMs);
		function check() {
			if (!predicate(doc)) return;
			clearTimeout(timer);
			doc.off('update', check);
			resolve();
		}
		doc.on('update', check);
	});
}

/** Types a section the way the web editor would: heading, then a paragraph marked as human text. */
export function typeSection(
	doc: Y.Doc,
	sectionId: string,
	title: string,
	text: string,
	userId: string,
) {
	doc.transact(() => {
		const heading = new Y.XmlElement(DocNode.HEADING);
		heading.setAttribute('level', SECTION_HEADING_LEVEL as unknown as string);
		heading.setAttribute(SECTION_ID_ATTR, sectionId);
		heading.insert(0, [new Y.XmlText(title)]);
		const paragraph = new Y.XmlElement(DocNode.PARAGRAPH);
		const content = new Y.XmlText();
		content.insert(0, text, { [HUMAN_MARK]: { userId } });
		paragraph.insert(0, [content]);
		const fragment = fragmentOf(doc);
		fragment.insert(fragment.length, [heading, paragraph]);
	});
}

/** Appends human-marked text to a section's last paragraph. */
export function typeInto(
	doc: Y.Doc,
	sectionId: string,
	text: string,
	userId: string,
) {
	const bounds = findSection(doc, sectionId);
	if (!bounds) throw new Error(`No section ${sectionId}`);
	const paragraph = fragmentOf(doc).get(bounds.end - 1) as Y.XmlElement;
	const content = paragraph.get(0) as Y.XmlText;
	content.insert(content.length, text, { [HUMAN_MARK]: { userId } });
}

/** Plain text of a section in a client's copy, or null if it doesn't have that section. */
export function textOf(doc: Y.Doc, sectionId: string): string | null {
	const bounds = findSection(doc, sectionId);
	return bounds ? sectionText(doc, bounds) : null;
}
