import { ActorType, DOC_EDITED_THROTTLE_MS, EventType } from '@huddle/shared';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { TimelineService } from '@src/timeline/timeline.service';
import * as Y from 'yjs';
import { findSection, headingText, sectionFingerprints } from './doc-structure';

/**
 * Turns people's typing into "Leo edited Pricing" timeline events, at most one
 * per person per section per minute. Every change (human or agent) updates the
 * remembered state of each section; only human changes produce events.
 */
/**
 * How long after the first edit in a window the event is written, so it
 * carries the section's settled title (someone creating a section types the
 * heading after the edit that created it). Overridable for tests.
 */
const SETTLE_MS = Number(process.env.DOC_EDITED_SETTLE_MS ?? 3000);

@Injectable()
export class DocActivityService implements OnModuleDestroy {
	private readonly logger = new Logger(DocActivityService.name);
	/** Last known fingerprint of every section, per session. */
	private readonly fingerprints = new Map<string, Map<string, string>>();
	/** `${sessionId}:${userId}:${sectionId}` → when we last recorded an event. */
	private readonly lastRecorded = new Map<string, number>();
	/** Events waiting out SETTLE_MS, so shutdown can write them right away. */
	private readonly scheduled = new Map<NodeJS.Timeout, () => Promise<void>>();

	constructor(private readonly timeline: TimelineService) {}

	/** Call when a document is loaded, so the first edit is compared with real content. */
	remember(sessionId: string, doc: Y.Doc) {
		this.fingerprints.set(sessionId, sectionFingerprints(doc));
	}

	/** Call when a document is unloaded (nobody connected), so memory doesn't grow. */
	forget(sessionId: string) {
		this.fingerprints.delete(sessionId);
		for (const key of this.lastRecorded.keys()) {
			if (key.startsWith(`${sessionId}:`)) this.lastRecorded.delete(key);
		}
	}

	/** Call after every change. `userId` is set when a person made it, null for the agent. */
	changed(sessionId: string, doc: Y.Doc, userId: string | null) {
		const before =
			this.fingerprints.get(sessionId) ?? new Map<string, string>();
		const after = sectionFingerprints(doc);
		this.fingerprints.set(sessionId, after);
		if (!userId) return;

		const now = Date.now();
		for (const [sectionId, print] of after) {
			if (before.get(sectionId) === print) continue;
			const key = `${sessionId}:${userId}:${sectionId}`;
			const last = this.lastRecorded.get(key);
			if (last !== undefined && now - last < DOC_EDITED_THROTTLE_MS) continue;
			this.lastRecorded.set(key, now);

			const write = async () => {
				const bounds = findSection(doc, sectionId);
				const sectionTitle = bounds ? headingText(doc, bounds) : '';
				await this.record(sessionId, userId, sectionId, sectionTitle).catch(
					(error) =>
						// The edit itself is already applied; a missing event isn't worth failing it.
						this.logger.error(
							`Couldn't record DOC_EDITED for ${sessionId}`,
							error,
						),
				);
			};
			const timer = setTimeout(() => {
				this.scheduled.delete(timer);
				void write();
			}, SETTLE_MS);
			this.scheduled.set(timer, write);
		}
	}

	/** Writes any events still waiting, before the database connection closes. */
	async onModuleDestroy() {
		const pending = [...this.scheduled.entries()];
		this.scheduled.clear();
		for (const [timer] of pending) clearTimeout(timer);
		await Promise.all(pending.map(([, write]) => write()));
	}

	private record(
		sessionId: string,
		userId: string,
		sectionId: string,
		sectionTitle: string,
	) {
		return this.timeline.transaction(async (tx) =>
			this.timeline.append(tx, sessionId, {
				type: EventType.DOC_EDITED,
				actorType: ActorType.USER,
				actorId: userId,
				payload: {
					actor: await this.timeline.actorSnapshot(tx, userId),
					sectionId,
					sectionTitle,
				},
			}),
		);
	}
}
