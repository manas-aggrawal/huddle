import { PassportStrategy } from '@nestjs/passport';
import { JWT_REFRESH_TOKEN_SECRET } from '@src/configs/env-vars';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserFromJwt, UserPayload } from '../interfaces/token.interfaces';

export class RefreshTokenStrategy extends PassportStrategy(
	Strategy,
	'rt-strategy',
) {
	constructor() {
		super({
			jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
			ignoreExpiration: false,
			secretOrKey: JWT_REFRESH_TOKEN_SECRET,
		});
	}

	// Tokens are signed with { id, email, username, role } (see AuthService.giveTokens).
	// Return exactly that, without iat/exp, so the controller can re-sign it.
	async validate(payload: UserPayload): Promise<UserFromJwt> {
		return {
			id: payload.id,
			email: payload.email,
			username: payload.username,
			role: payload.role,
		};
	}
}
