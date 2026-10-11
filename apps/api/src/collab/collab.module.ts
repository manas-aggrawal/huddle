import { Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TimelineModule } from '@src/timeline/timeline.module';
import { AgentDocWriter } from './agent-doc-writer.service';
import { CollabServer } from './collab.server';
import { DocActivityService } from './doc-activity.service';

@Module({
	imports: [TimelineModule],
	providers: [CollabServer, DocActivityService, AgentDocWriter, JwtService],
	exports: [AgentDocWriter],
})
export class CollabModule {}
