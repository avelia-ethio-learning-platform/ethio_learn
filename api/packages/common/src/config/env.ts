export function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * For infrastructure URLs that have a localhost default for local development.
 * In production a missing value is fatal: falling back to localhost there means
 * connecting to nothing inside the container, which surfaces as an opaque
 * ECONNREFUSED retry loop instead of naming the variable that was never set.
 */
export function envOrLocalDefault(name: string, localDefault: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `Missing required environment variable ${name}. It has no production default — ` +
        `set it on the service (or its shared env group) and redeploy.`,
    );
  }
  return localDefault;
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  return parsed;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}
