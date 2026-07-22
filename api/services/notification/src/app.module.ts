import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { CourseComment, DmMessage, DmThread, InboxNotification, NotificationLog, NotificationPreference } from './entities';
import { EMAIL_PROVIDER, emailProviderClass } from './email.provider';
import { NotificationService } from './notification.service';
import { NotificationController } from './controllers';
import { CommunityService } from './community.service';
import { CommunityController } from './community.controller';

const entities = [NotificationLog, NotificationPreference, InboxNotification, CourseComment, DmThread, DmMessage];

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions('notification', entities)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'notification' }),
  ],
  controllers: [NotificationController, CommunityController, HealthController],
  providers: [{ provide: EMAIL_PROVIDER, useClass: emailProviderClass() }, NotificationService, CommunityService, InternalHttpClient],
})
export class AppModule {}
