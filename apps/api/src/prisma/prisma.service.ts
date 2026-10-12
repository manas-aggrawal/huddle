import {
	Injectable,
	OnApplicationShutdown,
	OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
	extends PrismaClient
	implements OnModuleInit, OnApplicationShutdown
{
	async onModuleInit() {
		await this.$connect();
	}

	// The last shutdown phase: services still save during onModuleDestroy and
	// beforeApplicationShutdown (the agent's final writes, open documents).
	async onApplicationShutdown() {
		await this.$disconnect();
	}
}
