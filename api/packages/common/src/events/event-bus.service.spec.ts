import * as amqp from 'amqplib';
import { BrokerPublishError, EVENTS_EXCHANGE, EventBusService } from './event-bus.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

type PublishCallback = (err: unknown) => void;

/** A fake broker connection whose confirm channel acks, nacks or stays silent, as the test says. */
function fakeBroker() {
  const state = { reply: 'ack' as 'ack' | 'nack' | 'silent', confirmChannels: 0 };
  const listeners: Record<string, (() => void)[]> = {};
  const published: { exchange: string; body: any }[] = [];
  const plainChannel = {
    assertExchange: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn(),
  };
  const connection = {
    on: jest.fn((event: string, fn: () => void) => (listeners[event] ??= []).push(fn)),
    createChannel: jest.fn().mockResolvedValue(plainChannel),
    createConfirmChannel: jest.fn(async () => {
      state.confirmChannels += 1;
      return {
        on: jest.fn(),
        publish: jest.fn((exchange: string, _key: string, content: Buffer, _opts: unknown, cb: PublishCallback) => {
          published.push({ exchange, body: JSON.parse(content.toString()) });
          if (state.reply === 'ack') setImmediate(() => cb(null));
          if (state.reply === 'nack') setImmediate(() => cb(new Error('nacked')));
          return true;
        }),
      };
    }),
  };
  (amqp.connect as jest.Mock).mockResolvedValue(connection);
  const close = () => (listeners.close ?? []).forEach((fn) => fn());
  return { state, published, connection, close };
}

describe('EventBusService.publishConfirmed', () => {
  let bus: EventBusService;

  beforeEach(() => {
    bus = new EventBusService({ serviceName: 'financial', url: 'amqp://fake' });
  });

  afterEach(async () => {
    await bus.onApplicationShutdown();
  });

  it('resolves once the broker acknowledges the event, and carries the correlation id', async () => {
    const broker = fakeBroker();
    await bus.publishConfirmed('PaymentConfirmed', { payment_id: 'pay-1' }, { correlationId: 'pay-1' });

    expect(broker.published).toHaveLength(1);
    expect(broker.published[0].exchange).toBe(EVENTS_EXCHANGE);
    expect(broker.published[0].body).toMatchObject({
      event_type: 'PaymentConfirmed',
      payload: { payment_id: 'pay-1' },
      metadata: { producer_service: 'financial', correlation_id: 'pay-1' },
    });
  });

  it('rejects with a BrokerPublishError when the broker refuses the event', async () => {
    const broker = fakeBroker();
    broker.state.reply = 'nack';
    await expect(bus.publishConfirmed('PaymentConfirmed', {}, {})).rejects.toBeInstanceOf(BrokerPublishError);
  });

  it('rejects with a BrokerPublishError when no acknowledgement arrives in time', async () => {
    const broker = fakeBroker();
    broker.state.reply = 'silent';
    await expect(bus.publishConfirmed('PaymentConfirmed', {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(BrokerPublishError);
  });

  it('times out instead of waiting for a broker that cannot be reached', async () => {
    (amqp.connect as jest.Mock).mockReturnValue(new Promise(() => undefined));
    await expect(bus.publishConfirmed('PaymentConfirmed', {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(BrokerPublishError);
  });

  it('reuses one confirm channel, and opens a new one after the connection closes', async () => {
    const broker = fakeBroker();
    await bus.publishConfirmed('PaymentConfirmed', {}, {});
    await bus.publishConfirmed('PaymentConfirmed', {}, {});
    expect(broker.state.confirmChannels).toBe(1);

    jest.useFakeTimers();
    broker.close(); // the bus schedules its own reconnect; keep it from running
    jest.useRealTimers();
    await bus.publishConfirmed('PaymentConfirmed', {}, {});
    expect(broker.state.confirmChannels).toBe(2);
  });

  it('leaves the plain publish path alone', async () => {
    const broker = fakeBroker();
    await bus.publish('WalletCredited', { user_id: 'u1' });
    expect(broker.connection.createConfirmChannel).not.toHaveBeenCalled();
  });
});
