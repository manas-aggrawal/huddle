import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyStoredTheme } from './components/ui';

applyStoredTheme();

const root = document.getElementById('root');
if (!root) {
	throw new Error('Missing #root element in index.html');
}

createRoot(root).render(
	<StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</StrictMode>,
);
