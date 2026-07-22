import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import * as nodemailer from 'nodemailer';
import { env, envBool, envInt } from '@ethiopialearn/common';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

/**
 * EmailProvider abstraction (spec §14): Resend is wired; SendGrid (or any
 * other provider) is one adapter away. Email ONLY — there is no SMS provider
 * anywhere in this system (spec §0.2).
 */
export interface EmailProvider {
  send(message: EmailMessage): Promise<{ message_id: string }>;
}

@Injectable()
export class ResendEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);

  async send(message: EmailMessage): Promise<{ message_id: string }> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env('EMAIL_FROM', 'EthiopiaLearn <no-reply@ethiopialearn.et>'),
        to: [message.to],
        subject: message.subject,
        html: message.html,
      }),
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

/** SMTP provider (nodemailer) — works with Gmail app-passwords, Mailtrap, etc. */
@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SmtpEmailProvider.name);
  private readonly transport = nodemailer.createTransport({
    host: env('SMTP_HOST'),
    port: envInt('SMTP_PORT', 587),
    secure: envBool('SMTP_SECURE', false),
    auth: process.env.SMTP_USER ? { user: env('SMTP_USER'), pass: env('SMTP_PASS', '') } : undefined,
  });

  async send(message: EmailMessage): Promise<{ message_id: string }> {
    const info = await this.transport.sendMail({
      from: env('EMAIL_FROM', 'EthiopiaLearn <no-reply@ethiopialearn.et>'),
      to: message.to,
      subject: message.subject,
      html: message.html,
    });
    return { message_id: info.messageId };
  }
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

/** SMTP if configured, else Resend, else a dev console logger. */
export function emailProviderClass() {
  if (process.env.SMTP_HOST) return SmtpEmailProvider;
  if (process.env.RESEND_API_KEY) return ResendEmailProvider;
  return ConsoleEmailProvider;
}
