import { createHmac } from 'crypto';
import { PaymentStatus } from '@ethiopialearn/contracts';
import { PaymentService } from './payment.service';

const SECRET = 'test-webhook-secret';

function sign(raw: Buffer): string {
  return createHmac('sha256', SECRET).update(raw).digest('hex');
}

interface Setup {
  service: PaymentService;
  payments: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock; find: jest.Mock; findAndCount: jest.Mock };
  chapa: { verify: jest.Mock; initialize: jest.Mock; generateTxRef: jest.Mock };
  bus: { publish: jest.Mock };
}

function setup(paymentRow: Record<string, unknown> | null): Setup {
  const payments = {
    findOne: jest.fn().mockResolvedValue(paymentRow),
    save: jest.fn(async (p: unknown) => p),
    create: jest.fn((p: unknown) => p),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const chapa = {
    verify: jest.fn(),
    initialize: jest.fn(),
    generateTxRef: jest.fn().mockResolvedValue('TX-TEST'),
  };
  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  const internal = { get: jest.fn().mockResolvedValue({ email: 'l@e.et', name: 'Learner' }) };
  const service = new PaymentService(payments as never, chapa as never, bus as never, internal as never);
  return { service, payments, chapa, bus };
}

function pendingPayment(): Record<string, unknown> {
  return {
    id: 'pay-1',
    learner_id: 'u1',
    course_id: 'c1',
    amount_etb: '500.00',
    status: PaymentStatus.PENDING,
    chapa_tx_ref: 'TX-TEST',
    payee_id: 'edu-1',
    payee_type: 'educator',
    course_title: 'Course',
  };
}

describe('PaymentService.handleWebhook', () => {
  beforeEach(() => {
    process.env.CHAPA_WEBHOOK_SECRET = SECRET;
  });

  const raw = Buffer.from(JSON.stringify({ tx_ref: 'TX-TEST', status: 'success' }));

  it('rejects a missing or wrong signature without touching the DB', async () => {
    const { service, payments } = setup(pendingPayment());
    expect(await service.handleWebhook(raw, undefined)).toEqual({ processed: false, reason: 'invalid signature' });
    expect(await service.handleWebhook(raw, 'a'.repeat(64))).toEqual({ processed: false, reason: 'invalid signature' });
    expect(payments.findOne).not.toHaveBeenCalled();
  });

  it('rejects a signed body whose payload was tampered with', async () => {
    const { service } = setup(pendingPayment());
    const tampered = Buffer.from(JSON.stringify({ tx_ref: 'TX-TEST', status: 'success', extra: 1 }));
    expect(await service.handleWebhook(tampered, sign(raw))).toEqual({ processed: false, reason: 'invalid signature' });
  });

  it('never trusts the webhook alone: verifies with Chapa, then confirms and publishes PaymentConfirmed', async () => {
    const { service, chapa, bus } = setup(pendingPayment());
    chapa.verify.mockResolvedValue({ status: 'success', amount: 500, currency: 'ETB' });

    const result = await service.handleWebhook(raw, sign(raw));

    expect(result).toEqual({ processed: true, reason: 'confirmed' });
    expect(chapa.verify).toHaveBeenCalledWith('TX-TEST');
    expect(bus.publish).toHaveBeenCalledWith('PaymentConfirmed', expect.objectContaining({ tx_ref: 'TX-TEST', amount_etb: 500 }));
  });

  it('refuses to confirm when the verified amount differs from the ledger (tamper guard)', async () => {
    const { service, chapa, bus } = setup(pendingPayment());
    chapa.verify.mockResolvedValue({ status: 'success', amount: 5, currency: 'ETB' });
    expect(await service.handleWebhook(raw, sign(raw))).toEqual({ processed: false, reason: 'amount mismatch' });
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('refuses to confirm a non-ETB verification', async () => {
    const { service, chapa } = setup(pendingPayment());
    chapa.verify.mockResolvedValue({ status: 'success', amount: 500, currency: 'USD' });
    expect(await service.handleWebhook(raw, sign(raw))).toEqual({ processed: false, reason: 'currency mismatch' });
  });

  it('is idempotent: a duplicate webhook on a confirmed tx_ref is a no-op', async () => {
    const { service, chapa, bus } = setup({ ...pendingPayment(), status: PaymentStatus.CONFIRMED });
    expect(await service.handleWebhook(raw, sign(raw))).toEqual({ processed: true, reason: 'duplicate — already confirmed' });
    expect(chapa.verify).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('ignores an unknown tx_ref', async () => {
    const { service } = setup(null);
    expect(await service.handleWebhook(raw, sign(raw))).toEqual({ processed: false, reason: 'unknown tx_ref' });
  });

  it('marks the payment failed on a signed failure webhook without granting anything', async () => {
    const { service, bus } = setup(pendingPayment());
    const failRaw = Buffer.from(JSON.stringify({ tx_ref: 'TX-TEST', status: 'failed' }));
    expect(await service.handleWebhook(failRaw, sign(failRaw))).toEqual({ processed: true, reason: 'failed' });
    expect(bus.publish).toHaveBeenCalledWith('PaymentFailed', expect.objectContaining({ tx_ref: 'TX-TEST' }));
    expect(bus.publish).not.toHaveBeenCalledWith('PaymentConfirmed', expect.anything());
  });
});

describe('PaymentService.sweepPendingPayments', () => {
  afterEach(() => {
    delete process.env.CHAPA_MODE;
  });

  it('confirms a pending payment Chapa reports as successful', async () => {
    process.env.CHAPA_MODE = 'live';
    const { service, payments, chapa, bus } = setup(pendingPayment());
    payments.find.mockResolvedValue([pendingPayment()]);
    chapa.verify.mockResolvedValue({ status: 'success', amount: 500, currency: 'ETB' });

    await service.sweepPendingPayments();

    expect(chapa.verify).toHaveBeenCalledWith('TX-TEST');
    expect(bus.publish).toHaveBeenCalledWith('PaymentConfirmed', expect.objectContaining({ tx_ref: 'TX-TEST' }));
  });

  it('leaves a still-pending payment untouched', async () => {
    process.env.CHAPA_MODE = 'live';
    const { service, payments, chapa, bus } = setup(pendingPayment());
    payments.find.mockResolvedValue([pendingPayment()]);
    chapa.verify.mockResolvedValue({ status: 'pending', amount: null, currency: null });

    await service.sweepPendingPayments();

    expect(payments.save).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('does nothing in mock mode', async () => {
    process.env.CHAPA_MODE = 'mock';
    const { service, payments } = setup(pendingPayment());
    await service.sweepPendingPayments();
    expect(payments.find).not.toHaveBeenCalled();
  });
});
