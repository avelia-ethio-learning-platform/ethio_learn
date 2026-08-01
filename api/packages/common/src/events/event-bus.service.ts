import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import { EventEnvelope, EventType } from '@ethiopialearn/contracts';
import { envOrLocalDefault } from '../config/env';

export const EVENTS_EXCHANGE = 'ethiopialearn.events';
export const COMMANDS_EXCHANGE = 'ethiopialearn.commands';
export const EVENT_BUS_OPTIONS = 'EVENT_BUS_OPTIONS';

export interface EventBusOptions {
  serviceName: string;
  /** amqp:// URL. Defaults to env RABBITMQ_URL. */
  url?: string;
}

export type EventHandler<P = any> = (payload: P, envelope: EventEnvelope<P>) => Promise<void> | void;
export type CommandHandler = (message: { command: string; payload?: unknown }) => Promise<void> | void;

/**
 * Thin RabbitMQ wrapper implementing the spec's two exchanges:
 *  - `ethiopialearn.events`   (fanout) — every service gets its own queue and
 *    filters by `event_type` in the message body.
 *  - `ethiopialearn.commands` (direct) — point-to-point, routing key = service name.
 *
 * Handlers are registered during module init (`subscribe`); consumption starts
 * on application bootstrap so registration order never races the consumer.
 */
@Injectable()
export class EventBusService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(EventBusService.name);
  // amqplib 0.10.4+ `connect()` resolves to a ChannelModel wrapping the raw Connection.
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private readonly eventHandlers = new Map<EventType, EventHandler[]>();
  private readonly commandHandlers: CommandHandler[] = [];
  private connecting: Promise<amqp.Channel> | null = null;
  private shuttingDown = false;

  constructor(@Inject(EVENT_BUS_OPTIONS) private readonly options: EventBusOptions) {}

  subscribe<P = any>(eventType: EventType, handler: EventHandler<P>): void {
    const list = this.eventHandlers.get(eventType) ?? [];
    list.push(handler as EventHandler);
    this.eventHandlers.set(eventType, list);
  }

  subscribeCommands(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }

  async publish<P>(eventType: EventType, payload: P, correlationId?: string): Promise<void> {
    const envelope: EventEnvelope<P> = {
      event_type: eventType,
      payload,
      metadata: {
        event_id: randomUUID(),
        timestamp: new Date().toISOString(),
        producer_service: this.options.serviceName,
        correlation_id: correlationId ?? randomUUID(),
      },
    };
    const channel = await this.getChannel();
    channel.publish(EVENTS_EXCHANGE, '', Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
      contentType: 'application/json',
    });
    this.logger.log(`published ${eventType} (${envelope.metadata.event_id})`);
  }

  async publishCommand(targetService: string, command: string, payload?: unknown): Promise<void> {
    const channel = await this.getChannel();
    channel.publish(COMMANDS_EXCHANGE, targetService, Buffer.from(JSON.stringify({ command, payload })), {
      persistent: true,
      contentType: 'application/json',
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    // Connect in the background so a slow RabbitMQ never blocks HTTP startup.
    this.startConsuming().catch((err) => this.logger.error(`event bus init failed: ${err.message}`));
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    try {
      await this.channel?.close();
      await (this.connection as any)?.close();
    } catch {
      /* already closed */
    }
  }

  private async getChannel(): Promise<amqp.Channel> {
    if (this.channel) return this.channel;
    const pending = this.connecting ?? (this.connecting = this.connect());
    return pending;
  }

  private async connect(): Promise<amqp.Channel> {
    const url = this.options.url ?? envOrLocalDefault('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672');
    let attempt = 0;
    // Retry: RabbitMQ regularly starts slower than the services in docker-compose.
    for (;;) {
      try {
        this.connection = await amqp.connect(url);
        (this.connection as any).on('close', () => {
          this.channel = null;
          this.connecting = null;
          if (!this.shuttingDown) {
            this.logger.warn('RabbitMQ connection closed; reconnecting…');
            setTimeout(() => this.startConsuming().catch(() => undefined), 3000);
          }
        });
        const channel = await (this.connection as any).createChannel();
        await channel.assertExchange(EVENTS_EXCHANGE, 'fanout', { durable: true });
        await channel.assertExchange(COMMANDS_EXCHANGE, 'direct', { durable: true });
        this.channel = channel;
        this.logger.log(`connected to RabbitMQ as ${this.options.serviceName}`);
        return channel;
      } catch (err) {
        attempt += 1;
        if (this.shuttingDown || attempt > 60) throw err;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private async startConsuming(): Promise<void> {
    const channel = await this.getChannel();
    const { serviceName } = this.options;

    if (this.eventHandlers.size > 0) {
      const queue = `${serviceName}.events`;
      await channel.assertQueue(queue, { durable: true });
      await channel.bindQueue(queue, EVENTS_EXCHANGE, '');
      await channel.consume(queue, async (msg) => {
        if (!msg) return;
        try {
          const envelope = JSON.parse(msg.content.toString()) as EventEnvelope;
          const handlers = this.eventHandlers.get(envelope.event_type) ?? [];
          for (const handler of handlers) {
            await handler(envelope.payload, envelope);
          }
        } catch (err) {
          // Ack after logging to avoid poison-message loops in MVP.
          // TODO(spec-open-question): add a dead-letter queue before production.
          this.logger.error(`event handler failed: ${(err as Error).message}`, (err as Error).stack);
        }
        channel.ack(msg);
      });
      this.logger.log(`consuming events on ${queue} (${[...this.eventHandlers.keys()].join(', ')})`);
    }

    if (this.commandHandlers.length > 0) {
      const queue = `${serviceName}.commands`;
      await channel.assertQueue(queue, { durable: true });
      await channel.bindQueue(queue, COMMANDS_EXCHANGE, serviceName);
      await channel.consume(queue, async (msg) => {
        if (!msg) return;
        try {
          const message = JSON.parse(msg.content.toString());
          for (const handler of this.commandHandlers) await handler(message);
        } catch (err) {
          this.logger.error(`command handler failed: ${(err as Error).message}`);
        }
        channel.ack(msg);
      });
    }
  }
}
