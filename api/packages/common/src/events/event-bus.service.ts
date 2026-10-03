import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';
import { EventEnvelope, EventType } from '@ethiopialearn/contracts';
import { envInt, envOrLocalDefault } from '../config/env';
import { eventContext } from './event-context';

export const EVENTS_EXCHANGE = 'ethiopialearn.events';
export const COMMANDS_EXCHANGE = 'ethiopialearn.commands';
export const EVENT_BUS_OPTIONS = 'EVENT_BUS_OPTIONS';

/** A parked queue keeps at most this many messages. Never change it without renaming the queue. */
const PARKED_MAX_LENGTH = 10_000;

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

interface NamedHandler {
  name: string;
  fn: EventHandler;
}

/**
 * Thin RabbitMQ wrapper implementing the spec's two exchanges:
 *  - `ethiopialearn.events`   (fanout) — every service gets its own queue and
 *    filters by `event_type` in the message body.
 *  - `ethiopialearn.commands` (direct) — point-to-point, routing key = service name.
 *
 * Handlers are registered during module init (`subscribe`); consumption starts
 * on application bootstrap so registration order never races the consumer.
 *
 * Resilience (Phase 9a):
 *  - A supervisor connects with capped backoff and never gives up. A dropped
 *    connection reconnects; a channel the broker closes on its own (a
 *    channel-level error) is reopened on the same connection. Either way the
 *    topology is asserted again and the consumers restart.
 *  - `publish` waits at most EVENT_PUBLISH_WAIT_MS for the broker, then throws.
 *  - A handler that throws is retried through `<service>.events.retry.<n>s`
 *    (a TTL queue that dead-letters back to this service's queue only), and
 *    after EVENT_MAX_ATTEMPTS it is parked in `<service>.events.parked`. The
 *    main queue keeps its original declaration: redeclaring a queue with other
 *    arguments fails with PRECONDITION_FAILED.
 */
