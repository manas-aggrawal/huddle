// Local development seed. Idempotent: safe to run more than once.
// Demo users and sessions arrive with the full schema in #4.
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
	console.log('Seeding the database...');
	// Meets the API's password rules, so you can log in with it.
	const password = await bcrypt.hash('Admin@1234', 10);
	await prisma.user.upsert({
		where: { username: 'admin' },
		update: {},
		create: {
			username: 'admin',
			email: 'admin@huddle.local',
			firstname: 'Huddle',
			lastname: 'Admin',
			password,
			role: 'ADMIN',
		},
	});
	console.log('Seeded admin user (admin / Admin@1234)');
}

main()
	.catch((e) => {
		console.error(e);
		process.exit(1);
	})
	.finally(() => prisma.$disconnect());
