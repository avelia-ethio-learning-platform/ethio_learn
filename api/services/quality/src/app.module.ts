import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions, EventBusModule, HealthController, InternalHttpClient } from '@ethiopialearn/common';
import { entities, migrations, SCHEMA } from './database';
import { QualityService } from './quality.service';
import { QualityController, QualityInternalController } from './controllers';

@Module({
  imports: [
    TypeOrmModule.forRoot(buildTypeOrmOptions(SCHEMA, entities, migrations)),
    TypeOrmModule.forFeature(entities),
    EventBusModule.forRoot({ serviceName: 'quality', outbox: true }),
  ],
  controllers: [QualityController, QualityInternalController, HealthController],
  providers: [QualityService, InternalHttpClient],
})
export class AppModule {}
