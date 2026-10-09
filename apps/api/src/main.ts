// Load .env before anything reads process.env (configs/env-vars.ts reads it at import time).
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '@src/app.module';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { configureApp } from './app.setup';
import { PORT } from './configs/env-vars';

async function bootstrap() {
	const logger = WinstonModule.createLogger({
		level: 'info',
		format: winston.format.combine(
			winston.format.timestamp(),
			winston.format.errors({ stack: true }),
			winston.format.json(),
		),
		transports: [
			new winston.transports.Console({
				format: winston.format.combine(
					winston.format.colorize(),
					winston.format.simple(),
				),
			}),
			new winston.transports.File({
				filename: 'logs/error.log',
				level: 'error',
			}),
			new winston.transports.File({
				filename: 'logs/combined.log',
			}),
		],
	});
	const app = await NestFactory.create<NestExpressApplication>(AppModule, {
		logger,
		// Body parsing is configured in configureApp with explicit size limits.
		bodyParser: false,
	});
	configureApp(app);

	const port = PORT ?? 3001;
	await app.listen(port);
	logger.log(`Server running on http://localhost:${port}`, 'App');
	logger.log(
		`OpenAPI docs running on http://localhost:${port}/api/docs`,
		'App',
	);
}
bootstrap();
