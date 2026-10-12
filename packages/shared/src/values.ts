// Allowed values for every string column in the database (see the `///` comments
// in apps/api/prisma/schema.prisma). There are no Postgres enums: these constants
// are the single source of truth, the API validates writes with `z.enum(X)`, and
// the web app uses them for labels and logic. Roles live in roles.ts.

/** Values of a constant object, as a union type: ValueOf<typeof SessionStatus>. */
type ValueOf<T> = T[keyof T];

export const WorkspaceRole = {
	ADMIN: 'ADMIN',
	MEMBER: 'MEMBER',
} as const;
export type WorkspaceRole = ValueOf<typeof WorkspaceRole>;

export const SessionStatus = {
	PLANNING: 'PLANNING',
	RUNNING: 'RUNNING',
	/** An approval is pending. Always changed in the same transaction as that approval. */
	WAITING: 'WAITING',
	PAUSED: 'PAUSED',
	DONE: 'DONE',
} as const;
export type SessionStatus = ValueOf<typeof SessionStatus>;

export const AgentState = {
	IDLE: 'IDLE',
	THINKING: 'THINKING',
	RESEARCHING: 'RESEARCHING',
	WRITING: 'WRITING',
} as const;
export type AgentState = ValueOf<typeof AgentState>;

export const Effort = {
	LOW: 'LOW',
	MEDIUM: 'MEDIUM',
	HIGH: 'HIGH',
} as const;
export type Effort = ValueOf<typeof Effort>;

export const StepStatus = {
	PENDING: 'PENDING',
	IN_PROGRESS: 'IN_PROGRESS',
	DONE: 'DONE',
	SKIPPED: 'SKIPPED',
	BLOCKED: 'BLOCKED',
} as const;
export type StepStatus = ValueOf<typeof StepStatus>;

export const MessageMode = {
	SUGGEST: 'SUGGEST',
	INTERRUPT: 'INTERRUPT',
	ASK: 'ASK',
	COMMENT: 'COMMENT',
} as const;
export type MessageMode = ValueOf<typeof MessageMode>;

export const MessageStatus = {
	QUEUED: 'QUEUED',
	ACKNOWLEDGED: 'ACKNOWLEDGED',
	APPLIED: 'APPLIED',
	DECLINED: 'DECLINED',
	ANSWERED: 'ANSWERED',
} as const;
export type MessageStatus = ValueOf<typeof MessageStatus>;

export const ApprovalKind = {
	OUTLINE: 'OUTLINE',
	REWRITE_HUMAN_TEXT: 'REWRITE_HUMAN_TEXT',
	MARK_FINAL: 'MARK_FINAL',
	BUDGET: 'BUDGET',
	CUSTOM: 'CUSTOM',
} as const;
export type ApprovalKind = ValueOf<typeof ApprovalKind>;

/**
 * Approvals that stop the whole session (status WAITING). The others gate
 * only their own plan step; the agent keeps working on the rest.
 */
export const BLOCKING_APPROVAL_KINDS: readonly ApprovalKind[] = [
	ApprovalKind.OUTLINE,
	ApprovalKind.MARK_FINAL,
	ApprovalKind.BUDGET,
];

export const ApprovalStatus = {
	PENDING: 'PENDING',
	APPROVED: 'APPROVED',
	REJECTED: 'REJECTED',
	CANCELLED: 'CANCELLED',
} as const;
export type ApprovalStatus = ValueOf<typeof ApprovalStatus>;

export const ActorType = {
	USER: 'USER',
	AGENT: 'AGENT',
	SYSTEM: 'SYSTEM',
} as const;
export type ActorType = ValueOf<typeof ActorType>;

export const EventType = {
	SESSION_CREATED: 'SESSION_CREATED',
	STATUS_CHANGED: 'STATUS_CHANGED',
	MEMBER_JOINED: 'MEMBER_JOINED',
	MEMBER_REMOVED: 'MEMBER_REMOVED',
	ROLE_CHANGED: 'ROLE_CHANGED',
	HUMAN_MESSAGE: 'HUMAN_MESSAGE',
	AGENT_MESSAGE: 'AGENT_MESSAGE',
	AGENT_ACK: 'AGENT_ACK',
	STEP_STARTED: 'STEP_STARTED',
	STEP_COMPLETED: 'STEP_COMPLETED',
	PLAN_UPDATED: 'PLAN_UPDATED',
	TOOL_CALL: 'TOOL_CALL',
	APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
	APPROVAL_RESOLVED: 'APPROVAL_RESOLVED',
	CONFLICT_RAISED: 'CONFLICT_RAISED',
	CONFLICT_RESOLVED: 'CONFLICT_RESOLVED',
	DECISION_PINNED: 'DECISION_PINNED',
	DECISION_UNPINNED: 'DECISION_UNPINNED',
	HANDOFF: 'HANDOFF',
	MODEL_CHANGED: 'MODEL_CHANGED',
	BUDGET_WARNING: 'BUDGET_WARNING',
	DOC_EDITED: 'DOC_EDITED',
} as const;
export type EventType = ValueOf<typeof EventType>;

export const NotificationType = {
	APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
	QUESTION_FOR_YOU: 'QUESTION_FOR_YOU',
	MENTION: 'MENTION',
	CONFLICT_RAISED: 'CONFLICT_RAISED',
	HANDOFF_RECEIVED: 'HANDOFF_RECEIVED',
	/** The workspace's token pool ran out; only workspace admins can raise it. */
	POOL_EXHAUSTED: 'POOL_EXHAUSTED',
} as const;
export type NotificationType = ValueOf<typeof NotificationType>;

/** Length limits for creating a session. The API validates them; the web form checks them first. */
export const SessionLimits = {
	TITLE_MAX: 200,
	GOAL_MAX: 5000,
	CONTEXT_MAX: 10_000,
} as const;

/** Limits for messages to the agent. */
export const MessageLimits = {
	CONTENT_MAX: 4000,
} as const;

/** How a person is mentioned in message content: @[userId]. A fresh regex each call (it's global). */
export const mentionPattern = () => /@\[([0-9a-f-]{36})\]/gi;

/** The distinct user ids mentioned in a message. */
export function mentionedUserIds(content: string): string[] {
	return [...new Set([...content.matchAll(mentionPattern())].map((m) => m[1]))];
}

/** Limits for pinned decisions. */
export const DecisionLimits = {
	CONTENT_MAX: 1000,
} as const;

/** What one approval of a session's cap adds, in tokens. */
export const BUDGET_STEP_TOKENS = 200_000;
