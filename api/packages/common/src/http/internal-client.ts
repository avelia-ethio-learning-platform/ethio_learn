import { Injectable, Logger } from '@nestjs/common';
import { envOrLocalDefault } from '../config/env';
import { PeerAsleepError, PeerNotFoundError, PeerUnavailableError } from './internal-errors';

/** A path built by `internalPath`; `get()` accepts nothing else. */
export type InternalPath = string & { readonly __brand: 'InternalPath' };

const INTERNAL_PREFIX = '/api/v1/internal/';

/**
 * Tagged template for internal paths: every interpolated value is
 * percent-encoded, so a route or query parameter can't add segments, a query
 * string or a fragment. An array becomes its encoded items joined by a literal
 * comma (the receivers comma-split). Note `encodeURIComponent` leaves `.` alone,
 * so a bare `..` value still forms a dot segment; `get()` refuses that.
 */
export function internalPath(
  strings: TemplateStringsArray,
  ...values: Array<string | number | readonly (string | number)[]>
): InternalPath {
  const enc = (v: string | number) => encodeURIComponent(String(v));
  let out = strings[0];
  values.forEach((v, i) => {
    out += (Array.isArray(v) ? v.map(enc).join(',') : enc(v as string | number)) + strings[i + 1];
  });
  return out as InternalPath;
}

/** Reason the path must not be fetched, or null when it is acceptable. */
function pathViolation(path: string, base: string): string | null {
  if (!path.startsWith(INTERNAL_PREFIX)) return 'outside the internal prefix';
  if (path.includes('\\') || path.includes('#')) return 'backslash or fragment';
  const q = path.indexOf('?');
  const pathOnly = q === -1 ? path : path.slice(0, q);
  try {
    if (new URL(path, base).pathname !== pathOnly) return 'dot segment or non-normalized path';
  } catch {
    return 'unparseable path';
  }
  return null;
}

/**
 * Cross-service synchronous READS go through the API Gateway (spec §0 rule 4)
 * authenticated with the shared internal token. Cross-service WRITES must use
 * the event bus — this client intentionally exposes GET only.
 */
@Injectable()
export class InternalHttpClient {
  private readonly logger = new Logger(InternalHttpClient.name);
  // Fatal in production when unset: a silent localhost fallback here turned
  // every cross-service read (entitlement checks, learner email lookups,
  // pending-project lists) into an opaque 500 on Render.
  private readonly gatewayUrl = envOrLocalDefault('GATEWAY_INTERNAL_URL', 'http://localhost:4000');

  async get<T>(path: InternalPath): Promise<T> {
    const violation = pathViolation(path, this.gatewayUrl);
    if (violation) {
      // Length only: the value may be attacker-controlled. The service's own
      // log stream identifies the caller.
      this.logger.warn(`internal GET refused (${violation}), path length ${path.length}`);
      throw new Error('Internal request refused: invalid internal path');
    }
    // Bounded timeout so a slow/stuck peer can't tie up this service's request
    // handlers under load. Node's fetch (undici) already keep-alives connections.
    // Messages and logs never carry the path: it can hold an email address.
    const attempt = () =>
      fetch(`${this.gatewayUrl}${path}`, {
        headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' },
        signal: AbortSignal.timeout(Number(process.env.INTERNAL_HTTP_TIMEOUT_MS ?? 8000)),
      });
    let res: Response;
    try {
      try {
        res = await attempt();
      } catch (err) {
        // One retry, only for a connection that failed fast (peer restarting). Never after a timeout.
        if (!isFastConnectionFailure(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
        res = await attempt();
      }
    } catch (err) {
      this.logger.warn(`internal GET failed (${(err as Error).name}), path length ${path.length}`);
      throw new PeerUnavailableError();
    }
    if (!res.ok) {
      this.logger.warn(`internal GET failed (${res.status}), path length ${path.length}`);
      if (res.status === 404) throw new PeerNotFoundError('Not found');
      if (res.status === 429) {
        const text = await res.text().catch(() => '');
        if (isHibernation(res.status, res.headers, text)) throw new PeerAsleepError();
      }
      throw new PeerUnavailableError();
    }
    return (await res.json()) as T;
  }
}

function isFastConnectionFailure(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET';
}

/** Mirrors web/src/lib/hibernation.ts: a JSON 429 is a limiter, anything else is a sleeping service. */
function isHibernation(status: number, headers: Headers, bodyText: string): boolean {
  if (status !== 429) return false;
  if (headers.get('x-render-routing')?.includes('hibernate')) return true;
  try {
    return (JSON.parse(bodyText) as { statusCode?: unknown } | null)?.statusCode !== 429;
  } catch {
    return true;
  }
}
