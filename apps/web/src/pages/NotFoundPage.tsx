import { Link } from 'react-router';
import { CenteredPage } from '../components/CenteredPage';

export function NotFoundPage() {
	return (
		<CenteredPage title="Page not found" subtitle="That page doesn't exist.">
			<Link to="/" className="text-sm font-medium text-accent hover:underline">
				Go home
			</Link>
		</CenteredPage>
	);
}
