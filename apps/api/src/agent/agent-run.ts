/**
 * One session's agent while it works. The loop runs until there's nothing to
 * do; `wake()` while it runs makes it look again before stopping.
 */
export class AgentRun {
	/** Aborts the current model call (pause, interrupt). The loop itself carries on. */
	private current = new AbortController();
	/** Set by stop(): the loop exits at its next check. */
	stopped = false;
	/** Something changed while the loop was running; check again before exiting. */
	wakeAgain = false;
	/** What the loop is doing now, so an interrupt knows whether to cut it off. */
	phase: string | null = null;
	/** Resolves when the loop has exited. */
	done: Promise<void> = Promise.resolve();

	constructor(readonly sessionId: string) {}

	/** The signal for the next model call. */
	get signal(): AbortSignal {
		if (this.current.signal.aborted) this.current = new AbortController();
		return this.current.signal;
	}

	/** Whether the current operation was cut off. */
	get aborted(): boolean {
		return this.current.signal.aborted;
	}

	abortCurrent(reason = 'aborted') {
		this.current.abort(new Error(reason));
	}

	stop() {
		this.stopped = true;
		this.abortCurrent('stopped');
	}
}
