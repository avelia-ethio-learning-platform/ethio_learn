/**
 * Rate-limit policy table: classifies every request into a named bucket so
 * abuse-prone surfaces get tighter caps than plain reads. Kept as a pure
 * function (no express types) so it is trivially unit-testable.
 *
 * Buckets (per-minute caps, all overridable via env — see main.ts):
 *  - auth-strict      credential endpoints (login/signup/reset…): brute-force target, keyed by IP
 *  - auth             the rest of /auth (refresh, …), keyed by IP
 *  - ai               endpoints that call the LLM — expensive, keyed by user
 *  - community-write  comments + DMs — spam target, keyed by user
 *  - payment-initiate payment session creation, keyed by user
 *  - write            any other mutation, keyed by user (falls back to IP)
 *  - general          everything, keyed by user/IP — always applied on top
 */
export type RatePolicy = 'auth-strict' | 'auth' | 'ai' | 'community-write' | 'payment-initiate' | 'write' | 'general';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const AUTH_STRICT =
  /^\/api\/v1\/auth\/(login|signup|verify-email|accept-invite|reset-password(\/confirm)?)$/;
const AI_ENDPOINTS = /^\/api\/v1\/courses\/generate-structure$/;
const COMMUNITY_WRITE = /^\/api\/v1\/(comments|messages)\b|^\/api\/v1\/courses\/[^/]+\/comments$/;
// Public support contact form — spam target, keyed by IP via the same bucket.
const SUPPORT = /^\/api\/v1\/support\/contact$/;
const PAYMENT_INITIATE = /^\/api\/v1\/payments\/initiate$/;
// Chapa calls the webhook — throttling it could drop legitimate payment
// confirmations, so it stays on the general bucket only.
const WEBHOOK = /^\/api\/v1\/payments\/webhook\//;

export function classifyRequest(method: string, path: string): RatePolicy {
  const m = method.toUpperCase();
  if (path.startsWith('/api/v1/auth/')) {
    return m === 'POST' && AUTH_STRICT.test(path) ? 'auth-strict' : 'auth';
  }
  if (!MUTATING.has(m)) return 'general';
  if (WEBHOOK.test(path)) return 'general';
  if (AI_ENDPOINTS.test(path)) return 'ai';
  if (COMMUNITY_WRITE.test(path) || SUPPORT.test(path)) return 'community-write';
  if (PAYMENT_INITIATE.test(path)) return 'payment-initiate';
  return 'write';
}
