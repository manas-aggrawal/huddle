import { HocuspocusProvider } from '@hocuspocus/provider';
import { COLLAB_PATH } from '@huddle/shared';
import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { getFreshAccessToken } from '../api';
import { API_URL } from '../config';

export interface DocConnection {
	doc: Y.Doc;
	provider: HocuspocusProvider;
}

/**
 * Connects to a session's shared document. Logs in with a fresh token on every
 * (re)connect; the server decides read-only vs read-write.
 */
export function useDocProvider(sessionId: string): {
	connection: DocConnection | null;
	synced: boolean;
	readOnly: boolean;
	refused: string | null;
} {
	const [connection, setConnection] = useState<DocConnection | null>(null);
	const [synced, setSynced] = useState(false);
	const [readOnly, setReadOnly] = useState(false);
	const [refused, setRefused] = useState<string | null>(null);

	useEffect(() => {
		const doc = new Y.Doc();
		const provider = new HocuspocusProvider({
			url: `${API_URL.replace(/^http/, 'ws')}${COLLAB_PATH}`,
			name: sessionId,
			document: doc,
			token: getFreshAccessToken,
			onSynced: ({ state }) => setSynced(state),
			onAuthenticated: ({ scope }) => {
				setRefused(null);
				setReadOnly(scope === 'readonly');
			},
			onAuthenticationFailed: ({ reason }) => setRefused(reason),
		});
		setConnection({ doc, provider });
		setSynced(false);
		return () => {
			provider.destroy();
			doc.destroy();
			setConnection(null);
		};
	}, [sessionId]);

	return { connection, synced, readOnly, refused };
}
