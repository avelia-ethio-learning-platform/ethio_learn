import { Injectable, Logger } from '@nestjs/common';

/**
 * Cross-service synchronous READS go through the API Gateway (spec §0 rule 4)
 * authenticated with the shared internal token. Cross-service WRITES must use
 * the event bus — this client intentionally exposes GET only.
 */
@Injectable()
export class InternalHttpClient {
  private readonly logger = new Logger(InternalHttpClient.name);
  private readonly gatewayUrl = process.env.GATEWAY_INTERNAL_URL ?? 'http://localhost:4000';

  async get<T>(path: string): Promise<T> {
    // Bounded timeout so a slow/stuck peer can't tie up this service's request
    // handlers under load. Node's fetch (undici) already keep-alives connections.
    let res: Response;
    try {
      res = await fetch(`${this.gatewayUrl}${path}`, {
        headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN ?? '' },
        signal: AbortSignal.timeout(Number(process.env.INTERNAL_HTTP_TIMEOUT_MS ?? 8000)),
      });
    } catch (err) {
      this.logger.warn(`internal GET ${path} failed: ${(err as Error).message}`);
      throw new Error(`Internal request failed: GET ${path}`);
    }
    if (!res.ok) {
      this.logger.warn(`internal GET ${path} -> ${res.status}`);
      throw new Error(`Internal request failed: GET ${path} -> ${res.status}`);
    }
    return (await res.json()) as T;
  }
}
