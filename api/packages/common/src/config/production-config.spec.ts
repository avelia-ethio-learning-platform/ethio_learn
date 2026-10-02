import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { assertProductionConfig, isKnownDevValue, productionConfigProblems } from './production-config';

const API_ROOT = join(__dirname, '../../../..');
const REPO_ROOT = join(API_ROOT, '..');

/** `KEY=value` pairs from api/.env.example: the dev values the repo ships. */
function envExample(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(API_ROOT, '.env.example'), 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/** Values docker-compose.yml gives the services: `KEY: value` and `KEY: ${KEY:-default}`. */
function composeDefaults(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8').matchAll(/^\s+([A-Z0-9_]+): (?:\$\{[A-Z0-9_]+:-([^}]*)\}|([^\s$#][^\s#]*))\s*$/gm)) {
    const v = m[2] ?? m[3];
    if (v) out[m[1]] = v;
  }
  return out;
}

const strong = () => randomBytes(32).toString('base64url'); // 43 characters

function prodEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    INTERNAL_API_TOKEN: strong(),
    JWT_SECRET: strong(),
    CERT_SIGNING_SECRET: strong(),
    REQUIRE_INTERNAL_TOKEN: 'true',
    WEB_URL: 'https://app.example.test',
    GATEWAY_PUBLIC_URL: 'https://api.example.test',
    S3_ENDPOINT: 'https://s3.example.test',
    S3_ACCESS_KEY: 'AKIAEXAMPLEEXAMPLE01',
    S3_SECRET_KEY: strong(),
    ...overrides,
  };
}

const auth = { service: 'auth', secrets: ['JWT_SECRET'] };
const outcomes = { service: 'outcomes', secrets: ['CERT_SIGNING_SECRET'], storage: true };

describe('productionConfigProblems', () => {
  it('is a no-op outside production, whatever the values', () => {
    const env = { NODE_ENV: 'development', ...envExample(), REQUIRE_INTERNAL_TOKEN: 'false', INTERNAL_API_TOKEN: '' };
    expect(productionConfigProblems(auth, env)).toEqual([]);
    expect(productionConfigProblems(auth, { ...env, NODE_ENV: undefined })).toEqual([]);
  });

  it('accepts a complete production configuration', () => {
    expect(productionConfigProblems(auth, prodEnv())).toEqual([]);
    expect(productionConfigProblems(outcomes, prodEnv())).toEqual([]);
    expect(productionConfigProblems({ service: 'gateway', secrets: ['JWT_SECRET'] }, prodEnv({ REQUIRE_INTERNAL_TOKEN: undefined }))).toEqual([]);
  });

  it.each([
    ['missing', undefined, 'INTERNAL_API_TOKEN is not set'],
    ['empty', '', 'INTERNAL_API_TOKEN is not set'],
    ['short', 'a'.repeat(31), 'INTERNAL_API_TOKEN is shorter than 32 characters'],
  ])('requires INTERNAL_API_TOKEN on every service (%s)', (_case, value, problem) => {
    expect(productionConfigProblems({ service: 'course' }, prodEnv({ INTERNAL_API_TOKEN: value }))).toEqual([problem]);
  });

  it('checks the secrets the service lists', () => {
    expect(productionConfigProblems(auth, prodEnv({ JWT_SECRET: undefined }))).toEqual(['JWT_SECRET is not set']);
    expect(productionConfigProblems({ service: 'course' }, prodEnv({ JWT_SECRET: undefined }))).toEqual([]);
  });

  it.each(['JWT_SECRET', 'CERT_SIGNING_SECRET', 'INTERNAL_API_TOKEN', 'CHAPA_WEBHOOK_SECRET', 'SEED_PASSWORD'])(
    'knows the .env.example value of %s',
    (name) => {
      const value = envExample()[name];
      expect(value).toBeTruthy();
      expect(isKnownDevValue(value)).toBe(true);
      expect(productionConfigProblems(auth, prodEnv({ JWT_SECRET: value }))).toEqual(['JWT_SECRET is a development default from the repo']);
    },
  );

  it.each(['JWT_SECRET', 'CERT_SIGNING_SECRET', 'INTERNAL_API_TOKEN', 'CHAPA_WEBHOOK_SECRET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'])(
    'knows the docker-compose value of %s',
    (name) => {
      const value = composeDefaults()[name];
      expect(value).toBeTruthy();
      expect(isKnownDevValue(value)).toBe(true);
    },
  );

  it('does not flag other values', () => {
    expect(isKnownDevValue(strong())).toBe(false);
  });

  it.each(['false', '0', 'no'])('refuses REQUIRE_INTERNAL_TOKEN=%s', (value) => {
    expect(productionConfigProblems(auth, prodEnv({ REQUIRE_INTERNAL_TOKEN: value }))).toEqual([
      'REQUIRE_INTERNAL_TOKEN is turned off (leave it unset or set it to true)',
    ]);
  });

  it.each([
    ['WEB_URL', 'http://localhost:3000', 'WEB_URL points at localhost'],
    ['WEB_URL', 'http://127.0.0.1:3000', 'WEB_URL points at localhost'],
    ['GATEWAY_PUBLIC_URL', 'http://[::1]:4000', 'GATEWAY_PUBLIC_URL points at localhost'],
    ['GATEWAY_PUBLIC_URL', undefined, 'GATEWAY_PUBLIC_URL is not set'],
    ['WEB_URL', 'app.example.test', 'WEB_URL is not a valid URL'],
  ])('checks %s=%s', (name, value, problem) => {
    expect(productionConfigProblems(auth, prodEnv({ [name]: value }))).toEqual([problem]);
  });

  it('requires CERT_SIGNING_SECRET to differ from JWT_SECRET', () => {
    const shared = strong();
    expect(productionConfigProblems(outcomes, prodEnv({ JWT_SECRET: shared, CERT_SIGNING_SECRET: shared }))).toEqual([
      'CERT_SIGNING_SECRET must differ from JWT_SECRET',
    ]);
  });

  it('checks the S3 keys only for storage services with an S3 endpoint', () => {
    const minio = composeDefaults().S3_SECRET_KEY;
    expect(productionConfigProblems(outcomes, prodEnv({ S3_ACCESS_KEY: undefined, S3_SECRET_KEY: minio }))).toEqual([
      'S3_ACCESS_KEY is not set',
      'S3_SECRET_KEY is a development default from the repo',
    ]);
    expect(productionConfigProblems(outcomes, prodEnv({ S3_ENDPOINT: undefined, S3_ACCESS_KEY: undefined }))).toEqual([]);
    expect(productionConfigProblems(auth, prodEnv({ S3_ACCESS_KEY: undefined }))).toEqual([]);
  });
});

