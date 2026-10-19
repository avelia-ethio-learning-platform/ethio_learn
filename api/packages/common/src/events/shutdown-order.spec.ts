import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { EventBusModule } from './event-bus.module';
import { EventBusService } from './event-bus.service';
import { OutboxService } from './outbox';

@Global()
@Module({ providers: [{ provide: DataSource, useValue: { query: jest.fn(async () => []) } }], exports: [DataSource] })
class FakeDatabaseModule {}

@Module({ imports: [FakeDatabaseModule, EventBusModule.forRoot({ serviceName: 'shutdown-spec', outbox: true, url: 'amqp://127.0.0.1:1' })] })
class AppModule {}

afterEach(() => jest.restoreAllMocks());

/**
 * The outbox relay must stop before the bus it publishes through closes its
 * channels. Both are in EventBusModule, where Nest 10 and 11 alike (P2-45)
 * shut the bus down first, so the relay stops in beforeApplicationShutdown.
 */
describe('shutdown order', () => {
  it('stops the outbox relay before the event bus closes', async () => {
    // No broker in a unit test: the bus never starts connecting.
    jest.spyOn(EventBusService.prototype as unknown as { kick(): void }, 'kick').mockImplementation(() => undefined);
    const order: string[] = [];
    const outboxStop = OutboxService.prototype.beforeApplicationShutdown;
    const busStop = EventBusService.prototype.onApplicationShutdown;
    jest.spyOn(OutboxService.prototype, 'beforeApplicationShutdown').mockImplementation(function (this: OutboxService) {
      order.push('outbox');
      return outboxStop.call(this);
    });
    jest.spyOn(EventBusService.prototype, 'onApplicationShutdown').mockImplementation(function (this: EventBusService) {
      order.push('bus');
      return busStop.call(this);
    });

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    await app.close();

    expect(order).toEqual(['outbox', 'bus']);
  });
});
