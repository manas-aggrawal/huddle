import { Module } from '@nestjs/common';
import { ApprovalModule } from '@src/approval/approval.module';
import { CollabModule } from '@src/collab/collab.module';
import { LlmModule } from '@src/llm/llm.module';
import { RealtimeModule } from '@src/realtime/realtime.module';
import { TimelineModule } from '@src/timeline/timeline.module';
import { AGENT_OPTIONS, defaultAgentOptions } from './agent.options';
import { AgentContextService } from './agent-context.service';
import { AgentRunner } from './agent-runner.service';
import { AgentStateService } from './agent-state.service';
import { AskResponderService } from './ask-responder.service';
import { PlannerService } from './planner.service';
import { QueueProcessorService } from './queue-processor.service';
import { ReplannerService } from './replanner.service';
import { SectionWriterService } from './section-writer.service';

@Module({
	imports: [
		TimelineModule,
		LlmModule,
		CollabModule,
		RealtimeModule,
		ApprovalModule,
	],
	providers: [
		{ provide: AGENT_OPTIONS, useFactory: defaultAgentOptions },
		AgentRunner,
		AgentStateService,
		AgentContextService,
		PlannerService,
		SectionWriterService,
		QueueProcessorService,
		AskResponderService,
		ReplannerService,
	],
	exports: [AgentRunner],
})
export class AgentModule {}
