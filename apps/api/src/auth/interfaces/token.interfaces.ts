import { DefaultPayload } from './payload.interface';

/** Decoded JWT: the signed payload plus the standard timestamps. */
export interface UserPayload extends DefaultPayload {
	iat?: number;
	exp?: number;
}

/** What strategies attach to req.user. Never includes iat/exp, so it can be re-signed. */
export type UserFromJwt = DefaultPayload;
