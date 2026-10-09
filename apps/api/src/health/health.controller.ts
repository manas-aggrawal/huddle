import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { IsPublic } from '@src/auth/decorators/is-public';
import { PrismaHealthIndicator } from '@src/prisma/health/prisma.health';

@Controller()
export class HealthController {
	constructor(
		private health: HealthCheckService,
		private db: PrismaHealthIndicator,
	) {}

	@IsPublic()
	@SkipThrottle()
	@Get('/health')
	@ApiTags('Others')
	@HealthCheck()
	async check() {
		const healthCheck = await this.health.check([
			() => this.db.isHealthy('db'),
		]);
		return {
			status: healthCheck.status,
			details: healthCheck.details,
		};
	}
}
