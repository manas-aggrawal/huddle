import { Module } from '@nestjs/common';
import { PrismaModule } from '@src/prisma/prisma.module';
import { TimelineService } from './timeline.service';

@Module({
	imports: [PrismaModule],
	providers: [TimelineService],
	exports: [TimelineService],
})
export class TimelineModule {}
