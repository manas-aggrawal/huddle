import { User } from '@prisma/client';
import { Role } from '@src/enum/role';
import { UserProfileDto } from './dto/user.response';

/**
 * Maps a database row to the API shape: ISO date strings, and the role column
 * (a plain string in the DB) narrowed to the shared Role type.
 */
export function toUserDto(user: Omit<User, 'password'>): UserProfileDto {
	return {
		id: user.id,
		username: user.username,
		email: user.email,
		firstname: user.firstname,
		lastname: user.lastname,
		role: user.role as Role,
		createdAt: user.createdAt.toISOString(),
		updatedAt: user.updatedAt.toISOString(),
	};
}
