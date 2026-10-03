import { BadRequestException } from '@nestjs/common';
import { ChapaInitializeOptions, ChapaUnavailableError, LiveChapaProvider } from './chapa.provider';

const KEY = 'CHASECK_TEST-fake';
const OPTIONS: ChapaInitializeOptions = {
  first_name: 'Abebe',
  last_name: 'Kebede',
  email: 'abebe@example.com',
  currency: 'ETB',
  amount: '500.00',
  tx_ref: 'TX-ABC123',
  return_url: 'https://web.example/payment/return',
  customization: { title: 'EthiopiaLearn', description: 'Course' },
};

const reply = (status: number, body: unknown) => ({ status, json: async () => body }) as Response;

let fetchMock: jest.Mock;
const realFetch = global.fetch;
const savedEnv = { key: process.env.CHAPA_SECRET_KEY, timeout: process.env.CHAPA_TIMEOUT_MS };

beforeEach(() => {
  process.env.CHAPA_SECRET_KEY = KEY;
  delete process.env.CHAPA_TIMEOUT_MS;
  fetchMock = jest.fn();
  global.fetch = fetchMock as never;
});
afterEach(() => {
  global.fetch = realFetch;
  for (const [k, v] of [['CHAPA_SECRET_KEY', savedEnv.key], ['CHAPA_TIMEOUT_MS', savedEnv.timeout]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('LiveChapaProvider.initialize', () => {
  it('sends the documented request and returns the checkout url', async () => {
    fetchMock.mockResolvedValue(reply(200, { status: 'success', message: 'Hosted Link', data: { checkout_url: 'https://checkout.chapa.co/x' } }));
    await expect(new LiveChapaProvider().initialize(OPTIONS)).resolves.toEqual({ checkout_url: 'https://checkout.chapa.co/x' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.chapa.co/v1/transaction/initialize');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual(OPTIONS);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('turns a Chapa 4xx into a BadRequest that keeps the validation text', async () => {
    fetchMock.mockResolvedValue(reply(400, { message: { email: ['validation.email'] }, status: 'failed' }));
    const err = await new LiveChapaProvider().initialize(OPTIONS).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/validation\.email/);
    expect(err.message).toContain('Payment gateway rejected the request: {"email":["validation.email"]}');
  });

  it('quotes a plain string message', async () => {
    fetchMock.mockResolvedValue(reply(400, { message: 'Invalid amount', status: 'failed' }));
    await expect(new LiveChapaProvider().initialize(OPTIONS)).rejects.toThrow('Payment gateway rejected the request: "Invalid amount"');
  });

  it('reports a timeout as unavailable', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    await expect(new LiveChapaProvider().initialize(OPTIONS)).rejects.toBeInstanceOf(ChapaUnavailableError);
  });

  it('reports a 502 as unavailable', async () => {
    fetchMock.mockResolvedValue(reply(502, null));
    const err = await new LiveChapaProvider().initialize(OPTIONS).catch((e) => e);
    expect(err).toBeInstanceOf(ChapaUnavailableError);
    expect(err.message).toBe('The payment provider is not responding. Try again in a minute.');
  });

  it('keeps the generic error for a 2xx without a checkout url', async () => {
    fetchMock.mockResolvedValue(reply(200, { status: 'failed', message: 'nope' }));
    await expect(new LiveChapaProvider().initialize(OPTIONS)).rejects.toThrow('Chapa could not start this checkout. Please try again.');
  });

  it('honours CHAPA_TIMEOUT_MS', async () => {
    process.env.CHAPA_TIMEOUT_MS = '5';
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))));
    await expect(new LiveChapaProvider().initialize(OPTIONS)).rejects.toBeInstanceOf(ChapaUnavailableError);
  });
});

describe('LiveChapaProvider.verify', () => {
  const verified = (status: string, extra: object = {}) => reply(200, { status: 'success', message: 'ok', data: { status, ...extra } });

  it('sends the documented request', async () => {
    fetchMock.mockResolvedValue(verified('success', { amount: 500, currency: 'ETB' }));
    await new LiveChapaProvider().verify('TX-ABC123');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.chapa.co/v1/transaction/verify/TX-ABC123');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps responses', async () => {
    const p = new LiveChapaProvider();
    fetchMock.mockResolvedValueOnce(verified('success', { amount: '500.00', currency: 'ETB' }));
    await expect(p.verify('TX-1')).resolves.toEqual({ status: 'success', amount: 500, currency: 'ETB' });
    fetchMock.mockResolvedValueOnce(verified('failed/cancelled', { amount: 500, currency: 'ETB' }));
    await expect(p.verify('TX-1')).resolves.toMatchObject({ status: 'failed' });
    fetchMock.mockResolvedValueOnce(verified('pending'));
    await expect(p.verify('TX-1')).resolves.toEqual({ status: 'pending', amount: null, currency: null });
    fetchMock.mockResolvedValueOnce(reply(200, { status: 'success', message: 'ok' }));
    await expect(p.verify('TX-1')).resolves.toEqual({ status: 'pending', amount: null, currency: null });
  });

  it('treats a 401 or 403 as unavailable and logs the key problem without the key', async () => {
    const errorLog = jest.spyOn(require('@nestjs/common').Logger.prototype, 'error').mockImplementation(() => undefined);
    for (const code of [401, 403]) {
      fetchMock.mockResolvedValueOnce(reply(code, { message: 'Invalid API Key' }));
      await expect(new LiveChapaProvider().verify('TX-1')).rejects.toBeInstanceOf(ChapaUnavailableError);
    }
    expect(errorLog).toHaveBeenCalledWith('chapa verify rejected the API key (401/403): check CHAPA_SECRET_KEY');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(KEY);
    errorLog.mockRestore();
  });

  it('treats any other 4xx as pending', async () => {
    fetchMock.mockResolvedValue(reply(404, { message: 'Transaction not found' }));
    await expect(new LiveChapaProvider().verify('TX-1')).resolves.toEqual({ status: 'pending', amount: null, currency: null });
  });

  it('treats a timeout, a network error and a 500 as unavailable', async () => {
    const p = new LiveChapaProvider();
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    await expect(p.verify('TX-1')).rejects.toBeInstanceOf(ChapaUnavailableError);
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(p.verify('TX-1')).rejects.toBeInstanceOf(ChapaUnavailableError);
    fetchMock.mockResolvedValueOnce(reply(500, null));
    await expect(p.verify('TX-1')).rejects.toBeInstanceOf(ChapaUnavailableError);
  });
});

describe('LiveChapaProvider.generateTxRef', () => {
  it('generates a TX- reference locally', async () => {
    await expect(new LiveChapaProvider().generateTxRef()).resolves.toMatch(/^TX-[A-Z0-9]{15}$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
