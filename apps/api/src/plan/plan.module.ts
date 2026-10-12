import { Module } from '@nestjs/common';
import { SessionModule } from '@src/session/session.module';
import { TimelineModule } from '@src/timeline/timeline.module';
import { PlanController } from './plan.controller';
import { PlanService } from './plan.service';

@Module({
	imports: [TimelineModule, SessionModule],
	controllers: [PlanController],
	providers: [PlanService],
})
export class PlanModule {}
