import { timingSafeEqual } from 'crypto';
import { env } from '@ethiopialearn/common';

/** Length-checked, timing-safe; an unset secret matches nothing. */
export function matchesSecret(presented: string | undefined, expected: string): boolean {
  if (!expected || !presented || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

/** The scheduler's token (JOBS_TOKEN, set on the gateway only): `Authorization: Bearer <token>`. */
export function validJobsToken(authorization: string | undefined): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  return matchesSecret(authorization.slice(7), env('JOBS_TOKEN', ''));
}
