/**
 * A production build needs WEB_PROXY_SECRET (Phase 11b): without it, or with a
 * value the gateway doesn't share, the gateway keys every user's login and
 * refresh limits by Vercel's own addresses, and real traffic locks everyone
 * out. Called from next.config.mjs, so a Vercel production build fails instead.
 *
 * @param {Record<string, string | undefined>} env
 */
export function assertProxySecret(env) {
  if (env.VERCEL_ENV !== 'production') return;
  const secret = (env.WEB_PROXY_SECRET ?? '').trim();
  if (secret.length < 32) {
    throw new Error(
      `WEB_PROXY_SECRET must be at least 32 characters for a production build (it is ${secret ? `${secret.length} characters` : 'unset'}). ` +
        'Set the same value in Vercel → Project → Settings → Environment Variables (Production) and on the Render gateway, then redeploy.',
    );
  }
}
