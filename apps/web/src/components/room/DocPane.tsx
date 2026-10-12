import { SECTION_HEADING_LEVEL, SECTION_ID_ATTR } from '@huddle/shared';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState } from 'react';
import { CommentHighlights } from '../../lib/doc/comments';
import {
	CitationLinks,
	HumanMark,
	SectionHeading,
} from '../../lib/doc/extensions';
import {
	type DocConnection,
	useDocProvider,
} from '../../lib/doc/useDocProvider';
import { avatarColor, Badge, cx } from '../ui';
import { DocComments } from './DocComments';
import { Pane } from './Pane';
import './doc.css';

interface Me {
	userId: string;
	name: string;
}

/** The shared document. Viewers get it read-only, without a toolbar. */
export function DocPane({
	sessionId,
	me,
	canEdit,
	onViewing,
	names,
	className,
}: {
	sessionId: string;
	me: Me;
	/** userId → name, for "Written by …" on people's text. */
	names: Map<string, string>;
	/** From the session role; the server enforces it too. */
	canEdit: boolean;
	/** Called with the section id the cursor is in, for presence. */
	onViewing: (sectionId: string | null) => void;
	className?: string;
}) {
	const { connection, synced, readOnly, refused } = useDocProvider(sessionId);
	const editable = canEdit && !readOnly;
	return (
		<Pane
			title="Document"
			aside={
				!editable ? (
					<Badge>View only</Badge>
				) : !synced ? (
					<span className="text-xs text-muted">Connecting…</span>
				) : null
			}
			className={className}
			bodyClassName="overflow-y-auto"
		>
			{refused ? (
				<p className="p-4 text-sm text-danger">
					Couldn't open the document: {refused}
				</p>
			) : connection ? (
				// Remount per connection: the editor binds to one Y.Doc for its lifetime.
				<Editor
					key={sessionId}
					connection={connection}
					me={me}
					editable={editable}
					onViewing={onViewing}
					names={names}
					sessionId={sessionId}
				/>
			) : null}
		</Pane>
	);
}

function Editor({
	connection,
	me,
	editable,
	onViewing,
	names: currentNames,
	sessionId,
}: {
	sessionId: string;
	connection: DocConnection;
	me: Me;
	editable: boolean;
	onViewing: (sectionId: string | null) => void;
	names: Map<string, string>;
}) {
	const lastViewing = useRef<string | null>(null);
	// The editor is built once; the tooltip reads the latest names through this.
	const names = useRef(currentNames);
	names.current = currentNames;
	const [activeComment, setActiveComment] = useState<string | null>(null);
	const editor = useEditor({
		editable,
		extensions: [
			// Collaboration brings its own undo history (per user, through Yjs).
			StarterKit.configure({ undoRedo: false, heading: false }),
			SectionHeading.configure({ levels: [2, 3] }),
			HumanMark.configure({
				userId: me.userId,
				nameOf: (id) => names.current.get(id),
			}),
			CitationLinks,
			CommentHighlights.configure({ onOpen: (id) => setActiveComment(id) }),
			Placeholder.configure({
				placeholder: editable
					? 'Start writing, or wait for the agent’s outline…'
					: 'Nothing written yet.',
			}),
			Collaboration.configure({ document: connection.doc }),
			CollaborationCaret.configure({
				provider: connection.provider,
				user: { name: me.name, color: avatarColor(me.userId) },
			}),
		],
		editorProps: {
			attributes: { class: 'huddle-doc', 'aria-label': 'Shared document' },
		},
		onSelectionUpdate: ({ editor }) => {
			// Which section is the cursor in? The nearest section heading above it.
			let section: string | null = null;
			const pos = editor.state.selection.from;
			editor.state.doc.nodesBetween(0, pos, (node) => {
				if (
					node.type.name === 'heading' &&
					node.attrs.level === SECTION_HEADING_LEVEL &&
					node.attrs[SECTION_ID_ATTR]
				) {
					section = node.attrs[SECTION_ID_ATTR];
				}
				return node.isBlock && node.type.name !== 'heading';
			});
			if (section !== lastViewing.current) {
				lastViewing.current = section;
				onViewing(section);
			}
		},
	});

	useEffect(() => {
		editor?.setEditable(editable);
	}, [editor, editable]);

	if (!editor) return null;
	return (
		<div className="flex min-h-full flex-col">
			{editable && <Toolbar editor={editor} />}
			<EditorContent editor={editor} className="flex-1 px-5 py-4 sm:px-8" />
			<DocComments
				editor={editor}
				sessionId={sessionId}
				active={activeComment}
				onActive={setActiveComment}
			/>
		</div>
	);
}

function Toolbar({
	editor,
}: {
	editor: NonNullable<ReturnType<typeof useEditor>>;
}) {
	const state = useEditorState({
		editor,
		selector: ({ editor: e }) => ({
			h2: e.isActive('heading', { level: 2 }),
			h3: e.isActive('heading', { level: 3 }),
			bold: e.isActive('bold'),
			italic: e.isActive('italic'),
			bullet: e.isActive('bulletList'),
			ordered: e.isActive('orderedList'),
		}),
	});
	const buttons = [
		{
			label: 'Section heading',
			text: 'H2',
			active: state.h2,
			run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
		},
		{
			label: 'Subheading',
			text: 'H3',
			active: state.h3,
			run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
		},
		{
			label: 'Bold',
			text: 'B',
			active: state.bold,
			run: () => editor.chain().focus().toggleBold().run(),
			className: 'font-bold',
		},
		{
			label: 'Italic',
			text: 'I',
			active: state.italic,
			run: () => editor.chain().focus().toggleItalic().run(),
			className: 'italic',
		},
		{
			label: 'Bulleted list',
			text: '•',
			active: state.bullet,
			run: () => editor.chain().focus().toggleBulletList().run(),
		},
		{
			label: 'Numbered list',
			text: '1.',
			active: state.ordered,
			run: () => editor.chain().focus().toggleOrderedList().run(),
		},
	];
	return (
		<div
			role="toolbar"
			aria-label="Formatting"
			className="sticky top-0 z-10 flex gap-0.5 border-b border-line bg-surface px-3 py-1.5"
		>
			{buttons.map((b) => (
				<button
					key={b.label}
					type="button"
					title={b.label}
					aria-label={b.label}
					aria-pressed={b.active}
					onMouseDown={(e) => e.preventDefault()}
					onClick={b.run}
					className={cx(
						'inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-xs',
						b.active
							? 'bg-accent-soft text-accent'
							: 'text-muted hover:bg-surface-2 hover:text-ink',
						b.className,
					)}
				>
					{b.text}
				</button>
			))}
		</div>
	);
}
