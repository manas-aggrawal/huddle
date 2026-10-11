import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { cleanupOpenApiDoc, ZodValidationPipe } from 'nestjs-zod';
import { ALLOWED_ORIGINS } from './configs/env-vars';

/**
 * Applies everything the app needs besides its modules: security headers, body
 * limits, CORS, validation and Swagger. Shared by main.ts and the e2e tests so
 * tests exercise the same request pipeline as production.
 */
export function configureApp(app: NestExpressApplication): void {
	// Helmet sets security-related HTTP headers (HSTS, X-Frame-Options,
	// X-Content-Type-Options, etc.). CSP is disabled here because Swagger UI
	// requires inline scripts — enable and tune it for your production environment.
	app.use(helmet({ contentSecurityPolicy: false }));

	// Limit request body size to prevent large-payload DoS attacks.
	app.useBodyParser('json', { limit: '10mb' });
	app.useBodyParser('urlencoded', { extended: true, limit: '10mb' });

	// ALLOWED_ORIGINS is a comma-separated list of allowed origins (e.g. "https://app.com,https://admin.com").
	// If unset, CORS is disabled entirely.
	const origins = ALLOWED_ORIGINS
		? ALLOWED_ORIGINS.split(',').map((o) => o.trim())
		: false;
	app.enableCors({
		origin: origins,
		credentials: true,
		methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
	});

	app.useGlobalPipes(new ZodValidationPipe());

	SwaggerModule.setup('/api/docs', app, buildOpenApiDocument(app));
}

/** The OpenAPI description of the API. Also exported to the web app's typed client (npm run gen:api). */
export function buildOpenApiDocument(app: INestApplication) {
	const config = new DocumentBuilder()
		.setTitle('Huddle API')
		.setDescription(
			'Multiplayer AI agents: sessions, roles, timeline, approvals and the agent runner',
		)
		.setVersion('0.1.0')
		// 3.1, because nestjs-zod's down-conversion to 3.0 turns nullable strings into arrays.
		.setOpenAPIVersion('3.1.0')
		.addTag('Auth')
		.addTag('Others')
		.addBearerAuth(
			{ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
			'access-token',
		)
		.addBearerAuth(
			{ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
			'refresh-token',
		)
		.addBearerAuth(
			{ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
			'forgot-password-token',
		)
		.build();
	return cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
}
