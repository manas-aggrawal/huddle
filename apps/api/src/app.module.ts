import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AgentModule } from './agent/agent.module';
import { ApprovalModule } from './approval/approval.module';
import { AuthModule } from './auth/auth.module';
import { AccessTokenGuard } from './auth/guards/access-token.guard';
import { CatchUpModule } from './catch-up/catch-up.module';
import { CollabModule } from './collab/collab.module';
import { THROTTLE_LIMIT, THROTTLE_TTL } from './configs/env-vars';
import { ConflictModule } from './conflict/conflict.module';
import { DecisionModule } from './decision/decision.module';
import { HandoffModule } from './handoff/handoff.module';
import { HealthModule } from './health/health.module';
import { InviteModule } from './invite/invite.module';
import { LlmModule } from './llm/llm.module';
import { MessageModule } from './message/message.module';
import { LoggerMiddleware } from './middleware/logger.middleware';
import { ModelsModule } from './models/models.module';
import { PlanModule } from './plan/plan.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
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
		InviteModule,
		RealtimeModule,
		CollabModule,
		ModelsModule,
		LlmModule,
		ApprovalModule,
		MessageModule,
		DecisionModule,
		ConflictModule,
		PlanModule,
		CatchUpModule,
		HandoffModule,
		AgentModule,
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
