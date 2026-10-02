import { isKnownDevValue } from '@ethiopialearn/common';

export const MIN_WEBHOOK_SECRET_LENGTH = 16;

/**
 * Financial's production rules (P1-03), checked at boot through
 * assertProductionConfig, which runs them only when NODE_ENV=production. Mock
 * mode forges signed webhooks, so production must run live with a real Chapa
 * secret key and the webhook secret hash from the Chapa dashboard. Problems
 * name the variable, never its value.
 */
export function chapaProductionProblems(environment: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if (environment.CHAPA_MODE !== 'live') problems.push('CHAPA_MODE must be live in production (mock mode forges webhooks)');

  const key = environment.CHAPA_SECRET_KEY ?? '';
  if (!key) problems.push('CHAPA_SECRET_KEY is not set');
  else if (!key.startsWith('CHASECK')) problems.push('CHAPA_SECRET_KEY is not a Chapa secret key (it should start with CHASECK)');

  const secret = environment.CHAPA_WEBHOOK_SECRET ?? '';
  if (!secret) problems.push('CHAPA_WEBHOOK_SECRET is not set');
  else if (isKnownDevValue(secret)) problems.push('CHAPA_WEBHOOK_SECRET is a development default from the repo');
  else if (secret.length < MIN_WEBHOOK_SECRET_LENGTH) problems.push(`CHAPA_WEBHOOK_SECRET is shorter than ${MIN_WEBHOOK_SECRET_LENGTH} characters`);
  return problems;
}

/** Allowed in production, but worth saying at boot. */
export function chapaProductionWarnings(environment: NodeJS.ProcessEnv): string[] {
  if (environment.NODE_ENV !== 'production') return [];
  if ((environment.CHAPA_SECRET_KEY ?? '').startsWith('CHASECK_TEST')) {
    return ['CHAPA_SECRET_KEY is a Chapa TEST key: checkouts will not collect real money'];
  }
  return [];
}
