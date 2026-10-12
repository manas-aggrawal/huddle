// Demo seed: the four people from the demo script, each with a personal
// workspace. Idempotent. `--reset` also deletes their sessions, for a clean run.
//
//   npm run seed:demo -w @huddle/api            # create the users
//   npm run seed:demo -w @huddle/api -- --reset # …and wipe their sessions
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const PASSWORD = 'Huddle@2026';

const PEOPLE = [
	{ username: 'maya', firstname: 'Maya', lastname: 'Chen', note: 'PM, creates and owns the session' },
	{ username: 'leo', firstname: 'Leo', lastname: 'Park', note: 'designer, joins as Editor' },
	{ username: 'raj', firstname: 'Raj', lastname: 'Mehta', note: 'engineer, joins as Editor' },
	{ username: 'dana', firstname: 'Dana', lastname: 'Silva', note: 'stakeholder, joins as Viewer' },
];

async function main() {
	const reset = process.argv.includes('--reset');
	const password = await bcrypt.hash(PASSWORD, 10);

	for (const p of PEOPLE) {
		const email = `${p.username}@huddle.demo`;
		const existing = await prisma.user.findUnique({ where: { username: p.username } });
		if (existing) continue;
		await prisma.user.create({
			data: {
				username: p.username,
				email,
				password,
				firstname: p.firstname,
				lastname: p.lastname,
				workspaceMemberships: {
					create: {
						role: 'ADMIN',
						workspace: { create: { name: `${p.firstname}'s workspace` } },
					},
				},
			},
		});
	}

	if (reset) {
		const users = await prisma.user.findMany({
			where: { username: { in: PEOPLE.map((p) => p.username) } },
			select: { id: true },
		});
		const { count } = await prisma.session.deleteMany({
			where: { members: { some: { userId: { in: users.map((u) => u.id) }, role: 'OWNER' } } },
		});
		await prisma.notification.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
		await prisma.workspace.updateMany({
			where: { members: { some: { userId: { in: users.map((u) => u.id) } } } },
			data: { tokensUsedThisPeriod: 0, periodStart: new Date() },
		});
		console.log(`Removed ${count} demo session(s) and reset the token pools.`);
	}

	console.log('\nDemo users (password for all: %s):', PASSWORD);
	for (const p of PEOPLE) console.log(`  ${p.username.padEnd(5)} ${p.firstname} ${p.lastname}, ${p.note}`);
	console.log('\nLog in as each in its own browser profile (or a private window), then follow');
	console.log('“Demo script” in the README.');
}

main()
	.catch((e) => {
		console.error(e);
		process.exit(1);
	})
	.finally(() => prisma.$disconnect());
