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

/**
 * The broker did not acknowledge an event: the connection or channel failed,
 * it refused the message, or no acknowledgement came in time. Callers that
 * retry (the financial re-publish cron) stop their batch on this error, since
 * a broker that is down won't recover mid-batch.
 */
export class BrokerPublishError extends Error {
  constructor(eventType: string, reason: string) {
    super(`${eventType} was not acknowledged by the broker: ${reason}`);
    this.name = 'BrokerPublishError';
  }
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
  // Opened on first use by publishConfirmed only; publish() keeps the plain channel.
  private confirmChannel: amqp.ConfirmChannel | null = null;
  private openingConfirmChannel: Promise<amqp.ConfirmChannel> | null = null;
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
    const envelope = this.envelope(eventType, payload, correlationId);
    const channel = await this.getChannel();
    channel.publish(EVENTS_EXCHANGE, '', Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
      contentType: 'application/json',
    });
    this.logger.log(`published ${eventType} (${envelope.metadata.event_id})`);
  }

  /**
   * Publish an event and resolve only once the broker has acknowledged it
   * (publisher confirms), so the caller can record that it was delivered.
   * Rejects with BrokerPublishError when the broker can't be reached, refuses
   * the message or doesn't confirm within `timeoutMs` (default 5 s). Without
   * the confirm, a plain publish resolves as soon as the message is buffered
   * and a dead link loses it silently.
   */
  async publishConfirmed<P>(eventType: EventType, payload: P, opts: { timeoutMs?: number; correlationId?: string } = {}): Promise<void> {
    const envelope = this.envelope(eventType, payload, opts.correlationId);
    const timeoutMs = opts.timeoutMs ?? 5000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrokerPublishError(eventType, `no acknowledgement within ${timeoutMs} ms`)), timeoutMs);
    });
    const delivery = (async () => {
      const channel = await this.getConfirmChannel();
      await new Promise<void>((resolve, reject) =>
        channel.publish(EVENTS_EXCHANGE, '', Buffer.from(JSON.stringify(envelope)), { persistent: true, contentType: 'application/json' }, (err) =>
          err ? reject(err) : resolve(),
        ),
      );
    })();
    try {
      await Promise.race([delivery, timeout]);
    } catch (err) {
      if (err instanceof BrokerPublishError) throw err;
      throw new BrokerPublishError(eventType, (err as Error)?.message ?? String(err));
    } finally {
      clearTimeout(timer);
    }
    delivery.catch(() => undefined); // a late failure after a timeout is already reported
    this.logger.log(`published ${eventType} (${envelope.metadata.event_id}), confirmed by the broker`);
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
      await this.confirmChannel?.close();
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

  private getConfirmChannel(): Promise<amqp.ConfirmChannel> {
    if (this.confirmChannel) return Promise.resolve(this.confirmChannel);
    this.openingConfirmChannel ??= (async () => {
      try {
        await this.getChannel(); // connects and asserts the exchanges
        const channel: amqp.ConfirmChannel = await (this.connection as any).createConfirmChannel();
        // A channel-level error closes only this channel: drop it so the next call opens a new one.
        channel.on('error', (err: Error) => this.logger.warn(`confirm channel error: ${err.message}`));
        channel.on('close', () => {
          if (this.confirmChannel === channel) this.confirmChannel = null;
        });
        this.confirmChannel = channel;
        return channel;
      } finally {
        this.openingConfirmChannel = null;
      }
    })();
    return this.openingConfirmChannel;
  }

  private envelope<P>(eventType: EventType, payload: P, correlationId?: string): EventEnvelope<P> {
    return {
      event_type: eventType,
      payload,
      metadata: {
        event_id: randomUUID(),
        timestamp: new Date().toISOString(),
        producer_service: this.options.serviceName,
        correlation_id: correlationId ?? randomUUID(),
      },
    };
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
          this.confirmChannel = null;
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
