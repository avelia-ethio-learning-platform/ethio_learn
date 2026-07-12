import { BadRequestException, HttpException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ChapaService } from 'chapa-nestjs';
import { env } from '@ethiopialearn/common';

/**
 * Chapa integration via the official chapa-nestjs SDK
 * (https://github.com/Chapa-Et/chapa-nestjs). `ChapaModule.register` in
 * app.module supplies the configured ChapaService; the live provider below is
 * a thin port adapter so PaymentService stays gateway-agnostic and the mock
 * provider can stand in for offline development.
 *
 * Critical practices enforced at this layer and in PaymentService:
 *  - tx_ref is ALWAYS server-generated (never client-supplied)
 *  - secret key lives server-side in env only (CHAPA_SECRET_KEY)
 *  - webhooks are the source of truth; browser redirects grant nothing
 *  - verify() is consulted before any PaymentConfirmed is published
 */

/** Mirrors chapa-nestjs `InitializeOptions`. */
export interface ChapaInitializeOptions {
  first_name: string;
  last_name: string;
  email: string;
  currency: 'ETB'; // always ETB (spec §6)
  amount: string; // SDK contract: amount travels as a string
  tx_ref: string;
  callback_url?: string;
  return_url?: string;
  customization?: { title?: string; description?: string; logo?: string };
}

export interface ChapaVerification {
  status: 'success' | 'failed' | 'pending';
  /** Amount/currency as verified by the gateway — null when the gateway does not report them (mock). */
  amount: number | null;
  currency: string | null;
}

export interface ChapaProvider {
  /** SDK-style reference (TX-ALPHANUM). Always generated here, never by clients.
   *  Async to match chapa-nestjs `generateTransactionReference`. */
  generateTxRef(): Promise<string>;
  initialize(options: ChapaInitializeOptions): Promise<{ checkout_url: string }>;
  /** Server-side double-check against Chapa (spec §6 step 5). */
  verify(txRef: string): Promise<ChapaVerification>;
}

/** chapa-nestjs `generateTransactionReference`: prefix + random alphanumerics. */
export function generateTransactionReference(options?: { prefix?: string; size?: number }): string {
  const prefix = options?.prefix ?? 'TX';
  const size = options?.size ?? 15;
  const alphabet = 'ABCDEFGHIJKLMNPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i++) out += alphabet[bytes[i] % alphabet.length];
  return `${prefix}-${out}`;
}

/**
 * Real Chapa gateway via the chapa-nestjs SDK's ChapaService (configured in
 * app.module with CHAPA_SECRET_KEY — server-side only, spec §6).
 */
@Injectable()
export class LiveChapaProvider implements ChapaProvider {
  private readonly logger = new Logger(LiveChapaProvider.name);

  constructor(private readonly chapaService: ChapaService) {}

  generateTxRef(): Promise<string> {
    return this.chapaService.generateTransactionReference();
  }

  async initialize(options: ChapaInitializeOptions): Promise<{ checkout_url: string }> {
    let response;
    try {
      response = await this.chapaService.initialize(options);
    } catch (err) {
      // The SDK throws HttpException with Chapa's raw validation body — log it
      // in full, hand the caller something readable.
      const detail = err instanceof HttpException ? JSON.stringify(err.getResponse()) : (err as Error).message;
      this.logger.error(`chapa initialize rejected: ${detail.slice(0, 400)}`);
      throw new BadRequestException(`Payment gateway rejected the request: ${detail.slice(0, 200)}`);
    }
    if (response.status !== 'success' || !response.data?.checkout_url) {
      this.logger.error(`chapa initialize failed: ${JSON.stringify(response).slice(0, 400)}`);
      throw new Error('Chapa could not start this checkout. Please try again.');
    }
    return { checkout_url: response.data.checkout_url };
  }

  async verify(txRef: string): Promise<ChapaVerification> {
    try {
      const response = await this.chapaService.verify({ tx_ref: txRef });
      const data = response?.data;
      if (!data) return { status: 'pending', amount: null, currency: null };
      // Chapa reports terminal failure in several spellings — most notably
      // "failed/cancelled" (with a slash) for an abandoned checkout. Match on
      // substrings so a cancelled attempt is recorded as failed, not left
      // pending forever.
      const raw = String(data.status ?? '').toLowerCase();
      const status: ChapaVerification['status'] =
        raw === 'success' ? 'success' : /fail|cancel|declin|reject|error/.test(raw) ? 'failed' : 'pending';
      return {
        status,
        amount: data.amount != null ? Number(data.amount) : null,
        currency: data.currency ?? null,
      };
    } catch (err) {
      // Fail safe: a verify error can never confirm a payment.
      this.logger.warn(`chapa verify error for ${txRef}: ${(err as Error).message}`);
      return { status: 'pending', amount: null, currency: null };
    }
  }
}

/**
 * DEV-ONLY mock gateway: the "checkout page" is a local page in the web app
 * that posts back to /payments/mock/complete, which then delivers a genuinely
 * HMAC-signed webhook — so the full §6 verification path is exercised offline.
 * Selected only when CHAPA_MODE=mock (the default when no secret key is set).
 */
@Injectable()
export class MockChapaProvider implements ChapaProvider {
  async generateTxRef(): Promise<string> {
    return generateTransactionReference({ prefix: 'TX-MOCK' });
  }

  async initialize(options: ChapaInitializeOptions): Promise<{ checkout_url: string }> {
    const webUrl = env('WEB_URL', 'http://localhost:3000');
    const params = new URLSearchParams({
      tx_ref: options.tx_ref,
      amount: options.amount,
      title: options.customization?.description ?? 'EthiopiaLearn course',
      return_url: options.return_url ?? webUrl,
    });
    return { checkout_url: `${webUrl}/dev/checkout?${params.toString()}` };
  }

  async verify(): Promise<ChapaVerification> {
    // The mock webhook is only emitted for terminal states, so echo success —
    // the HMAC gate has already run before verify() is consulted. No amount is
    // reported, which skips the amount cross-check (live mode enforces it).
    return { status: 'success', amount: null, currency: null };
  }
}

export const CHAPA_PROVIDER = 'CHAPA_PROVIDER';

export function chapaMode(): 'live' | 'mock' {
  const mode = process.env.CHAPA_MODE;
  if (mode === 'live') return 'live';
  if (mode === 'mock') return 'mock';
  return process.env.CHAPA_SECRET_KEY ? 'live' : 'mock';
}
