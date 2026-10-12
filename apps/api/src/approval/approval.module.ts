import { Module } from '@nestjs/common';
import { SessionModule } from '@src/session/session.module';
import { TimelineModule } from '@src/timeline/timeline.module';
import { ApprovalService } from './approval.service';
import { ApprovalsController } from './approvals.controller';

@Module({
	imports: [TimelineModule, SessionModule],
	controllers: [ApprovalsController],
	providers: [ApprovalService],
	exports: [ApprovalService],
})
export class ApprovalModule {}
