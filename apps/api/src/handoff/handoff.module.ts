import { Module } from '@nestjs/common';
import { LlmModule } from '@src/llm/llm.module';
import { RealtimeModule } from '@src/realtime/realtime.module';
import { SessionModule } from '@src/session/session.module';
import { TimelineModule } from '@src/timeline/timeline.module';
import { HandoffController } from './handoff.controller';
import { HandoffService } from './handoff.service';

@Module({
	imports: [TimelineModule, RealtimeModule, SessionModule, LlmModule],
	controllers: [HandoffController],
	providers: [HandoffService],
})
export class HandoffModule {}
