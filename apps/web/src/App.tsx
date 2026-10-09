import { can, SessionRole } from '@huddle/shared';

// Placeholder until the app shell (#9) lands. Uses @huddle/shared to prove the workspace link works.
function App() {
	const viewer = { role: SessionRole.VIEWER };

	return (
		<main>
			<h1>Huddle</h1>
			<p>Viewer can suggest: {String(can(viewer, 'suggest'))}</p>
		</main>
	);
}

export default App;
