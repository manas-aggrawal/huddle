export const {
	PORT,
	PORT_DATABASE,
	PG_USER,
	PG_PASSWORD,
	PG_DATABASE_NAME,
	JWT_ACCESS_TOKEN_SECRET,
	JWT_REFRESH_TOKEN_SECRET,
	JWT_FORGOT_PASSWORD_SECRET,
	DATABASE_URL,
	// Rate limiting (see ThrottlerModule in app.module.ts)
	THROTTLE_TTL, // Time window in ms, default: 60000 (1 min)
	THROTTLE_LIMIT, // Max requests per window for general routes, default: 100
	// CORS — comma-separated list of allowed origins; unset = CORS disabled
	ALLOWED_ORIGINS,
	// Where the web app runs; invite links point here
	WEB_APP_URL = 'http://localhost:5173',
	// Model a new session uses when the creator doesn't pick one
	DEFAULT_MODEL_PROVIDER = 'groq',
	DEFAULT_MODEL_ID = 'llama-3.3-70b-versatile',
	// Token lifetimes (vercel/ms format, e.g. "30s", "15m", "1h"). Shorten the access one to test silent refresh.
	ACCESS_TOKEN_TTL = '1h',
	REFRESH_TOKEN_TTL = '8h',
} = process.env;
