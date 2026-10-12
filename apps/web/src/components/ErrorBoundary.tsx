import { Component, type ReactNode } from 'react';

/** Shows a way out instead of a blank page if something in the UI throws. */
export class ErrorBoundary extends Component<
	{ children: ReactNode },
	{ error: Error | null }
> {
	state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	render() {
		if (!this.state.error) return this.props.children;
		return (
			<main className="mx-auto max-w-md px-4 py-24 text-center">
				<h1 className="text-xl font-semibold">Something went wrong</h1>
				<p className="mt-2 text-sm text-muted">
					The page hit an error it couldn’t recover from. Your work is saved:
					the document and timeline live on the server.
				</p>
				<p className="mt-2 break-words font-mono text-xs text-muted">
					{this.state.error.message}
				</p>
				<button
					type="button"
					onClick={() => window.location.reload()}
					className="mt-6 h-10 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink"
				>
					Reload
				</button>
			</main>
		);
	}
}
