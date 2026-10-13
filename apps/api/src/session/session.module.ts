import { Module } from '@nestjs/common';
import { RealtimeModule } from '@src/realtime/realtime.module';
import { TimelineModule } from '@src/timeline/timeline.module';
import { SessionAccessGuard } from './guards/session-access.guard';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';

@Module({
	imports: [TimelineModule, RealtimeModule],
	controllers: [SessionController, MembersController],
	providers: [SessionService, MembersService, SessionAccessGuard],
	exports: [SessionAccessGuard, SessionService],
})
export class SessionModule {}
