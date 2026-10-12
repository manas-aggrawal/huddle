import { Module } from '@nestjs/common';
import { SessionModule } from '@src/session/session.module';
import { TimelineModule } from '@src/timeline/timeline.module';
import { MessageService } from './message.service';
import { MessagesController } from './messages.controller';

@Module({
	imports: [TimelineModule, SessionModule],
	controllers: [MessagesController],
	providers: [MessageService],
	exports: [MessageService],
})
export class MessageModule {}
