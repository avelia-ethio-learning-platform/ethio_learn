import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { assertProductionConfig } from '@ethiopialearn/common';
import { chapaProductionProblems, chapaProductionWarnings } from './production-rules';

/** The webhook secret api/.env.example ships for local development. */
function devWebhookSecret(): string {
  const line = readFileSync(join(__dirname, '../../../.env.example'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('CHAPA_WEBHOOK_SECRET='));
  if (!line) throw new Error('api/.env.example has no CHAPA_WEBHOOK_SECRET');
  return line.slice('CHAPA_WEBHOOK_SECRET='.length).trim();
}

const prod = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  CHAPA_MODE: 'live',
  CHAPA_SECRET_KEY: `CHASECK-${randomBytes(12).toString('hex')}`,
  CHAPA_WEBHOOK_SECRET: randomBytes(16).toString('hex'),
  ...overrides,
});

describe('chapaProductionProblems', () => {
  it('accepts a live configuration with a real key and webhook secret', () => {
    expect(chapaProductionProblems(prod())).toEqual([]);
  });

  it.each([
    ['mock mode', { CHAPA_MODE: 'mock' }, 'CHAPA_MODE must be live in production (mock mode forges webhooks)'],
    ['mode left to inference', { CHAPA_MODE: undefined }, 'CHAPA_MODE must be live in production (mock mode forges webhooks)'],
    ['no secret key', { CHAPA_SECRET_KEY: undefined }, 'CHAPA_SECRET_KEY is not set'],
    ['not a Chapa secret key', { CHAPA_SECRET_KEY: 'CHAPUBK-public-key' }, 'CHAPA_SECRET_KEY is not a Chapa secret key (it should start with CHASECK)'],
    ['no webhook secret', { CHAPA_WEBHOOK_SECRET: undefined }, 'CHAPA_WEBHOOK_SECRET is not set'],
    ['short webhook secret', { CHAPA_WEBHOOK_SECRET: 'a'.repeat(15) }, 'CHAPA_WEBHOOK_SECRET is shorter than 16 characters'],
  ])('refuses %s', (_case, overrides, problem) => {
    expect(chapaProductionProblems(prod(overrides))).toEqual([problem]);
  });

  it('refuses the webhook secret the repo ships for development', () => {
    expect(chapaProductionProblems(prod({ CHAPA_WEBHOOK_SECRET: devWebhookSecret() }))).toEqual([
      'CHAPA_WEBHOOK_SECRET is a development default from the repo',
    ]);
  });

  it('through assertProductionConfig, names the variables and never their values', () => {
    const secret = 'short-secret';
    const environment = prod({ CHAPA_MODE: 'mock', CHAPA_WEBHOOK_SECRET: secret, INTERNAL_API_TOKEN: randomBytes(24).toString('hex'), WEB_URL: 'https://a.example', GATEWAY_PUBLIC_URL: 'https://b.example' });
    let message = '';
    try {
      assertProductionConfig({ service: 'financial', rules: chapaProductionProblems }, environment);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('CHAPA_MODE must be live');
    expect(message).toContain('CHAPA_WEBHOOK_SECRET is shorter than 16 characters');
    expect(message).not.toContain(secret);
  });
});

describe('chapaProductionWarnings', () => {
  it('warns about a Chapa test key in production, and only there', () => {
    expect(chapaProductionWarnings(prod({ CHAPA_SECRET_KEY: 'CHASECK_TEST-abc' }))).toEqual([
      'CHAPA_SECRET_KEY is a Chapa TEST key: checkouts will not collect real money',
    ]);
    expect(chapaProductionWarnings(prod())).toEqual([]);
    expect(chapaProductionWarnings({ NODE_ENV: 'development', CHAPA_SECRET_KEY: 'CHASECK_TEST-abc' })).toEqual([]);
  });
});
