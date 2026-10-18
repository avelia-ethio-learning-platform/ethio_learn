import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/**
 * What the code running now works for (Phase 9d): an HTTP request, a bus
 * handler, or both when a handler was set off by a request. Log lines, internal
 * calls and published events read it, so one id follows a request through every
 * service and event it causes.
 */
export interface RequestContext {
  /** Always a UUID: it becomes the `correlation_id` of the events published under it, a `uuid` column in the outbox. */
  request_id?: string;
  /**
   * The caller, as the gateway forwarded it after verifying the JWT. Read before
   * the internal-token check, so on `/health`, `/ready` and where
   * REQUIRE_INTERNAL_TOKEN is off (local dev) a direct caller can set it.
   */
  user_id?: string;
  event_id?: string;
  event_type?: string;
  correlation_id?: string;
  /** The bus handler's name, as given to `subscribe`. */
  handler?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return requestContext.getStore();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * The request id for an incoming `x-request-id` (or an event's correlation id):
 * kept when it is a UUID, lower-cased the way Postgres stores it, otherwise a
 * fresh one. A non-UUID id (nginx's 32-hex `$request_id`, `checkout-1`) would
 * fail every outbox insert of the request with 22P02.
 */
export function requestIdFrom(incoming: unknown): string {
  return isUuid(incoming) ? incoming.toLowerCase() : randomUUID();
}

interface ContextRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface ContextResponse {
  setHeader(name: string, value: string): unknown;
}

/**
 * Express middleware, registered first: runs the rest of the request inside its
 * context, forwards the id on `req` (so `x-request-id` reads the same downstream)
 * and returns it in the response.
 */
export function requestContextMiddleware(req: ContextRequest, res: ContextResponse, next: () => void): void {
  const request_id = requestIdFrom(req.headers['x-request-id']);
  req.headers['x-request-id'] = request_id;
  res.setHeader('x-request-id', request_id);
  const user = req.headers['x-user-id'];
  requestContext.run({ request_id, user_id: typeof user === 'string' && user ? user : undefined }, next);
}
