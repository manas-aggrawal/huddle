// Allowed values live here, not in the database: role columns are plain strings,
// so adding or removing a value is a code change instead of a migration.
// The API validates every write against these with zod.

/** App-wide role (User.role). ADMIN operates Huddle itself; STANDARD is everyone else. */
export const AppRole = {
	ADMIN: 'ADMIN',
	STANDARD: 'STANDARD',
} as const;
export type AppRole = (typeof AppRole)[keyof typeof AppRole];

/** Role inside one session (SessionMember.role). */
export const SessionRole = {
	OWNER: 'OWNER',
	EDITOR: 'EDITOR',
	VIEWER: 'VIEWER',
} as const;
export type SessionRole = (typeof SessionRole)[keyof typeof SessionRole];

export type SessionAction =
	| 'watch'
	| 'ask'
	| 'comment'
	| 'suggest'
	| 'interrupt'
	| 'editDoc'
	| 'editPlan'
	| 'pinDecision'
	| 'approve'
	| 'resolveConflict'
	| 'invite'
	| 'changeRoles'
	| 'handOff'
	| 'changeSettings'
	| 'pauseOrEnd';

const VIEWER_ACTIONS: SessionAction[] = ['watch', 'ask', 'comment'];
const EDITOR_ACTIONS: SessionAction[] = [
	...VIEWER_ACTIONS,
	'suggest',
	'interrupt',
	'editDoc',
	'editPlan',
	'pinDecision',
];
const OWNER_ACTIONS: SessionAction[] = [
	...EDITOR_ACTIONS,
	'approve',
	'resolveConflict',
	'invite',
	'changeRoles',
	'handOff',
	'changeSettings',
	'pauseOrEnd',
];

const PERMISSIONS: Record<SessionRole, ReadonlySet<SessionAction>> = {
	OWNER: new Set(OWNER_ACTIONS),
	EDITOR: new Set(EDITOR_ACTIONS),
	VIEWER: new Set(VIEWER_ACTIONS),
};

export interface MembershipLike {
	role: SessionRole;
	/** Only meaningful for Editors: the Owner lets them approve gates. */
	canApprove?: boolean;
}

/** Single source of truth for "can this member do X?", used by API guards and UI controls. */
export function can(member: MembershipLike, action: SessionAction): boolean {
	if (action === 'approve' && member.role === SessionRole.EDITOR) {
		return member.canApprove === true;
	}
	return PERMISSIONS[member.role].has(action);
}
