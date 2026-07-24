import { env } from '@ethiopialearn/common';

export type AuthMode = 'public' | 'jwt' | 'internal';

export interface RouteRule {
  /** Regex tested against the request path (without query string). */
  pattern: RegExp;
  target: () => string;
  /** Static auth mode, or a resolver for method-dependent routes. */
  auth: AuthMode | ((method: string, path: string) => AuthMode);
}

const AUTH = () => env('AUTH_SERVICE_URL', 'http://localhost:4101');
const COURSE = () => env('COURSE_SERVICE_URL', 'http://localhost:4102');
const ENROLLMENT = () => env('ENROLLMENT_SERVICE_URL', 'http://localhost:4103');
const OUTCOMES = () => env('OUTCOMES_SERVICE_URL', 'http://localhost:4104');
const FINANCIAL = () => env('FINANCIAL_SERVICE_URL', 'http://localhost:4105');
const QUALITY = () => env('QUALITY_SERVICE_URL', 'http://localhost:4106');
const NOTIFICATION = () => env('NOTIFICATION_SERVICE_URL', 'http://localhost:4107');

/**
 * Ordered route table — first match wins. The gateway is the ONLY entry point
 * for client traffic (spec §0.5 rule 4); services are never internet-exposed.
 */
export const ROUTES: RouteRule[] = [
  // ---- internal service-to-service reads (shared-token auth) ----
  { pattern: /^\/api\/v1\/internal\/educators\/[^/]+\/trust-tier$/, target: QUALITY, auth: 'internal' },
  { pattern: /^\/api\/v1\/internal\/(users|educators|institutions)\b/, target: AUTH, auth: 'internal' },
  { pattern: /^\/api\/v1\/internal\/(courses|lessons|owners)\b/, target: COURSE, auth: 'internal' },
  { pattern: /^\/api\/v1\/internal\/enrollments\/[^/]+\/outcomes-status$/, target: OUTCOMES, auth: 'internal' },
  { pattern: /^\/api\/v1\/internal\/(entitlements|enrollments)\b/, target: ENROLLMENT, auth: 'internal' },

  // ---- auth & identity ----
  { pattern: /^\/api\/v1\/auth\b/, target: AUTH, auth: 'public' },
  { pattern: /^\/api\/v1\/(profiles|institutions|admin\/users)\b/, target: AUTH, auth: 'jwt' },

  // ---- payments (webhook + dev mock checkout are public; HMAC/mode-guarded downstream) ----
  { pattern: /^\/api\/v1\/payments\/webhook\/chapa$/, target: FINANCIAL, auth: 'public' },
  { pattern: /^\/api\/v1\/payments\/mock\/complete$/, target: FINANCIAL, auth: 'public' },
  { pattern: /^\/api\/v1\/(payments|refunds|payouts|admin\/payments)\b/, target: FINANCIAL, auth: 'jwt' },

  // ---- community: course discussion + DMs (route BEFORE generic /courses) ----
  {
    pattern: /^\/api\/v1\/courses\/[^/]+\/comments$/,
    target: NOTIFICATION,
    auth: (method) => (method === 'GET' ? 'public' : 'jwt'),
  },
  { pattern: /^\/api\/v1\/(comments|messages)\b/, target: NOTIFICATION, auth: 'jwt' },

  // ---- quality & trust (route BEFORE generic /courses) ----
  {
    pattern: /^\/api\/v1\/courses\/[^/]+\/reviews$/,
    target: QUALITY,
    auth: (method) => (method === 'GET' ? 'public' : 'jwt'),
  },
  { pattern: /^\/api\/v1\/(qa|fraud)\b/, target: QUALITY, auth: 'jwt' },
  { pattern: /^\/api\/v1\/educators\/[^/]+\/trust-tier$/, target: QUALITY, auth: 'public' },

  // ---- educator rankings & public profiles ----
  { pattern: /^\/api\/v1\/educators\/(top$|[^/]+\/profile$)/, target: COURSE, auth: 'public' },

  // ---- learning outcomes (course-scoped routes BEFORE generic /courses) ----
  { pattern: /^\/api\/v1\/courses\/[^/]+\/(pending-projects|attempts)$/, target: OUTCOMES, auth: 'jwt' },
  { pattern: /^\/api\/v1\/(assessments|attempts|me\/certificates)\b/, target: OUTCOMES, auth: 'jwt' },
  { pattern: /^\/api\/v1\/(certificates|verify)\/[^/]+$/, target: OUTCOMES, auth: 'public' },

  // ---- course & content ----
  // Institution internal review/management (singular 'institution' — distinct
  // from auth's plural 'institutions').
  { pattern: /^\/api\/v1\/institution\/(review-queue|courses)\b/, target: COURSE, auth: 'jwt' },
  { pattern: /^\/api\/v1\/search\b/, target: COURSE, auth: 'public' },
  {
    pattern: /^\/api\/v1\/courses(\/[^/]+)?$/,
    // Public catalog reads; authoring requires JWT. GET /courses (list own) is JWT.
    target: COURSE,
    auth: (method, path) => (method === 'GET' && /^\/api\/v1\/courses\/[^/]+$/.test(path) ? 'public' : 'jwt'),
  },
  { pattern: /^\/api\/v1\/(courses|sections|lessons|uploads|admin\/courses)\b/, target: COURSE, auth: 'jwt' },

  // ---- enrollment & progress ----
  { pattern: /^\/api\/v1\/(enrollments|progress)\b/, target: ENROLLMENT, auth: 'jwt' },

  // ---- notifications ----
  { pattern: /^\/api\/v1\/(notifications|notification-preferences|admin\/notifications)\b/, target: NOTIFICATION, auth: 'jwt' },

  // ---- help & support (public contact form) ----
  { pattern: /^\/api\/v1\/support\/contact$/, target: NOTIFICATION, auth: 'public' },
];

export function resolveRoute(path: string): RouteRule | undefined {
  return ROUTES.find((rule) => rule.pattern.test(path));
}