@Injectable()
export class EventBusService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(EventBusService.name);
  // amqplib 0.10.4+ `connect()` resolves to a ChannelModel wrapping the raw Connection.
  private connection: amqp.ChannelModel | null = null;
  // Consumes, and carries plain publishes.
  private channel: amqp.Channel | null = null;
  // Opened on first use: publishConfirmed, and the retry and park republishes.
  private confirmChannel: amqp.ConfirmChannel | null = null;
  private openingConfirmChannel: Promise<amqp.ConfirmChannel> | null = null;
  private readonly eventHandlers = new Map<EventType, NamedHandler[]>();
  private readonly commandHandlers: CommandHandler[] = [];
  private readonly channelWaiters = new Set<(channel: amqp.Channel) => void>();
  private supervising: Promise<void> | null = null;
  private wakeSupervisor: (() => void) | null = null;
  private lostAt: number | null = null;
  private shuttingDown = false;

  private readonly prefetch = envInt('EVENT_PREFETCH', 4);
  private readonly maxAttempts = envInt('EVENT_MAX_ATTEMPTS', 5);
  // Whole seconds, because the retry queue's name carries the delay in seconds: two values
  // that round to one name with different TTLs would fail every connect (PRECONDITION_FAILED).
  private readonly retryDelayMs = Math.max(1, Math.round(envInt('EVENT_RETRY_DELAY_MS', 60_000) / 1000)) * 1000;
  private readonly publishWaitMs = envInt('EVENT_PUBLISH_WAIT_MS', 5_000);
  private readonly heartbeatS = envInt('EVENT_HEARTBEAT_S', 30);

  constructor(@Inject(EVENT_BUS_OPTIONS) private readonly options: EventBusOptions) {}

  /**
   * `name` labels the handler in logs and in parked messages. A handler that
   * dedupes with `runOnce` must pass one, and use it as runOnce's consumer: the
   * default is positional and shifts when a handler is added ahead of it.
   */
  subscribe<P = any>(eventType: EventType, handler: EventHandler<P>, opts: { name?: string } = {}): void {
    const list = this.eventHandlers.get(eventType) ?? [];
    list.push({ name: opts.name ?? `${this.options.serviceName}:${eventType}:${list.length}`, fn: handler as EventHandler });
    this.eventHandlers.set(eventType, list);
  }

  subscribeCommands(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }

  /** True when the connection and the main channel are both open: the bus can publish and is consuming. */
  isConnected(): boolean {
    return this.connection !== null && this.channel !== null;
  }

  /** Fire-and-forget publish. Throws BrokerPublishError if the broker isn't reachable within EVENT_PUBLISH_WAIT_MS. */
  async publish<P>(eventType: EventType, payload: P, correlationId?: string): Promise<void> {
    const envelope = this.envelope(eventType, payload, correlationId);
    await this.publishPlain(eventType, EVENTS_EXCHANGE, '', Buffer.from(JSON.stringify(envelope)));
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
    await this.publishWithConfirm(eventType, EVENTS_EXCHANGE, '', Buffer.from(JSON.stringify(envelope)), {}, opts.timeoutMs ?? 5000);
    this.logger.log(`published ${eventType} (${envelope.metadata.event_id}), confirmed by the broker`);
  }

  async publishCommand(targetService: string, command: string, payload?: unknown): Promise<void> {
    await this.publishPlain(command, COMMANDS_EXCHANGE, targetService, Buffer.from(JSON.stringify({ command, payload })));
  }

  async onApplicationBootstrap(): Promise<void> {
    // Connect in the background so a slow or absent RabbitMQ never blocks HTTP startup.
    this.kick();
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.wakeSupervisor?.();
    for (const closable of [this.channel, this.confirmChannel, this.connection]) {
      try {
        await (closable as { close(): Promise<void> } | null)?.close();
      } catch {
        /* already closed */
      }
    }
    this.channel = null;
    this.confirmChannel = null;
    this.connection = null;
  }

  // ---- connection supervisor ----

  /**
   * Starts the supervisor unless it is already running, a connection is open, or the app
   * is stopping. An open connection without a channel is reopening that channel; if the
   * reopen fails, the connection is closed and its close handler kicks the supervisor.
   */
  private kick(): void {
    if (this.shuttingDown || this.supervising || this.connection) return;
    this.supervising = this.supervise().finally(() => {
      this.supervising = null;
    });
  }

  private async supervise(): Promise<void> {
    let attempt = 0;
    while (!this.shuttingDown && !this.isConnected()) {
      try {
        await this.open();
        if (this.lostAt !== null) {
          this.logger.log(`broker reconnected after ${Math.round((Date.now() - this.lostAt) / 1000)}s`);
          this.lostAt = null;
        } else {
          this.logger.log(`connected to RabbitMQ as ${this.options.serviceName}`);
        }
        return;
      } catch (err) {
        attempt += 1;
        this.lostAt ??= Date.now();
        const delay = backoffMs(attempt);
        this.logger.warn(`RabbitMQ connect failed (attempt ${attempt}): ${errorText(err)}; retrying in ${delay} ms`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.wakeSupervisor = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wakeSupervisor = null;
      }
    }
  }

  /** One connection attempt: connect, listen, set up the main channel. A partly opened connection is closed. */
  private async open(): Promise<void> {
    const connection = await amqp.connect(this.url(), { timeout: 10_000 });
    connection.on('error', (err: Error) => this.logger.warn(`RabbitMQ connection error: ${err.message}`));
    connection.on('close', () => {
      if (this.connection !== connection) return;
      this.connection = null;
      this.channel = null;
      this.confirmChannel = null;
      if (this.shuttingDown) return;
      this.lostAt ??= Date.now();
      this.logger.warn('RabbitMQ connection closed; reconnecting…');
      this.kick();
    });
    this.connection = connection;
    try {
      await this.setUpChannel(connection);
    } catch (err) {
      this.connection = null;
      connection.close().catch(() => undefined);
      throw err;
    }
  }

  /** Opens the main channel, asserts the topology and starts the consumers. */
  private async setUpChannel(connection: amqp.ChannelModel): Promise<void> {
    const channel = await connection.createChannel();
    channel.on('error', (err: Error) => this.logger.warn(`RabbitMQ channel error: ${err.message}`));
    channel.on('close', () => {
      if (this.channel !== channel) return;
      this.channel = null;
      if (this.shuttingDown) return;
      // A closing connection closes its channels first, in the same tick: let its
      // handler run, and reopen only when the connection itself is still up.
      setImmediate(() => {
        if (this.shuttingDown || this.connection !== connection || this.channel) return;
        this.logger.warn('RabbitMQ channel closed; reopening it');
        this.setUpChannel(connection).catch((err) => {
          this.logger.warn(`reopening the channel failed: ${errorText(err)}; reconnecting`);
          connection.close().catch(() => undefined); // its close handler starts the supervisor
        });
      });
    });
    await channel.assertExchange(EVENTS_EXCHANGE, 'fanout', { durable: true });
    await channel.assertExchange(COMMANDS_EXCHANGE, 'direct', { durable: true });
    if (this.eventHandlers.size > 0 || this.commandHandlers.length > 0) await channel.prefetch(this.prefetch);

    const { serviceName } = this.options;
    if (this.eventHandlers.size > 0) {
      const queue = `${serviceName}.events`;
      // Exactly the original declaration: no arguments may ever be added to it.
      await channel.assertQueue(queue, { durable: true });
      await channel.assertQueue(this.retryQueue(), {
        durable: true,
        arguments: { 'x-message-ttl': this.retryDelayMs, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue },
      });
      await channel.assertQueue(`${queue}.parked`, { durable: true, arguments: { 'x-max-length': PARKED_MAX_LENGTH } });
      await channel.bindQueue(queue, EVENTS_EXCHANGE, '');
      await channel.consume(queue, (msg) => void this.onEvent(channel, msg));
      this.logger.log(`consuming events on ${queue} (${[...this.eventHandlers.keys()].join(', ')})`);
    }

    if (this.commandHandlers.length > 0) {
      const queue = `${serviceName}.commands`;
      await channel.assertQueue(queue, { durable: true });
      await channel.assertQueue(`${queue}.parked`, { durable: true, arguments: { 'x-max-length': PARKED_MAX_LENGTH } });
      await channel.bindQueue(queue, COMMANDS_EXCHANGE, serviceName);
      await channel.consume(queue, (msg) => void this.onCommand(channel, msg));
    }

    this.channel = channel;
    for (const resolve of [...this.channelWaiters]) resolve(channel);
  }

  /** The retry queue. Its TTL is in its name, so a changed delay declares a new queue instead of failing. */
  private retryQueue(): string {
    return `${this.options.serviceName}.events.retry.${Math.round(this.retryDelayMs / 1000)}s`;
  }

  private url(): string {
    const url = this.options.url ?? envOrLocalDefault('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672');
    if (/[?&]heartbeat=/.test(url)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}heartbeat=${this.heartbeatS}`;
  }

  // ---- publishing ----

  /** The main channel, waiting up to `ms` for the supervisor to (re)connect. */
  private waitForChannel(ms: number, label: string): Promise<amqp.Channel> {
    if (this.channel) return Promise.resolve(this.channel);
    this.kick();
    return new Promise((resolve, reject) => {
      const done = (channel: amqp.Channel) => {
        clearTimeout(timer);
        this.channelWaiters.delete(done);
        resolve(channel);
      };
      const timer = setTimeout(() => {
        this.channelWaiters.delete(done);
        reject(new BrokerPublishError(label, `broker unavailable for ${ms} ms`));
      }, ms);
      this.channelWaiters.add(done);
    });
  }

  private async publishPlain(label: string, exchange: string, routingKey: string, content: Buffer): Promise<void> {
    const deadline = Date.now() + this.publishWaitMs;
    const channel = await this.waitForChannel(this.publishWaitMs, label).catch((err) => {
      this.logger.warn(`publish failed: broker unavailable (${label})`);
      throw err;
    });
    let flushed: boolean;
    try {
      flushed = channel.publish(exchange, routingKey, content, { persistent: true, contentType: 'application/json' });
    } catch (err) {
      throw new BrokerPublishError(label, errorText(err));
    }
    // Backpressure: the write buffer is full. Wait for it to drain, within the same budget.
    if (!flushed) await waitForDrain(channel, Math.max(0, deadline - Date.now()), label);
  }

  private getConfirmChannel(label: string): Promise<amqp.ConfirmChannel> {
    if (this.confirmChannel) return Promise.resolve(this.confirmChannel);
    this.openingConfirmChannel ??= (async () => {
      try {
        await this.waitForChannel(this.publishWaitMs, label); // connected, exchanges asserted
        const channel = await this.connection!.createConfirmChannel();
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

  /** Publishes on the confirm channel and resolves once the broker acknowledges, or rejects with BrokerPublishError. */
  private async publishWithConfirm(
    label: string,
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: amqp.Options.Publish,
    timeoutMs: number,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrokerPublishError(label, `no acknowledgement within ${timeoutMs} ms`)), timeoutMs);
    });
    const delivery = (async () => {
      const channel = await this.getConfirmChannel(label);
      await new Promise<void>((resolve, reject) =>
        channel.publish(exchange, routingKey, content, { persistent: true, contentType: 'application/json', ...options }, (err) =>
          err ? reject(err) : resolve(),
        ),
      );
    })();
    delivery.catch(() => undefined); // a late failure after the timeout is already reported
    try {
      await Promise.race([delivery, timeout]);
    } catch (err) {
      if (err instanceof BrokerPublishError) throw err;
      throw new BrokerPublishError(label, errorText(err));
    } finally {
      clearTimeout(timer);
    }
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

  // ---- consuming ----

  /** Never throws: every delivery ends in an ack, a copy to the retry or parked queue then an ack, or a nack with requeue. */
  private async onEvent(channel: amqp.Channel, msg: amqp.ConsumeMessage | null): Promise<void> {
    if (!msg) return; // the broker cancelled the consumer
    try {
      const failures = Number(msg.properties.headers?.['x-attempts'] ?? 0) || 0;
      let envelope: EventEnvelope;
      try {
        envelope = JSON.parse(msg.content.toString()) as EventEnvelope;
        if (typeof envelope?.event_type !== 'string' || !envelope.metadata) throw new Error('not an event envelope');
      } catch (err) {
        this.logger.error(`event parked: unparseable message: ${errorText(err)}`);
        await this.republish(channel, msg, `${this.options.serviceName}.events.parked`, {
          'x-last-error': errorText(err),
          'x-failed-handler': 'parse',
        });
        return;
      }

      const { event_id, correlation_id } = envelope.metadata;
      for (const handler of this.eventHandlers.get(envelope.event_type) ?? []) {
        const context = { event_id, event_type: envelope.event_type, correlation_id, handler: handler.name };
        try {
          await eventContext.run(context, () => handler.fn(envelope.payload, envelope));
        } catch (err) {
          const attempts = failures + 1;
          if (attempts >= this.maxAttempts) {
            this.logger.error(
              `event parked: ${envelope.event_type} (${event_id}) handler ${handler.name} failed ${attempts} times: ${errorText(err)}`,
              (err as Error)?.stack,
            );
            await this.republish(channel, msg, `${this.options.serviceName}.events.parked`, {
              'x-attempts': attempts,
              'x-last-error': errorText(err),
              'x-failed-handler': handler.name,
            });
          } else {
            this.logger.warn(
              `event handler failed, retrying in ${Math.round(this.retryDelayMs / 1000)}s: ${envelope.event_type} (${event_id}) ` +
                `handler ${handler.name}, attempt ${attempts} of ${this.maxAttempts}: ${errorText(err)}`,
            );
            await this.republish(channel, msg, this.retryQueue(), { 'x-attempts': attempts });
          }
          return;
        }
      }
      this.ack(channel, msg);
    } catch (err) {
      this.logger.error(`event consumer failed: ${errorText(err)}`);
    }
  }

  private async onCommand(channel: amqp.Channel, msg: amqp.ConsumeMessage | null): Promise<void> {
    if (!msg) return;
    try {
      try {
        const message = JSON.parse(msg.content.toString());
        for (const handler of this.commandHandlers) await handler(message);
      } catch (err) {
        // Commands aren't retried: park it where an operator can see it.
        this.logger.error(`command parked: ${errorText(err)}`);
        await this.republish(channel, msg, `${this.options.serviceName}.commands.parked`, { 'x-last-error': errorText(err) });
        return;
      }
      this.ack(channel, msg);
    } catch (err) {
      this.logger.error(`command consumer failed: ${errorText(err)}`);
    }
  }

  /**
   * Copies the message to `queue` (through the default exchange) with extra headers, waits
   * for the broker's confirm, then acks the original on the channel that delivered it. If
   * the copy fails, the original is nacked with requeue, so nothing is lost.
   */
  private async republish(channel: amqp.Channel, msg: amqp.ConsumeMessage, queue: string, headers: Record<string, unknown>): Promise<void> {
    try {
      await this.publishWithConfirm(
        queue,
        '',
        queue,
        msg.content,
        { contentType: msg.properties.contentType ?? 'application/json', headers: { ...(msg.properties.headers ?? {}), ...headers } },
        this.publishWaitMs,
      );
    } catch (err) {
      this.logger.warn(`could not move a message to ${queue}, requeueing it: ${errorText(err)}`);
      try {
        channel.nack(msg, false, true);
      } catch (nackErr) {
        this.logger.warn(`nack failed (the broker redelivers the message): ${errorText(nackErr)}`);
      }
      return;
    }
    this.ack(channel, msg);
  }

  private ack(channel: amqp.Channel, msg: amqp.ConsumeMessage): void {
    try {
      channel.ack(msg);
    } catch (err) {
      this.logger.warn(`ack failed (the broker redelivers the message): ${errorText(err)}`);
    }
  }
}

/** 1 s doubling to 30 s, ±20 % jitter. */
function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 500);
}

function waitForDrain(channel: amqp.Channel, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (err?: Error) => {
      clearTimeout(timer);
      channel.removeListener('drain', onDrain);
      channel.removeListener('close', onClose);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => finish();
    const onClose = () => finish(new BrokerPublishError(label, 'channel closed before its buffer drained'));
    const timer = setTimeout(() => finish(new BrokerPublishError(label, `broker backpressure for ${ms} ms`)), ms);
    channel.once('drain', onDrain);
    channel.once('close', onClose);
  });
}
