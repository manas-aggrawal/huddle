import { Module } from '@nestjs/common';
import { SessionModule } from '@src/session/session.module';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

@Module({
	imports: [SessionModule],
	controllers: [WorkspaceController],
	providers: [WorkspaceService],
})
export class WorkspaceModule {}
