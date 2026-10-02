import { createHash } from 'crypto';

export interface ProductionConfigSpec {
  service: string;
  /**
   * Generated secrets this service reads besides INTERNAL_API_TOKEN (which
   * every service needs): set, at least 32 characters, not a dev value.
   */
  secrets?: readonly string[];
  /** Talks to S3 storage: with S3_ENDPOINT set, the keys must be real ones. */
  storage?: boolean;
  /** The service's own rules (financial: Chapa live mode and keys), one problem per line, never values. */
  rules?: (environment: NodeJS.ProcessEnv) => string[];
}

export const MIN_SECRET_LENGTH = 32;

/**
 * SHA-256 digests of the development values that ship in the repo: the
 * `api/.env.example` and docker-compose defaults for JWT_SECRET,
 * CERT_SIGNING_SECRET, INTERNAL_API_TOKEN, CHAPA_WEBHOOK_SECRET and
 * SEED_PASSWORD, and the local MinIO key the storage package falls back to.
 * Digests rather than the literals, so this list never spreads the values any
 * further. production-config.spec.ts checks it against `.env.example`.
 */
const DEV_VALUE_DIGESTS = new Set([
  '0907ae7f6687ec7082380874a503c5df5a8a822670739d0b17634e7d1c69b2f8',
  '2d4bac54392fe45f907207fa175af55e9c63521604a521c76afb343e33c71667',
  'cb9b211fa3c2298a6d52c7f66015cb8bd62ba6c612248445573fb31d4b3c54fe',
  '3d2a5532df4637e6a59a2105aac215fa5e95b50b98c21d480b50510e96d7ee30',
  'a109e36947ad56de1dca1cc49f0ef8ac9ad9a7b1aa0df41fb3c4cb73c1ff01ea',
  'ad9858116e63b0c5a4d7dc7f50f034c7247e56838dae22c1832712ffde48e694',
]);

export function isKnownDevValue(value: string): boolean {
  return DEV_VALUE_DIGESTS.has(createHash('sha256').update(value).digest('hex'));
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i;

/**
 * Every production misconfiguration of `spec`'s service, one line each. Lines
 * name the variable and the rule it breaks, never the value. Empty outside
 * production (NODE_ENV !== 'production'), so local dev and CI are unaffected.
 */
export function productionConfigProblems(spec: ProductionConfigSpec, environment: NodeJS.ProcessEnv = process.env): string[] {
  if (environment.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  const value = (name: string) => environment[name] ?? '';

  const secret = (name: string) => {
    const v = value(name);
    if (!v) problems.push(`${name} is not set`);
    else if (isKnownDevValue(v)) problems.push(`${name} is a development default from the repo`);
    else if (v.length < MIN_SECRET_LENGTH) problems.push(`${name} is shorter than ${MIN_SECRET_LENGTH} characters`);
  };
  for (const name of new Set(['INTERNAL_API_TOKEN', ...(spec.secrets ?? [])])) secret(name);

  if (spec.secrets?.includes('CERT_SIGNING_SECRET') && value('CERT_SIGNING_SECRET') && value('CERT_SIGNING_SECRET') === value('JWT_SECRET')) {
    problems.push('CERT_SIGNING_SECRET must differ from JWT_SECRET');
  }

  const requireToken = value('REQUIRE_INTERNAL_TOKEN');
  if (requireToken !== '' && requireToken !== 'true' && requireToken !== '1') {
    problems.push('REQUIRE_INTERNAL_TOKEN is turned off (leave it unset or set it to true)');
  }

  for (const name of ['WEB_URL', 'GATEWAY_PUBLIC_URL']) {
    const v = value(name);
    let host: string | undefined;
    try {
      host = new URL(v).hostname;
    } catch {
      problems.push(v ? `${name} is not a valid URL` : `${name} is not set`);
      continue;
    }
    if (LOCAL_HOST.test(host)) problems.push(`${name} points at localhost`);
  }

  if (spec.storage && value('S3_ENDPOINT')) {
    for (const name of ['S3_ACCESS_KEY', 'S3_SECRET_KEY']) {
      const v = value(name);
      if (!v) problems.push(`${name} is not set`);
      else if (isKnownDevValue(v)) problems.push(`${name} is a development default from the repo`);
    }
  }
  if (spec.rules) problems.push(...spec.rules(environment));
  return problems;
}

/**
 * Fail fast at boot instead of running production with a guessable secret or
 * the gateway-only check switched off. Call before anything else starts.
 */
export function assertProductionConfig(spec: ProductionConfigSpec, environment: NodeJS.ProcessEnv = process.env): void {
  const problems = productionConfigProblems(spec, environment);
  if (problems.length === 0) return;
  throw new Error(
    `${spec.service} refuses to start in production with unsafe configuration:\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\nSet these on the service (or its shared env group) and redeploy.',
  );
}
