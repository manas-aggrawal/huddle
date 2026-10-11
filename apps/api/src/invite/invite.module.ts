import { Module } from '@nestjs/common';
import { TimelineModule } from '@src/timeline/timeline.module';
import { InviteController } from './invite.controller';
import { InviteService } from './invite.service';
import { SessionInvitesController } from './session-invites.controller';

@Module({
	imports: [TimelineModule],
	controllers: [SessionInvitesController, InviteController],
	providers: [InviteService],
})
export class InviteModule {}
