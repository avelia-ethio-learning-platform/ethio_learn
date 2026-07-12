import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController } from '@ethiopialearn/common';
import { InboxNotification, NotificationLog, NotificationPreference } from './entities';
import { EMAIL_PROVIDER, emailProviderClass } from './email.provider';
import { NotificationService } from './notification.service';
import { NotificationController } from './controllers';

const entities = [NotificationLog, NotificationPreference, InboxNotification];

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions('notification', entities)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'notification' }),
  ],
  controllers: [NotificationController, HealthController],
  providers: [{ provide: EMAIL_PROVIDER, useClass: emailProviderClass() }, NotificationService],
})
export class AppModule {}
