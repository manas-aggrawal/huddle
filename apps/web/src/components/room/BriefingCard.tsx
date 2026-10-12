import { useState } from 'react';
import type { SessionDetail } from '../../lib/session';
import { XIcon } from '../ui';

type Handoff = NonNullable<SessionDetail['lastHandoff']>;

const dismissedKey = (id: string) => `huddle.briefing.${id}`;
function wasDismissed(id: string): boolean {
	try {
		return localStorage.getItem(dismissedKey(id)) === '1';
	} catch {
		return false;
	}
}

/** For the new Owner: the briefing they were handed, until they close it. */
export function BriefingCard({ handoff }: { handoff: Handoff }) {
	const [hidden, setHidden] = useState(() => wasDismissed(handoff.id));
	if (hidden) return null;
	return (
		<section
			aria-label="Handoff briefing"
			className="m-2 max-h-[45%] shrink-0 overflow-y-auto rounded-xl border border-ok/30 bg-ok-soft/50 p-3 text-sm"
		>
			<div className="flex items-start justify-between gap-2">
				<h3 className="font-semibold">
					{handoff.from.name.split(' ')[0]} handed you this session
				</h3>
				<button
					type="button"
					aria-label="Dismiss"
					className="text-muted hover:text-ink"
					onClick={() => {
						setHidden(true);
						try {
							localStorage.setItem(dismissedKey(handoff.id), '1');
						} catch {
							// Private mode: it just shows again next visit.
						}
					}}
				>
					<XIcon size={14} />
				</button>
			</div>
			{handoff.note && <p className="mt-1 italic">“{handoff.note}”</p>}
			<p className="mt-1.5 whitespace-pre-line">{handoff.briefing}</p>
		</section>
	);
}
