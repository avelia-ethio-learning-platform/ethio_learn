// The web app's security headers, including its Content Security Policy.
// Plain JS (with JSDoc types) because next.config.mjs imports it: Next 14
// can't load a TypeScript config dependency. Pure: everything comes from `env`,
// the build's environment, so the vitest can check each case.

/** Where the browser posts CSP reports (app/api/csp-report/route.ts). */
export const CSP_REPORT_PATH = '/api/csp-report';
const REPORT_GROUP = 'csp-endpoint';

const GOOGLE = {
  script: 'https://accounts.google.com/gsi/client',
  style: 'https://accounts.google.com/gsi/style',
  gsi: 'https://accounts.google.com/gsi/',
  avatars: 'https://*.googleusercontent.com',
};

/**
 * The origin (scheme, host, port) of each comma-separated URL. Blank and
 * unparsable entries are skipped.
 * @param {string | undefined} list
 * @returns {string[]}
 */
function origins(list) {
  return (list ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
    .flatMap((url) => {
      try {
        const { origin } = new URL(url);
        return origin === 'null' ? [] : [origin];
      } catch {
        return [];
      }
    });
}

/** @param {(string | false | undefined)[]} sources */
const unique = (sources) => [...new Set(sources.filter(Boolean))];

/**
 * Production on Vercel: HSTS, upgrade-insecure-requests, and (until the user
 * sets CSP_ENFORCE=true) a Report-Only policy. Keyed on VERCEL_ENV, never on
 * NODE_ENV, which `next build` always sets to production, so CI's `next start`
 * runs the enforced policy.
 * @param {Record<string, string | undefined>} env
 */
const isVercelProduction = (env) => env.VERCEL_ENV === 'production';

/**
 * Whether the policy is enforced or only reported.
 * @param {Record<string, string | undefined>} env
 */
export function cspEnforced(env) {
  if (env.CSP_ENFORCE === 'true') return true;
  if (env.CSP_ENFORCE === 'false') return false;
  return !isVercelProduction(env);
}

/**
 * The Content Security Policy for this build: exactly what the app loads.
 * The app's own defaults apply when an env var is unset (the API on :4000 and
 * storage on :9000 locally, as in lib/api.ts and the upload code).
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function buildCsp(env) {
  const google = !!env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const api = origins(env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000');
  const storage = origins(env.NEXT_PUBLIC_S3_PUBLIC_URL ?? 'http://localhost:9000/ethiopialearn');
  const wake = origins(env.NEXT_PUBLIC_WAKE_URLS);
  // Presigned uploads and signed video URLs. Locally that's MinIO, the same
  // host as the public storage URL, so that is the default.
  const media = env.NEXT_PUBLIC_MEDIA_ORIGINS ? origins(env.NEXT_PUBLIC_MEDIA_ORIGINS) : storage;

  /** @type {[string, (string | false | undefined)[]][]} */
  const directives = [
    ['default-src', ["'self'"]],
    // 'unsafe-inline': static and ISR pages can't carry a nonce, and Next's
    // inline flight scripts change per build. 'wasm-unsafe-eval': mediapipe.
    // 'unsafe-eval' only under `next dev` (webpack's eval builds, React Refresh).
    [
      'script-src',
      ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", env.NODE_ENV === 'development' && "'unsafe-eval'", google && GOOGLE.script],
    ],
    ['style-src', ["'self'", "'unsafe-inline'", google && GOOGLE.style]],
    ['img-src', ["'self'", 'data:', 'blob:', ...storage, google && GOOGLE.avatars]],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", ...api, ...wake, ...media, google && GOOGLE.gsi]],
    ['media-src', ["'self'", 'blob:', ...media]],
    ['worker-src', ["'self'", 'blob:']],
    ['frame-src', [google ? GOOGLE.gsi : "'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['manifest-src', ["'self'"]],
    ['report-uri', [CSP_REPORT_PATH]],
    ['report-to', [REPORT_GROUP]],
  ];
  if (isVercelProduction(env)) directives.push(['upgrade-insecure-requests', []]);

  return directives.map(([name, sources]) => [name, ...unique(sources)].join(' ')).join('; ');
}

/**
 * Every header the web app sends on every response.
 * @param {Record<string, string | undefined>} env
 * @returns {{ key: string, value: string }[]}
 */
export function securityHeaders(env) {
  const headers = [
    { key: cspEnforced(env) ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', value: buildCsp(env) },
    { key: 'Reporting-Endpoints', value: `${REPORT_GROUP}="${CSP_REPORT_PATH}"` },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // For browsers without frame-ancestors (and frame-ancestors is ignored in Report-Only).
    { key: 'X-Frame-Options', value: 'DENY' },
    // The camera is for exam proctoring; the viva is typed, so no microphone.
    { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=()' },
    // Google sign-in may open a popup that reports back to this window.
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  ];
  // No preload until there's a custom domain.
  if (isVercelProduction(env)) headers.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' });
  return headers;
}
