import { SessionStatus, WorkspaceRole } from '@huddle/shared';
import {
	ForbiddenException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@src/prisma/prisma.service';
import { SessionService } from '@src/session/session.service';
import { POOL_EXHAUSTED } from './workspace.constants';

export interface WorkspaceUsage {
	workspaceId: string;
	tokenAllowance: number;
	tokensUsedThisPeriod: number;
	periodStart: string;
}

/** The workspace's shared token pool. Members can see it; only admins can change it. */
@Injectable()
export class WorkspaceService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly sessions: SessionService,
	) {}

	async usage(userId: string, workspaceId: string): Promise<WorkspaceUsage> {
		await this.membership(userId, workspaceId);
		return this.read(workspaceId);
	}

	/** Admins only. Raising it past what's used resumes the sessions the empty pool paused. */
	async setAllowance(
		userId: string,
		workspaceId: string,
		tokenAllowance: number,
	): Promise<WorkspaceUsage> {
		const m = await this.membership(userId, workspaceId);
		if (m.role !== WorkspaceRole.ADMIN) {
			throw new ForbiddenException(
				'Only a workspace admin can change the token allowance',
			);
		}
		const ws = await this.prisma.workspace.update({
			where: { id: workspaceId },
			data: { tokenAllowance },
		});
		if (ws.tokensUsedThisPeriod < ws.tokenAllowance) {
			const paused = await this.prisma.session.findMany({
				where: { workspaceId, status: SessionStatus.PAUSED },
				select: { id: true },
			});
			for (const s of paused)
				await this.sessions.resumeBySystem(s.id, POOL_EXHAUSTED);
		}
		return this.read(workspaceId);
	}

	private async membership(userId: string, workspaceId: string) {
		const m = await this.prisma.workspaceMember.findUnique({
			where: { workspaceId_userId: { workspaceId, userId } },
		});
		// Same answer for "doesn't exist" and "not yours".
		if (!m) throw new NotFoundException('Workspace not found');
		return m;
	}

	private async read(workspaceId: string): Promise<WorkspaceUsage> {
		const ws = await this.prisma.workspace.findUniqueOrThrow({
			where: { id: workspaceId },
		});
		return {
			workspaceId: ws.id,
			tokenAllowance: ws.tokenAllowance,
			tokensUsedThisPeriod: ws.tokensUsedThisPeriod,
			periodStart: ws.periodStart.toISOString(),
		};
	}
}
