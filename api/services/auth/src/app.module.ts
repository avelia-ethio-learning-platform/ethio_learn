import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { EducatorProfile, EmailVerification, Institution, InstitutionInstructor, PasswordReset, User } from './entities';
import { AuditLog } from './audit';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ProfilesController } from './profiles.controller';
import { AdminUsersController } from './admin.controller';
import { InternalController } from './internal.controller';

const entities = [User, EmailVerification, PasswordReset, EducatorProfile, Institution, InstitutionInstructor, AuditLog];

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions('auth', entities)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'auth' }),
  ],
  controllers: [AuthController, ProfilesController, AdminUsersController, InternalController, HealthController],
  providers: [AuthService, InternalHttpClient],
})
export class AppModule {}
