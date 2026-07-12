import { DynamicModule, Global, Module } from '@nestjs/common';
import { EVENT_BUS_OPTIONS, EventBusOptions, EventBusService } from './event-bus.service';

@Global()
@Module({})
export class EventBusModule {
  static forRoot(options: EventBusOptions): DynamicModule {
    return {
      module: EventBusModule,
      providers: [{ provide: EVENT_BUS_OPTIONS, useValue: options }, EventBusService],
      exports: [EventBusService],
    };
  }
}
