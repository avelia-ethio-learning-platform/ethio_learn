import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { env } from '@ethiopialearn/common';

/**
 * Chapa integration over plain `fetch` against Chapa's REST API
 * (https://developer.chapa.co), with a timeout on every call. The live
 * provider below is a thin port adapter so PaymentService stays
 * gateway-agnostic and the mock provider can stand in for offline development.
 *
 * Critical practices enforced at this layer and in PaymentService:
 *  - tx_ref is ALWAYS server-generated (never client-supplied)
 *  - secret key lives server-side in env only (CHAPA_SECRET_KEY)
 *  - webhooks are the source of truth; browser redirects grant nothing
 *  - verify() is consulted before any PaymentConfirmed is published
 */

/** Chapa's initialize request body. */
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
   *  Async so a provider may generate it remotely. */
  generateTxRef(): Promise<string>;
  initialize(options: ChapaInitializeOptions): Promise<{ checkout_url: string }>;
  /** Server-side double-check against Chapa (spec §6 step 5). */
  verify(txRef: string): Promise<ChapaVerification>;
}

/** Transaction reference: prefix + random alphanumerics. */
export function generateTransactionReference(options?: { prefix?: string; size?: number }): string {
  const prefix = options?.prefix ?? 'TX';
  const size = options?.size ?? 15;
  const alphabet = 'ABCDEFGHIJKLMNPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i++) out += alphabet[bytes[i] % alphabet.length];
  return `${prefix}-${out}`;
}

const CHAPA_BASE = 'https://api.chapa.co/v1/transaction';

/** Thrown when Chapa can't be reached (timeout, network, 5xx, rejected API key). */
export class ChapaUnavailableError extends ServiceUnavailableException {
  constructor() {
    super('The payment provider is not responding. Try again in a minute.');
  }
}

/**
 * Real Chapa gateway (CHAPA_SECRET_KEY — server-side only, spec §6).
 */
@Injectable()
export class LiveChapaProvider implements ChapaProvider {
  private readonly logger = new Logger(LiveChapaProvider.name);

  async generateTxRef(): Promise<string> {
    return generateTransactionReference();
  }

  /** One Chapa call. Network errors and timeouts become ChapaUnavailableError; HTTP statuses are the caller's. */
  private async call(url: string, init: RequestInit): Promise<{ status: number; body: any }> {
    const timeoutMs = Number(process.env.CHAPA_TIMEOUT_MS ?? 10000);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`, ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      this.logger.warn(`chapa unreachable: ${(err as Error).name}: ${(err as Error).message}`);
      throw new ChapaUnavailableError();
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body: handled by status */
    }
    return { status: res.status, body };
  }

  async initialize(options: ChapaInitializeOptions): Promise<{ checkout_url: string }> {
    const { status, body } = await this.call(`${CHAPA_BASE}/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    if (status >= 500) {
      this.logger.warn(`chapa initialize answered ${status}`);
      throw new ChapaUnavailableError();
    }
    if (status >= 400) {
      // Chapa's raw validation body — log it in full, hand the caller something readable.
      const detail = JSON.stringify(body?.message ?? body) ?? String(status);
      this.logger.error(`chapa initialize rejected: ${detail.slice(0, 400)}`);
      throw new BadRequestException(`Payment gateway rejected the request: ${detail.slice(0, 200)}`);
    }
    if (body?.status !== 'success' || !body.data?.checkout_url) {
      this.logger.error(`chapa initialize failed: ${JSON.stringify(body).slice(0, 400)}`);
      throw new Error('Chapa could not start this checkout. Please try again.');
    }
    return { checkout_url: body.data.checkout_url };
  }

  async verify(txRef: string): Promise<ChapaVerification> {
    const { status: http, body } = await this.call(`${CHAPA_BASE}/verify/${encodeURIComponent(txRef)}`, { method: 'GET' });
    if (http === 401 || http === 403) {
      this.logger.error('chapa verify rejected the API key (401/403): check CHAPA_SECRET_KEY');
      throw new ChapaUnavailableError();
    }
    if (http >= 500) {
      this.logger.warn(`chapa verify answered ${http} for ${txRef}`);
      throw new ChapaUnavailableError();
    }
    if (http >= 400) {
      // Fail safe: a verify error can never confirm a payment.
      this.logger.warn(`chapa verify error for ${txRef}: HTTP ${http}`);
      return { status: 'pending', amount: null, currency: null };
    }
    const data = body?.data;
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
  /** What the mock checkout page chose per tx_ref, so verify() can report it. */
  private readonly outcomes = new Map<string, 'success' | 'failed'>();

  settle(txRef: string, outcome: 'success' | 'failed'): void {
    this.outcomes.set(txRef, outcome);
  }

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

  async verify(txRef: string): Promise<ChapaVerification> {
    // The mock webhook is only emitted for terminal states: report the outcome
    // the checkout chose (success when unknown). No amount is reported, which
    // skips the amount cross-check (live mode requires one).
    return { status: this.outcomes.get(txRef) ?? 'success', amount: null, currency: null };
  }
}

export const CHAPA_PROVIDER = 'CHAPA_PROVIDER';

export function chapaMode(): 'live' | 'mock' {
  const mode = process.env.CHAPA_MODE;
  if (mode === 'live') return 'live';
  if (mode === 'mock') return 'mock';
  return process.env.CHAPA_SECRET_KEY ? 'live' : 'mock';
}
