import * as amqp from 'amqplib';
import { EventEmitter } from 'events';
import { BrokerPublishError, EVENTS_EXCHANGE, EventBusService } from './event-bus.service';
import { currentEvent, EventContext } from './event-context';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

type PublishCallback = (err: unknown) => void;
interface Published {
  exchange: string;
  key: string;
  body: string;
  headers: Record<string, unknown>;
}

/** An amqplib channel: records what it is asked to do, and closes the way RabbitMQ closes one. */
class FakeChannel extends EventEmitter {
  closed = false;
  readonly consumers = new Map<string, (msg: amqp.ConsumeMessage | null) => void>();
  readonly assertExchange = jest.fn(async () => undefined);
  readonly assertQueue = jest.fn(async (queue: string, opts: unknown) => {
    this.broker.queues[queue] = opts;
  });
  readonly bindQueue = jest.fn(async () => undefined);
  readonly prefetch = jest.fn(async () => undefined);
  readonly consume = jest.fn(async (queue: string, cb: (msg: amqp.ConsumeMessage | null) => void) => {
    this.consumers.set(queue, cb);
  });
  readonly publish = jest.fn((exchange: string, key: string, content: Buffer, opts: amqp.Options.Publish, cb?: PublishCallback) => {
    if (this.closed) throw new Error('Channel closed');
    this.broker.published.push({ exchange, key, body: content.toString(), headers: (opts?.headers ?? {}) as Record<string, unknown> });
    if (cb) {
      const reply = this.broker.confirmReply;
      if (reply === 'ack') setImmediate(() => cb(null));
      if (reply === 'nack') setImmediate(() => cb(new Error('nacked')));
      if (reply === 'late-nack') setTimeout(() => cb(new Error('nacked late')), 30);
    }
    return true;
  });
  readonly ack = jest.fn(() => {
    if (this.closed) throw new Error('Channel closed');
  });
  readonly nack = jest.fn(() => {
    if (this.closed) throw new Error('Channel closed');
  });
  readonly close = jest.fn(async () => this.die());

  constructor(private readonly broker: FakeBroker) {
    super();
  }

