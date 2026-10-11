import {
	PRESENCE_RATE_LIMIT_PER_SECOND,
	PresenceMember,
	SessionRole,
} from '@huddle/shared';
import { Injectable } from '@nestjs/common';

interface Entry extends PresenceMember {
	/** One person can have several tabs open; they count once and leave when the last closes. */
	socketIds: Set<string>;
}

/**
 * Who's online in each session, held in memory only (it changes by the second
 * and means nothing after a restart). Single API process for the MVP; several
 * processes would need a shared store such as Redis.
 */
@Injectable()
export class PresenceService {
	private readonly sessions = new Map<string, Map<string, Entry>>();
	/** Timestamps of recent presence updates, per socket, for the rate limit. */
	private readonly recentUpdates = new Map<string, number[]>();

	/** Adds a socket. Returns true if the person wasn't online before (their first tab). */
	join(
		sessionId: string,
		socketId: string,
		member: { userId: string; name: string; role: SessionRole },
	): boolean {
		let people = this.sessions.get(sessionId);
		if (!people) {
			people = new Map();
			this.sessions.set(sessionId, people);
		}
		const existing = people.get(member.userId);
		if (existing) {
			existing.socketIds.add(socketId);
			existing.role = member.role;
			return false;
		}
		people.set(member.userId, {
			...member,
			viewing: null,
			typing: false,
			socketIds: new Set([socketId]),
		});
		return true;
	}

	/** Removes a socket. Returns true if that was the person's last one, so they went offline. */
	leave(sessionId: string, socketId: string, userId: string): boolean {
		const people = this.sessions.get(sessionId);
		const entry = people?.get(userId);
		if (!people || !entry) return false;
		entry.socketIds.delete(socketId);
		if (entry.socketIds.size > 0) return false;
		people.delete(userId);
		if (people.size === 0) this.sessions.delete(sessionId);
		return true;
	}

	/** Takes the person offline in that session, whatever tabs they have. Returns their socket ids. */
	removeUser(sessionId: string, userId: string): string[] {
		const people = this.sessions.get(sessionId);
		const entry = people?.get(userId);
		if (!people || !entry) return [];
		people.delete(userId);
		if (people.size === 0) this.sessions.delete(sessionId);
		return [...entry.socketIds];
	}

	/** Applies a viewing/typing change. Returns the updated member, or null if they aren't online. */
	update(
		sessionId: string,
		userId: string,
		change: { viewing?: string | null; typing?: boolean },
	): PresenceMember | null {
		const entry = this.sessions.get(sessionId)?.get(userId);
		if (!entry) return null;
		if (change.viewing !== undefined) entry.viewing = change.viewing;
		if (change.typing !== undefined) entry.typing = change.typing;
		return toMember(entry);
	}

	setRole(sessionId: string, userId: string, role: SessionRole): boolean {
		const entry = this.sessions.get(sessionId)?.get(userId);
		if (!entry || entry.role === role) return false;
		entry.role = role;
		return true;
	}

	list(sessionId: string): PresenceMember[] {
		const people = this.sessions.get(sessionId);
		if (!people) return [];
		return [...people.values()]
			.map(toMember)
			.sort(
				(a, b) =>
					a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId),
			);
	}

	/** Sliding one-second window per socket. False means drop the update. */
	allowUpdate(socketId: string, now = Date.now()): boolean {
		const recent = (this.recentUpdates.get(socketId) ?? []).filter(
			(t) => now - t < 1000,
		);
		if (recent.length >= PRESENCE_RATE_LIMIT_PER_SECOND) {
			this.recentUpdates.set(socketId, recent);
			return false;
		}
		recent.push(now);
		this.recentUpdates.set(socketId, recent);
		return true;
	}

	forgetSocket(socketId: string) {
		this.recentUpdates.delete(socketId);
	}
}

function toMember({ socketIds: _, ...member }: Entry): PresenceMember {
	return { ...member };
}
