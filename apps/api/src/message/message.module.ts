import { Module } from '@nestjs/common';
import { RealtimeModule } from '@src/realtime/realtime.module';
import { SessionModule } from '@src/session/session.module';
import { TimelineModule } from '@src/timeline/timeline.module';
import { MessageService } from './message.service';
import { MessagesController } from './messages.controller';

@Module({
	imports: [TimelineModule, RealtimeModule, SessionModule],
	controllers: [MessagesController],
	providers: [MessageService],
	exports: [MessageService],
})
export class MessageModule {}