  /** The broker closed this channel (a channel-level error, or its connection went). */
  die(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

/** An amqplib ChannelModel. `drop()` closes its channels first, then itself, in one tick, as amqplib does. */
class FakeConnection extends EventEmitter {
  readonly mainChannels: FakeChannel[] = [];
  readonly confirmChannels: FakeChannel[] = [];
  readonly createChannel = jest.fn(async () => {
    const channel = new FakeChannel(this.broker);
    this.mainChannels.push(channel);
    return channel;
  });
  readonly createConfirmChannel = jest.fn(async () => {
    const channel = new FakeChannel(this.broker);
    this.confirmChannels.push(channel);
    return channel;
  });
  readonly close = jest.fn(async () => this.drop());

  constructor(private readonly broker: FakeBroker) {
    super();
  }

  drop(): void {
    [...this.mainChannels, ...this.confirmChannels].forEach((c) => c.die());
    this.emit('close');
  }
}

class FakeBroker {
  failConnects = 0;
  confirmReply: 'ack' | 'nack' | 'silent' | 'late-nack' = 'ack';
  readonly published: Published[] = [];
  readonly queues: Record<string, unknown> = {};
  readonly connections: FakeConnection[] = [];
  connectCalls = 0;

  constructor() {
    (amqp.connect as jest.Mock).mockImplementation(async () => {
      this.connectCalls += 1;
      if (this.failConnects > 0) {
        this.failConnects -= 1;
        throw new Error('connect ECONNREFUSED');
      }
      const connection = new FakeConnection(this);
      this.connections.push(connection);
      return connection;
    });
  }

  get connection(): FakeConnection {
    return this.connections[this.connections.length - 1];
  }

  get channel(): FakeChannel {
    return this.connection.mainChannels[this.connection.mainChannels.length - 1];
  }

  /** Delivers a message to `queue` on the current main channel, as the broker would. */
  deliver(queue: string, body: unknown, headers: Record<string, unknown> = {}): amqp.ConsumeMessage {
    const msg = {
      content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
      fields: { deliveryTag: 1 },
      properties: { headers, contentType: 'application/json' },
    } as unknown as amqp.ConsumeMessage;
    this.channel.consumers.get(queue)!(msg);
    return msg;
  }

  sentTo(queue: string): Published[] {
    return this.published.filter((p) => p.exchange === '' && p.key === queue);
  }
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

const envelope = (type = 'CourseCompleted') => ({
  event_type: type,
  payload: { course_id: 'c1' },
  metadata: { event_id: 'evt-1', timestamp: '2026-10-03T00:00:00Z', producer_service: 'enrollment', correlation_id: 'corr-1' },
});

let bus: EventBusService;
afterEach(async () => {
  await bus?.onApplicationShutdown();
  jest.useRealTimers();
  delete process.env.EVENT_PUBLISH_WAIT_MS;
});

async function started(): Promise<void> {
  await bus.onApplicationBootstrap();
  await until(() => bus.isConnected(), 'the bus to connect');
}

describe('EventBusService.publishConfirmed', () => {
  beforeEach(() => {
    bus = new EventBusService({ serviceName: 'financial', url: 'amqp://fake' });
  });

  it('resolves once the broker acknowledges the event, and carries the correlation id', async () => {
    const broker = new FakeBroker();
    await bus.publishConfirmed('PaymentConfirmed', { payment_id: 'pay-1' }, { correlationId: 'pay-1' });

    expect(broker.published).toHaveLength(1);
    expect(broker.published[0].exchange).toBe(EVENTS_EXCHANGE);
    expect(JSON.parse(broker.published[0].body)).toMatchObject({
      event_type: 'PaymentConfirmed',
      payload: { payment_id: 'pay-1' },
      metadata: { producer_service: 'financial', correlation_id: 'pay-1' },
    });
  });

  it('keeps a given event id, so a re-sent event is the same event to its consumers', async () => {
    const broker = new FakeBroker();
    const eventId = '6f1b2a43-9a0e-4c2d-8f53-2b1f6a9e7c10';
    await bus.publishConfirmed('PaymentConfirmed', {}, { eventId });
    await bus.publishConfirmed('PaymentConfirmed', {}, { eventId });

    expect(broker.published.map((p) => JSON.parse(p.body).metadata.event_id)).toEqual([eventId, eventId]);
  });

  it('rejects with a BrokerPublishError when the broker refuses the event', async () => {
    const broker = new FakeBroker();
    broker.confirmReply = 'nack';
    await expect(bus.publishConfirmed('PaymentConfirmed', {}, {})).rejects.toBeInstanceOf(BrokerPublishError);
  });

  it('rejects with a BrokerPublishError when no acknowledgement arrives in time', async () => {
    const broker = new FakeBroker();
    broker.confirmReply = 'silent';
    await expect(bus.publishConfirmed('PaymentConfirmed', {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(BrokerPublishError);
  });

  it('times out instead of waiting for a broker that cannot be reached', async () => {
    (amqp.connect as jest.Mock).mockReturnValue(new Promise(() => undefined));
    await expect(bus.publishConfirmed('PaymentConfirmed', {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(BrokerPublishError);
  });

  it('a confirm that fails after the timeout is not an unhandled rejection', async () => {
    const broker = new FakeBroker();
    broker.confirmReply = 'late-nack';
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(bus.publishConfirmed('PaymentConfirmed', {}, { timeoutMs: 5 })).rejects.toBeInstanceOf(BrokerPublishError);
      await new Promise((r) => setTimeout(r, 60)); // the late nack lands
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('reuses one confirm channel, and opens a new one after the connection closes', async () => {
    const broker = new FakeBroker();
    await bus.publishConfirmed('PaymentConfirmed', {}, {});
    await bus.publishConfirmed('PaymentConfirmed', {}, {});
    expect(broker.connection.createConfirmChannel).toHaveBeenCalledTimes(1);

    broker.connection.drop();
    await bus.publishConfirmed('PaymentConfirmed', {}, {});
    expect(broker.connections).toHaveLength(2);
    expect(broker.connection.createConfirmChannel).toHaveBeenCalledTimes(1);
  });

  it('leaves the plain publish path alone', async () => {
    const broker = new FakeBroker();
    await bus.publish('WalletCredited', { user_id: 'u1' });
    expect(broker.connection.createConfirmChannel).not.toHaveBeenCalled();
  });
});

describe('EventBusService connection supervisor (P1-15)', () => {
  beforeEach(() => {
    bus = new EventBusService({ serviceName: 'quality', url: 'amqp://fake' });
  });

  it('keeps trying after 70 failed connects, then connects and consumes', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const broker = new FakeBroker();
    broker.failConnects = 70;
    bus.subscribe('CourseCompleted', jest.fn());
    await bus.onApplicationBootstrap();
    for (let i = 0; i < 100 && !bus.isConnected(); i += 1) await jest.advanceTimersByTimeAsync(40_000);

    expect(broker.connectCalls).toBe(71);
    expect(bus.isConnected()).toBe(true);
    expect(broker.channel.consumers.has('quality.events')).toBe(true);
  });

  it('asks for a heartbeat unless the URL sets one', async () => {
    new FakeBroker();
    bus = new EventBusService({ serviceName: 'quality', url: 'amqp://fake/vhost' });
    await started();
    expect((amqp.connect as jest.Mock).mock.calls[0][0]).toBe('amqp://fake/vhost?heartbeat=30');

    await bus.onApplicationShutdown();
    bus = new EventBusService({ serviceName: 'quality', url: 'amqp://fake/vhost?heartbeat=10' });
    await started();
    expect((amqp.connect as jest.Mock).mock.calls[1][0]).toBe('amqp://fake/vhost?heartbeat=10');
  });

  it('reconnects after the connection closes, and starts consuming again', async () => {
    const broker = new FakeBroker();
    const handler = jest.fn();
    bus.subscribe('CourseCompleted', handler);
    await started();

    broker.connection.drop();
    expect(bus.isConnected()).toBe(false);
    await until(() => bus.isConnected(), 'the reconnect');
    expect(broker.connections).toHaveLength(2);

    broker.deliver('quality.events', envelope());
    await until(() => handler.mock.calls.length === 1, 'the handler');
  });

  it('reopens a channel the broker closed on its own, on the same connection', async () => {
    const broker = new FakeBroker();
    const handler = jest.fn();
    bus.subscribe('CourseCompleted', handler);
    await started();
    const first = broker.channel;

    first.die(); // e.g. PRECONDITION_FAILED
    expect(bus.isConnected()).toBe(false);
    await until(() => bus.isConnected(), 'the reopened channel');

    expect(broker.connections).toHaveLength(1);
    expect(broker.channel).not.toBe(first);
    broker.deliver('quality.events', envelope());
    await until(() => handler.mock.calls.length === 1, 'the handler');
    await bus.publish('CourseCompleted', {});
    expect(broker.published.filter((p) => p.exchange === EVENTS_EXCHANGE)).toHaveLength(1);
  });

  it('a publish while a closed channel is being reopened waits for it, and opens no second connection', async () => {
    const broker = new FakeBroker();
    bus.subscribe('CourseCompleted', jest.fn());
    await started();

    broker.channel.die(); // the connection stays up, e.g. consumer_timeout
    await bus.publish('CourseCompleted', {});

    expect(broker.connections).toHaveLength(1);
    expect(broker.connection.mainChannels).toHaveLength(2);
    expect(bus.isConnected()).toBe(true);
    expect(broker.published.filter((p) => p.exchange === EVENTS_EXCHANGE)).toHaveLength(1);
  });

  it('acks on the channel that delivered the message, even after a new channel opened', async () => {
    const broker = new FakeBroker();
    let release: (() => void) | undefined;
    bus.subscribe('CourseCompleted', () => new Promise<void>((r) => (release = r)));
    await started();
    const delivering = broker.channel;
    broker.deliver('quality.events', envelope());
    await until(() => release !== undefined, 'the handler to start');

    delivering.die();
    await until(() => bus.isConnected(), 'the reopened channel');
    release!();
    await until(() => delivering.ack.mock.calls.length === 1, 'the ack');

    expect(broker.channel.ack).not.toHaveBeenCalled(); // an unknown delivery tag there would close it
    expect(bus.isConnected()).toBe(true); // the throwing ack on the dead channel was swallowed
  });

  it('a connection or channel error event does not throw', async () => {
    const broker = new FakeBroker();
    await started();
    expect(() => broker.connection.emit('error', new Error('heartbeat timeout'))).not.toThrow();
    expect(() => broker.channel.emit('error', new Error('PRECONDITION_FAILED'))).not.toThrow();
  });

  it('publish fails fast with BrokerPublishError while the broker is down', async () => {
    process.env.EVENT_PUBLISH_WAIT_MS = '50';
    const broker = new FakeBroker();
    broker.failConnects = Number.MAX_SAFE_INTEGER;
    bus = new EventBusService({ serviceName: 'course', url: 'amqp://fake' });
    const startedAt = Date.now();
    await expect(bus.publish('CourseCompleted', {})).rejects.toBeInstanceOf(BrokerPublishError);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe('EventBusService consumers (P1-16)', () => {
  beforeEach(() => {
    bus = new EventBusService({ serviceName: 'quality', url: 'amqp://fake' });
  });

  it('declares the main queue exactly as before, next to a retry and a parked queue, with prefetch', async () => {
    const broker = new FakeBroker();
    bus.subscribe('CourseCompleted', jest.fn());
    await started();

    expect(broker.queues['quality.events']).toEqual({ durable: true });
    expect(broker.queues['quality.events.retry.60s']).toEqual({
      durable: true,
      arguments: { 'x-message-ttl': 60000, 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'quality.events' },
    });
    expect(broker.queues['quality.events.parked']).toEqual({ durable: true, arguments: { 'x-max-length': 10000 } });
    expect(broker.channel.prefetch).toHaveBeenCalledWith(4);
  });

  it('a retry delay that is not whole seconds is rounded, so the queue name and its TTL always agree', async () => {
    process.env.EVENT_RETRY_DELAY_MS = '60400';
    try {
      bus = new EventBusService({ serviceName: 'quality', url: 'amqp://fake' });
    } finally {
      delete process.env.EVENT_RETRY_DELAY_MS;
    }
    const broker = new FakeBroker();
    bus.subscribe('CourseCompleted', jest.fn());
    await started();

    expect(broker.queues['quality.events.retry.60s']).toMatchObject({ arguments: { 'x-message-ttl': 60000 } });
  });

  it('a throwing handler: copies the message to the retry queue with x-attempts 1, then acks it', async () => {
    const broker = new FakeBroker();
    bus.subscribe('CourseCompleted', () => {
      throw new Error('db down');
    });
    await started();
    const msg = broker.deliver('quality.events', envelope());
    await until(() => broker.channel.ack.mock.calls.length === 1, 'the ack');

    const retried = broker.sentTo('quality.events.retry.60s');
    expect(retried).toHaveLength(1);
    expect(retried[0].headers).toEqual({ 'x-attempts': 1 });
    expect(retried[0].body).toBe(msg.content.toString());
    expect(broker.channel.ack).toHaveBeenCalledWith(msg);
  });

  it('parks the message, with the error and the handler, when the last attempt fails', async () => {
    const broker = new FakeBroker();
    bus.subscribe(
      'CourseCompleted',
      () => {
        throw new Error('still failing');
      },
      { name: 'quality:stats' },
    );
    await started();
    broker.deliver('quality.events', envelope(), { 'x-attempts': 4 });
    await until(() => broker.channel.ack.mock.calls.length === 1, 'the ack');

    expect(broker.sentTo('quality.events.retry.60s')).toHaveLength(0);
    expect(broker.sentTo('quality.events.parked')[0].headers).toEqual({
      'x-attempts': 5,
      'x-last-error': 'still failing',
      'x-failed-handler': 'quality:stats',
    });
  });

  it('parks an unparseable message at once', async () => {
    const broker = new FakeBroker();
    bus.subscribe('CourseCompleted', jest.fn());
    await started();
    broker.deliver('quality.events', 'not json{');
    await until(() => broker.channel.ack.mock.calls.length === 1, 'the ack');
    expect(broker.sentTo('quality.events.parked')[0].headers).toMatchObject({ 'x-failed-handler': 'parse' });
  });

  it('nacks with requeue when the retry copy cannot be published', async () => {
    const broker = new FakeBroker();
    broker.confirmReply = 'nack';
    bus.subscribe('CourseCompleted', () => {
      throw new Error('db down');
    });
    await started();
    const msg = broker.deliver('quality.events', envelope());
    await until(() => broker.channel.nack.mock.calls.length === 1, 'the nack');
    expect(broker.channel.nack).toHaveBeenCalledWith(msg, false, true);
    expect(broker.channel.ack).not.toHaveBeenCalled();
  });

  it('acks a handled message, and runs each handler with its event in context', async () => {
    const broker = new FakeBroker();
    const seen: (EventContext | undefined)[] = [];
    bus.subscribe('CourseCompleted', async () => {
      await tick();
      seen.push(currentEvent());
    });
    bus.subscribe('CourseCompleted', () => void seen.push(currentEvent()), { name: 'quality:tier' });
    await started();
    broker.deliver('quality.events', envelope());
    await until(() => broker.channel.ack.mock.calls.length === 1, 'the ack');

    expect(seen).toEqual([
      { event_id: 'evt-1', event_type: 'CourseCompleted', correlation_id: 'corr-1', handler: 'quality:CourseCompleted:0' },
      { event_id: 'evt-1', event_type: 'CourseCompleted', correlation_id: 'corr-1', handler: 'quality:tier' },
    ]);
    expect(currentEvent()).toBeUndefined();
  });

  it('parks a failing command, without a retry', async () => {
    const broker = new FakeBroker();
    bus = new EventBusService({ serviceName: 'financial', url: 'amqp://fake' });
    bus.subscribeCommands(() => {
      throw new Error('payout run failed');
    });
    await started();
    expect(broker.queues['financial.commands.parked']).toEqual({ durable: true, arguments: { 'x-max-length': 10000 } });
    broker.deliver('financial.commands', { command: 'run_payouts' });
    await until(() => broker.channel.ack.mock.calls.length === 1, 'the ack');
    expect(broker.sentTo('financial.commands.parked')[0].headers).toEqual({ 'x-last-error': 'payout run failed' });
  });
});
