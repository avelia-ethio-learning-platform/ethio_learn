import { UnauthorizedException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BankTransferDto, FinancialController } from './controllers';

describe('FinancialController webhook', () => {
  const raw = Buffer.from('{"tx_ref":"TX-1","status":"success"}');
  const controller = (reason: string) => {
    const payments = { handleWebhook: jest.fn().mockResolvedValue({ processed: reason === 'confirmed', reason }) };
    return { payments, controller: new FinancialController(payments as never, {} as never, {} as never) };
  };

  it('passes the raw body and every header to the service, and answers 200 for a signed webhook', async () => {
    const { payments, controller: c } = controller('duplicate — already confirmed');
    const headers = { 'x-chapa-signature': 'abc', 'chapa-signature': 'def' };
    await expect(c.webhook({ rawBody: raw, headers } as never)).resolves.toEqual({ received: true });
    expect(payments.handleWebhook).toHaveBeenCalledWith(raw, headers);
  });

  it('answers 401 for a missing or invalid x-chapa-signature', async () => {
    const { controller: c } = controller('invalid signature');
    await expect(c.webhook({ rawBody: raw, headers: {} } as never)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('treats a request without a body as unsigned', async () => {
    const { payments, controller: c } = controller('invalid signature');
    await expect(c.webhook({ headers: {} } as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(payments.handleWebhook).toHaveBeenCalledWith(Buffer.alloc(0), {});
  });
});

describe('FinancialController bank transfer', () => {
  const dto = { learner_id: 'u1', course_id: 'c1', bank_reference: 'FT-001' };
  const controller = (created: boolean) => {
    const payment = { id: 'pay-1' };
    const payments = { recordBankTransfer: jest.fn().mockResolvedValue({ payment, created }) };
    const res = { status: jest.fn() };
    return { payment, payments, res, controller: new FinancialController(payments as never, {} as never, {} as never) };
  };

  it('answers 201 with the payment for a new transfer', async () => {
    const t = controller(true);
    await expect(t.controller.bankTransfer({ id: 'adm' } as never, dto as never, t.res as never)).resolves.toEqual({ ...t.payment, replayed: false });
    expect(t.payments.recordBankTransfer).toHaveBeenCalledWith('adm', dto);
    expect(t.res.status).toHaveBeenCalledWith(201);
  });

  it('answers 200 with the existing payment on an exact replay', async () => {
    const t = controller(false);
    await expect(t.controller.bankTransfer({ id: 'adm' } as never, dto as never, t.res as never)).resolves.toEqual({ ...t.payment, replayed: true });
    expect(t.res.status).toHaveBeenCalledWith(200);
  });
});

describe('BankTransferDto', () => {
  const LEARNER = '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d';
  const COURSE = '7a1c9e2b-4d6f-4a8b-9c0d-1e2f3a4b5c6d';
  const parse = (body: Record<string, unknown>) => plainToInstance(BankTransferDto, { learner_id: LEARNER, course_id: COURSE, ...body });
  const errorsFor = async (body: Record<string, unknown>) => (await validate(parse(body), { whitelist: true })).map((e) => e.property);

  it('trims and upper-cases the bank reference', async () => {
    const dto = parse({ bank_reference: '  ft24/ab_9-x ' });
    expect(dto.bank_reference).toBe('FT24/AB_9-X');
    expect(await validate(dto, { whitelist: true })).toEqual([]);
  });

  it.each(['ABC', 'A'.repeat(64), 'FT24123ABC', '0-_/'])('accepts %p', async (bank_reference) => {
    expect(await errorsFor({ bank_reference })).toEqual([]);
  });

  it.each([undefined, null, '', '   ', 'AB', ' ab ', 'A'.repeat(65), 'FT 123', 'FT.123', 'FT#1', 'ፊደል1234', 123456])('rejects %p', async (bank_reference) => {
    expect(await errorsFor({ bank_reference })).toEqual(['bank_reference']);
  });

  it('requires all three fields', async () => {
    expect((await validate(plainToInstance(BankTransferDto, {}), { whitelist: true })).map((e) => e.property)).toEqual(['learner_id', 'course_id', 'bank_reference']);
  });
});
