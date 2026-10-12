import { Module } from '@nestjs/common';
import { SessionModule } from '@src/session/session.module';
import { TimelineModule } from '@src/timeline/timeline.module';
import { DecisionService } from './decision.service';
import { DecisionsController } from './decisions.controller';

@Module({
	imports: [TimelineModule, SessionModule],
	controllers: [DecisionsController],
	providers: [DecisionService],
	exports: [DecisionService],
})
export class DecisionModule {}
