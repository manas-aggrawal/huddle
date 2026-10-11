import { Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TimelineModule } from '@src/timeline/timeline.module';
import { PresenceService } from './presence.service';
import { SessionGateway } from './session.gateway';

@Module({
	imports: [TimelineModule],
	providers: [SessionGateway, PresenceService, JwtService],
})
export class RealtimeModule {}
