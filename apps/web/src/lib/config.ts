/** Base URL of the API (REST, Socket.IO and the document server). */
export const API_URL = (
	import.meta.env.VITE_API_URL ?? 'http://localhost:3001'
).replace(/\/$/, '');
