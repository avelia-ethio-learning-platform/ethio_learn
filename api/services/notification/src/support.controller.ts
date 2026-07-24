import { BadRequestException, Body, Controller, HttpCode, Inject, Logger, Post } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { env } from '@ethiopialearn/common';
import { EMAIL_PROVIDER, EmailProvider } from './email.provider';
import { NotificationLog } from './entities';

class ContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  subject?: string;

  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  message: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * [PUBLIC] Help & Support contact form. Emails the support inbox via the
 * configured email provider (Resend when RESEND_API_KEY is set), with Reply-To
 * set to the sender so support can reply directly. Rate-limited at the gateway.
 */
@Controller('support')
export class SupportController {
  private readonly logger = new Logger(SupportController.name);

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @InjectRepository(NotificationLog) private readonly log: Repository<NotificationLog>,
  ) {}

  @Post('contact')
  @HttpCode(202)
  async contact(@Body() dto: ContactDto) {
    const to = env('SUPPORT_EMAIL', 'aisubyazew@gmail.com');
    const name = dto.name?.trim() || 'A visitor';
    const subject = dto.subject?.trim() || 'New support request';
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#0f766e;margin-bottom:4px">EthiopiaLearn — Support request</h2>
      <p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(dto.email)}&gt;</p>
      <p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
      <hr style="border:none;border-top:1px solid #e5e7eb"/>
      <p style="white-space:pre-wrap">${escapeHtml(dto.message)}</p>
      <p style="color:#6b7280;font-size:12px;margin-top:24px">Reply directly to this email to respond to ${escapeHtml(dto.email)}.</p>
    </div>`;

    try {
      const { message_id } = await this.email.send({ to, subject: `[Support] ${subject}`, html, reply_to: dto.email });
      await this.log.save(
        this.log.create({ user_id: null, event_type: 'SupportRequest', channel: 'email', recipient: to, subject, status: 'sent', provider_message_id: message_id }),
      );
      return { received: true };
    } catch (err) {
      this.logger.error(`support contact email failed: ${(err as Error).message}`);
      await this.log.save(
        this.log.create({ user_id: null, event_type: 'SupportRequest', channel: 'email', recipient: to, subject, status: 'failed', provider_message_id: null }),
      );
      throw new BadRequestException('Could not send your message right now. Please try again shortly.');
    }
  }
}
