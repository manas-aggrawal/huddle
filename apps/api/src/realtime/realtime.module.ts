import { Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TimelineModule } from '@src/timeline/timeline.module';
import { BroadcastService } from './broadcast.service';
import { PresenceService } from './presence.service';
import { SessionGateway } from './session.gateway';

@Module({
	imports: [TimelineModule],
	providers: [SessionGateway, PresenceService, BroadcastService, JwtService],
	exports: [BroadcastService],
})
export class RealtimeModule {}
