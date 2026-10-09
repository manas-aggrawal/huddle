import { Role } from '@src/enum/role';

export interface DefaultPayload {
	id: string;
	email: string;
	username: string;
	role: Role;
}
