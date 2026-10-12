import { Module } from '@nestjs/common';
import { DecisionModule } from '@src/decision/decision.module';
import { SessionModule } from '@src/session/session.module';
import { TimelineModule } from '@src/timeline/timeline.module';
import { ConflictService } from './conflict.service';
import { ConflictsController } from './conflicts.controller';

@Module({
	imports: [TimelineModule, SessionModule, DecisionModule],
	controllers: [ConflictsController],
	providers: [ConflictService],
	exports: [ConflictService],
})
export class ConflictModule {}
