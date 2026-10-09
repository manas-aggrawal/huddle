import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { AccessTokenGuard } from './auth/guards/access-token.guard';
import { THROTTLE_LIMIT, THROTTLE_TTL } from './configs/env-vars';
import { HealthModule } from './health/health.module';
import { LoggerMiddleware } from './middleware/logger.middleware';
import { PrismaModule } from './prisma/prisma.module';
import { SessionModule } from './session/session.module';
import { TimelineModule } from './timeline/timeline.module';
import { UserModule } from './user/user.module';

@Module({
	imports: [
		ThrottlerModule.forRoot({
			throttlers: [
				{
					// Default: 100 requests per minute. Override per-route with @Throttle().
					ttl: Number(THROTTLE_TTL) || 60000,
					limit: Number(THROTTLE_LIMIT) || 100,
				},
			],
			// e2e suites register many users from one IP; Vitest sets NODE_ENV=test.
			skipIf: () => process.env.NODE_ENV === 'test',
		}),
		AuthModule,
		PrismaModule,
		HealthModule,
		UserModule,
		TimelineModule,
		SessionModule,
	],
	providers: [
		{
			// ThrottlerGuard must come before AccessTokenGuard so rate limits are
			// enforced before any auth work happens.
			provide: APP_GUARD,
			useClass: ThrottlerGuard,
		},
		{
			provide: APP_GUARD,
			useClass: AccessTokenGuard,
		},
	],
})
export class AppModule implements NestModule {
	configure(consumer: MiddlewareConsumer) {
		consumer.apply(LoggerMiddleware).forRoutes('*');
	}
}
