import { matchPath } from './request-path';

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
 *
 * Resumable video uploads need no bucket of their own. The bytes go straight
 * to R2 and never pass through the gateway. The control plane is create, sign
 * parts, complete and abort, which are ordinary writes, plus a status GET,
 * which is general. Part URLs are signed up to 100 per request and stay valid
 * for 2 h, so a 2 GiB video (256 parts of 8 MiB) needs about 3 signing calls.
 * routes.revisions.spec.ts checks this budget against the write cap.
 */
export type RatePolicy = 'auth-strict' | 'auth' | 'ai' | 'community-write' | 'payment-initiate' | 'write' | 'general';

/** Per-minute cap for each bucket; main.ts lets RATE_LIMIT_*_PER_MIN override each one. */
export const DEFAULT_LIMITS_PER_MIN: Record<RatePolicy, number> = {
  'auth-strict': 10,
  auth: 30,
  ai: 5,
  'community-write': 20,
  'payment-initiate': 10,
  write: 60,
  general: 300,
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const AUTH_STRICT =
  /^\/api\/v1\/auth\/(login|signup|verify-email|accept-invite|reset-password(\/confirm)?)$/;
const AI_ENDPOINTS = /^\/api\/v1\/courses\/generate-structure$|^\/api\/v1\/assessments\/generate$|^\/api\/v1\/courses\/[^/]+\/chat$/;
// GET endpoints that still hit the LLM (study coach). Chat history GETs do not.
const AI_GET = /^\/api\/v1\/attempts\/[^/]+\/study-plan$/;
const COMMUNITY_WRITE = /^\/api\/v1\/(comments|messages)\b|^\/api\/v1\/courses\/[^/]+\/comments$/;
// Public support contact form — spam target, keyed by IP via the same bucket.
const SUPPORT = /^\/api\/v1\/support\/contact$/;
// Every endpoint that opens a checkout / moves money.
const PAYMENT_INITIATE = /^\/api\/v1\/(payments\/initiate|wallet\/topup|gifts|bulk-purchases|pay-requests\/[^/]+\/pay)$/;
// Invitations by email are a spam vector — same bucket as comments/DMs.
const INVITES = /^\/api\/v1\/(referrals\/invite|pay-requests|bulk-purchases\/[^/]+\/assign)$/;
// Chapa calls the webhook — throttling it could drop legitimate payment
// confirmations, so it stays on the general bucket only.
const WEBHOOK = /^\/api\/v1\/payments\/webhook\//;

/**
 * The bucket for a request. `rawPath` is the path without its query string;
 * it is normalised first (see matchPath), so '/api/v1/auth/LOGIN/' is still
 * throttled as a credential endpoint.
 */
export function classifyRequest(method: string, rawPath: string): RatePolicy {
  const m = method.toUpperCase();
  const path = matchPath(rawPath);
  if (path.startsWith('/api/v1/auth/')) {
    return m === 'POST' && AUTH_STRICT.test(path) ? 'auth-strict' : 'auth';
  }
  // The study-plan READ calls the LLM, so it belongs in the AI bucket even
  // though it is a GET (chat history GETs do NOT call the model — only POSTs do).
  if (AI_GET.test(path)) return 'ai';
  if (!MUTATING.has(m)) return 'general';
  if (WEBHOOK.test(path)) return 'general';
  if (AI_ENDPOINTS.test(path)) return 'ai';
  if (COMMUNITY_WRITE.test(path) || SUPPORT.test(path) || INVITES.test(path)) return 'community-write';
  if (PAYMENT_INITIATE.test(path)) return 'payment-initiate';
  return 'write';
}