describe('productionConfigProblems: service rules', () => {
  const rules = jest.fn((environment: NodeJS.ProcessEnv) => (environment.CHAPA_MODE === 'live' ? [] : ['CHAPA_MODE must be live']));

  it("adds a service's own rules to the shared ones in production", () => {
    expect(productionConfigProblems({ service: 'financial', rules }, prodEnv({ INTERNAL_API_TOKEN: undefined }))).toEqual([
      'INTERNAL_API_TOKEN is not set',
      'CHAPA_MODE must be live',
    ]);
    expect(productionConfigProblems({ service: 'financial', rules }, prodEnv({ CHAPA_MODE: 'live' }))).toEqual([]);
  });

  it('never runs them outside production', () => {
    rules.mockClear();
    expect(productionConfigProblems({ service: 'financial', rules }, { NODE_ENV: 'development' })).toEqual([]);
    expect(rules).not.toHaveBeenCalled();
  });
});

describe('assertProductionConfig', () => {
  it('does nothing when the configuration is fine', () => {
    expect(() => assertProductionConfig(auth, prodEnv())).not.toThrow();
  });

  it('lists every problem by variable name and never prints a value', () => {
    const devToken = envExample().INTERNAL_API_TOKEN;
    const short = 'b'.repeat(20);
    let message = '';
    try {
      assertProductionConfig(outcomes, prodEnv({ INTERNAL_API_TOKEN: devToken, CERT_SIGNING_SECRET: short, REQUIRE_INTERNAL_TOKEN: 'false' }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('outcomes refuses to start in production');
    expect(message).toContain('INTERNAL_API_TOKEN is a development default from the repo');
    expect(message).toContain('CERT_SIGNING_SECRET is shorter than 32 characters');
    expect(message).toContain('REQUIRE_INTERNAL_TOKEN is turned off');
    expect(message).not.toContain(short);
    expect(message).not.toContain(devToken);
  });
});
