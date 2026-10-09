import { Logger, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '@src/auth/auth.service';
import { UserController } from './user.controller';
import { UserService } from './user.service';

@Module({
	controllers: [UserController],
	providers: [UserService, Logger, AuthService, JwtService],
	exports: [UserService],
})
export class UserModule {}
