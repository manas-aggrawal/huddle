import { Module } from '@nestjs/common';
import { LlmModule } from '@src/llm/llm.module';
import { SessionModule } from '@src/session/session.module';
import { CatchUpController } from './catch-up.controller';
import { CatchUpService } from './catch-up.service';

@Module({
	imports: [SessionModule, LlmModule],
	controllers: [CatchUpController],
	providers: [CatchUpService],
})
export class CatchUpModule {}
