import { UnauthorizedException } from '@nestjs/common';
import { FinancialController } from './controllers';

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
