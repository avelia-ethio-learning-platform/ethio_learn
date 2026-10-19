import { timingSafeEqual } from 'crypto';
import { env } from '@ethiopialearn/common';

/** Length-checked (in bytes, so a non-ASCII header can't throw), timing-safe; an unset secret matches nothing. */
export function matchesSecret(presented: string | undefined, expected: string): boolean {
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The scheduler's token (JOBS_TOKEN, set on the gateway only): `Authorization: Bearer <token>`. */
export function validJobsToken(authorization: string | undefined): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  return matchesSecret(authorization.slice(7), env('JOBS_TOKEN', ''));
}
