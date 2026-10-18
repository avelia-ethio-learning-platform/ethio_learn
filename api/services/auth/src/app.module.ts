import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { entities, migrations, SCHEMA } from './database';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MembershipService } from './membership.service';
import { ProfilesController } from './profiles.controller';
import { AdminUsersController } from './admin.controller';
import { InternalController } from './internal.controller';

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions(SCHEMA, entities, migrations)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'auth', outbox: true }),
  ],
  controllers: [AuthController, ProfilesController, AdminUsersController, InternalController, HealthController],
  providers: [AuthService, MembershipService, InternalHttpClient],
})
export class AppModule {}
