import { Module } from '@nestjs/common';
import { RealtimeModule } from '@src/realtime/realtime.module';
import { LlmService } from './llm.service';
import { LLM_PROVIDER_OVERRIDE } from './providers';
import { UsageService } from './usage.service';

@Module({
	imports: [RealtimeModule],
	providers: [
		LlmService,
		UsageService,
		// Real providers unless a test overrides this with a mock model factory.
		{ provide: LLM_PROVIDER_OVERRIDE, useValue: null },
	],
	exports: [LlmService, UsageService],
})
export class LlmModule {}
