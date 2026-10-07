import { DynamicModule, Global, Module } from '@nestjs/common';
import { EVENT_BUS_OPTIONS, EventBusOptions, EventBusService } from './event-bus.service';
import { OutboxService } from './outbox';

@Global()
@Module({})
export class EventBusModule {
  static forRoot(options: EventBusOptions): DynamicModule {
    const services = options.outbox ? [EventBusService, OutboxService] : [EventBusService];
    return {
      module: EventBusModule,
      providers: [{ provide: EVENT_BUS_OPTIONS, useValue: options }, ...services],
      exports: services,
    };
  }
}
