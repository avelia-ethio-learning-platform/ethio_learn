import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import * as nodemailer from 'nodemailer';
import { env, envBool, envInt } from '@ethiopialearn/common';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Optional Reply-To (e.g. a support request replies to the sender). */
  reply_to?: string;
}

/**
 * EmailProvider abstraction (spec §14): Brevo (HTTPS API or SMTP), any SMTP
 * relay, and Resend are wired. Email ONLY — there is no SMS provider anywhere
 * in this system (spec §0.2).
 */
export interface EmailProvider {
  /** Short name for logs and the admin test endpoint. */
  readonly name: string;
  send(message: EmailMessage): Promise<{ message_id: string }>;
}

const DEFAULT_FROM = 'EthiopiaLearn <no-reply@ethiopialearn.et>';

/** "EthiopiaLearn <a@b.c>" → { name, email }; a bare address has no name. */
export function parseAddress(value: string): { name?: string; email: string } {
  const m = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!m) return { email: value.trim() };
  const name = m[1].replace(/^"|"$/g, '').trim();
  return name ? { name, email: m[2].trim() } : { email: m[2].trim() };
}

/**
 * Brevo transactional API over HTTPS. Preferred on hosts that block outbound
 * SMTP ports (Render's free instances block 25, 465 and 587), because 443 is
 * never blocked. Needs a Brevo API key (xkeysib-…), not the SMTP key.
 */
@Injectable()
export class BrevoApiEmailProvider implements EmailProvider {
  readonly name = 'brevo-api';
  private readonly logger = new Logger(BrevoApiEmailProvider.name);

  async send(message: EmailMessage): Promise<{ message_id: string }> {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env('BREVO_API_KEY'), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: parseAddress(env('EMAIL_FROM', DEFAULT_FROM)),
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        ...(message.reply_to ? { replyTo: { email: message.reply_to } } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { messageId?: string; message?: string; code?: string };
    if (!res.ok || !body.messageId) {
      this.logger.error(`brevo send failed (${res.status}): ${JSON.stringify(body)}`);
      throw new Error(`Brevo rejected the email (${res.status}${body.code ? ` ${body.code}` : ''}): ${body.message ?? 'no details'}`);
    }
    return { message_id: body.messageId };
  }
}

@Injectable()
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly logger = new Logger(ResendEmailProvider.name);

  async send(message: EmailMessage): Promise<{ message_id: string }> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env('EMAIL_FROM', DEFAULT_FROM),
        to: [message.to],
        subject: message.subject,
        html: message.html,
        ...(message.reply_to ? { reply_to: message.reply_to } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as { id?: string; message?: string };
    if (!res.ok || !body.id) {
      this.logger.error(`resend send failed: ${JSON.stringify(body)}`);
      throw new Error(`Email send failed: ${body.message ?? res.status}`);
    }
    return { message_id: body.id };
  }
}

/** DEV-ONLY: prints the email to service logs instead of sending. */
@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  private readonly logger = new Logger('DevEmail');

  async send(message: EmailMessage): Promise<{ message_id: string }> {
    const id = uuidv4();
    this.logger.log(
      `\n──── EMAIL (dev console provider) ────\nTo: ${message.to}\nSubject: ${message.subject}\n${message.html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()}\n──────────────────────────────────────`,
    );
    return { message_id: id };
  }
}

/** Errors that mean "could not reach the SMTP server", as opposed to a rejected login or message. */
export function isSmtpConnectionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return ['ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'ESOCKET', 'EHOSTUNREACH', 'ENETUNREACH', 'EDNS'].includes(code);
}

type Transport = Pick<nodemailer.Transporter, 'sendMail' | 'verify'>;

/**
 * SMTP provider (nodemailer) — Brevo, Gmail app-passwords, Mailtrap, etc.
 *
 * Some hosts silently drop outbound SMTP on the standard ports (Render's free
 * instances block 25/465/587): nodemailer then waits its default 2 minutes
 * and the event handler stalls. So connections time out after 15 s, and a
 * connection failure retries once on SMTP_FALLBACK_PORT (default 2525, which
 * Brevo, SendGrid, Mailgun and Postmark all accept), sticking with it after.
 */
@Injectable()
export class SmtpEmailProvider implements EmailProvider, OnModuleInit {
  readonly name = 'smtp';
  private readonly logger = new Logger(SmtpEmailProvider.name);
  private readonly port = envInt('SMTP_PORT', 587);
  private readonly fallbackPort = envInt('SMTP_FALLBACK_PORT', 2525);
  private transport!: Transport;
  private usingFallback = false;

  private transportReady = false;

  /** Created lazily so tests can override makeTransport before first use. */
  private get current(): Transport {
    if (!this.transportReady) {
      this.transport = this.makeTransport(this.port, envBool('SMTP_SECURE', false));
      this.transportReady = true;
    }
    return this.transport;
  }

  protected makeTransport(port: number, secure: boolean): Transport {
    return nodemailer.createTransport({
      host: env('SMTP_HOST'),
      port,
      secure,
      auth: process.env.SMTP_USER ? { user: env('SMTP_USER'), pass: env('SMTP_PASS', '') } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  /** Log at boot whether the relay is reachable and the login works — without delaying startup. */
  onModuleInit() {
    void this.current
      .verify()
      .then(() => this.logger.log(`SMTP ready (${env('SMTP_HOST')}:${this.port})`))
      .catch((err: Error) =>
        this.logger.error(
          `SMTP check failed for ${env('SMTP_HOST')}:${this.port}: ${err.message}` +
            (isSmtpConnectionError(err) ? ` — the port may be blocked by the host; sends will retry on ${this.fallbackPort}` : ''),
        ),
      );
  }

  async send(message: EmailMessage): Promise<{ message_id: string }> {
    const mail = {
      from: env('EMAIL_FROM', DEFAULT_FROM),
      to: message.to,
      subject: message.subject,
      html: message.html,
      ...(message.reply_to ? { replyTo: message.reply_to } : {}),
    };
    try {
      const info = await this.current.sendMail(mail);
      return { message_id: info.messageId };
    } catch (err) {
      if (this.usingFallback || this.fallbackPort === this.port || !isSmtpConnectionError(err)) throw err;
      this.logger.warn(`SMTP port ${this.port} unreachable (${(err as Error).message}); switching to port ${this.fallbackPort}`);
      // The fallback ports are plain-connect + STARTTLS, never implicit TLS.
      this.transport = this.makeTransport(this.fallbackPort, false);
      this.usingFallback = true;
      const info = await this.transport.sendMail(mail);
      return { message_id: info.messageId };
    }
  }
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

/** Brevo API if keyed, else SMTP if configured, else Resend, else a dev console logger. */
export function emailProviderClass() {
  if (process.env.BREVO_API_KEY) return BrevoApiEmailProvider;
  if (process.env.SMTP_HOST) return SmtpEmailProvider;
  if (process.env.RESEND_API_KEY) return ResendEmailProvider;
  return ConsoleEmailProvider;
}
