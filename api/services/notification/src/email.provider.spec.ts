import { BrevoApiEmailProvider, emailProviderClass, parseAddress, SmtpEmailProvider, ConsoleEmailProvider, ResendEmailProvider } from './email.provider';
import { NotificationController } from './controllers';

const ENV_KEYS = ['BREVO_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_FALLBACK_PORT', 'SMTP_SECURE', 'RESEND_API_KEY', 'EMAIL_FROM'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => ENV_KEYS.forEach((k) => ((saved[k] = process.env[k]), delete process.env[k])));
afterEach(() => {
  ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  jest.restoreAllMocks();
});

describe('parseAddress', () => {
  it('splits "Name <email>" and keeps bare addresses', () => {
    expect(parseAddress('EthiopiaLearn <a@b.et>')).toEqual({ name: 'EthiopiaLearn', email: 'a@b.et' });
    expect(parseAddress('"Ethiopia Learn" <a@b.et>')).toEqual({ name: 'Ethiopia Learn', email: 'a@b.et' });
    expect(parseAddress('a@b.et')).toEqual({ email: 'a@b.et' });
  });
});

describe('emailProviderClass', () => {
  it('prefers the Brevo HTTPS API, then SMTP, then Resend, then the console', () => {
    expect(emailProviderClass()).toBe(ConsoleEmailProvider);
    process.env.RESEND_API_KEY = 'k';
    expect(emailProviderClass()).toBe(ResendEmailProvider);
    process.env.SMTP_HOST = 'smtp-relay.brevo.com';
    expect(emailProviderClass()).toBe(SmtpEmailProvider);
    process.env.BREVO_API_KEY = 'xkeysib-1';
    expect(emailProviderClass()).toBe(BrevoApiEmailProvider);
  });
});

/** SmtpEmailProvider with fake transports; `ports` records every transport it builds. */
function smtpWith(behaviour: (port: number) => Promise<{ messageId: string }>) {
  process.env.SMTP_HOST = 'smtp-relay.brevo.com';
  process.env.SMTP_PORT = '587';
  const ports: number[] = [];
  class TestSmtp extends SmtpEmailProvider {
    protected makeTransport(port: number) {
      ports.push(port);
      return { sendMail: jest.fn(() => behaviour(port)), verify: jest.fn().mockResolvedValue(true) } as never;
    }
  }
  return { provider: new TestSmtp(), ports };
}
const connErr = () => Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
const msg = { to: 'x@y.et', subject: 's', html: '<p>h</p>' };

describe('SmtpEmailProvider', () => {
  it('falls back to port 2525 when the configured port is unreachable, and stays on it', async () => {
    const { provider, ports } = smtpWith(async (port) => {
      if (port === 587) throw connErr();
      return { messageId: `<id-${port}>` };
    });
    await expect(provider.send(msg)).resolves.toEqual({ message_id: '<id-2525>' });
    await expect(provider.send(msg)).resolves.toEqual({ message_id: '<id-2525>' });
    expect(ports).toEqual([587, 2525]);
  });

  it('does not retry on another port when the server rejects the login or message', async () => {
    const { provider, ports } = smtpWith(async () => {
      throw Object.assign(new Error('Invalid login: 535'), { code: 'EAUTH' });
    });
    await expect(provider.send(msg)).rejects.toThrow('Invalid login');
    expect(ports).toEqual([587]);
  });

  it('honours SMTP_FALLBACK_PORT and gives up after the fallback also fails', async () => {
    process.env.SMTP_FALLBACK_PORT = '2587';
    const { provider, ports } = smtpWith(async () => {
      throw connErr();
    });
    await expect(provider.send(msg)).rejects.toThrow('Connection timeout');
    expect(ports).toEqual([587, 2587]);
  });
});

describe('BrevoApiEmailProvider', () => {
  it('posts sender, recipient and HTML to the Brevo API and returns its message id', async () => {
    process.env.BREVO_API_KEY = 'xkeysib-test';
    process.env.EMAIL_FROM = 'EthiopiaLearn <team@ethiopialearn.et>';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ messageId: '<m1>' }), { status: 201 }));
    await expect(new BrevoApiEmailProvider().send({ ...msg, reply_to: 'r@y.et' })).resolves.toEqual({ message_id: '<m1>' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test');
    expect(JSON.parse(String(init.body))).toEqual({
      sender: { name: 'EthiopiaLearn', email: 'team@ethiopialearn.et' },
      to: [{ email: 'x@y.et' }],
      subject: 's',
      htmlContent: '<p>h</p>',
      replyTo: { email: 'r@y.et' },
    });
  });

  it('throws a readable error when Brevo rejects the sender', async () => {
    process.env.BREVO_API_KEY = 'xkeysib-test';
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'unauthorized', message: 'Sender not valid' }), { status: 400 }));
    await expect(new BrevoApiEmailProvider().send(msg)).rejects.toThrow(/Brevo rejected the email \(400 unauthorized\): Sender not valid/);
  });
});

describe('POST /admin/notifications/test-email', () => {
  const admin = { id: 'a1', role: 'platform_admin', email: 'admin@ethiopialearn.et' } as never;
  const logRepo = () => ({ create: jest.fn((x) => x), save: jest.fn(async (x) => x) });

  it('sends to the calling admin and reports the provider result', async () => {
    const log = logRepo();
    const email = { name: 'smtp', send: jest.fn().mockResolvedValue({ message_id: '<ok>' }) };
    const ctrl = new NotificationController({} as never, log as never, {} as never, email as never);
    await expect(ctrl.testEmail(admin)).resolves.toEqual({ ok: true, provider: 'smtp', to: 'admin@ethiopialearn.et', message_id: '<ok>' });
    expect(log.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', event_type: 'TestEmail' }));
  });

  it('returns (and logs) the failure reason instead of throwing', async () => {
    const log = logRepo();
    const email = { name: 'smtp', send: jest.fn().mockRejectedValue(new Error('Connection timeout')) };
    const ctrl = new NotificationController({} as never, log as never, {} as never, email as never);
    await expect(ctrl.testEmail(admin)).resolves.toEqual({ ok: false, provider: 'smtp', to: 'admin@ethiopialearn.et', error: 'Connection timeout' });
    expect(log.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'Connection timeout' }));
  });
});
