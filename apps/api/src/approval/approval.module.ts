import { Module } from '@nestjs/common';
import { DecisionModule } from '@src/decision/decision.module';
import { RealtimeModule } from '@src/realtime/realtime.module';
import { SessionModule } from '@src/session/session.module';
import { TimelineModule } from '@src/timeline/timeline.module';
import { ApprovalService } from './approval.service';
import { ApprovalsController } from './approvals.controller';

@Module({
	imports: [TimelineModule, RealtimeModule, SessionModule, DecisionModule],
	controllers: [ApprovalsController],
	providers: [ApprovalService],
	exports: [ApprovalService],
})
export class ApprovalModule {}
