import { isUuid } from '../context';

/**
 * Route segments whose next segment is a credential: `auth/invite/:token` (a
 * 7-day set-your-password link) and `pay-requests/:token` (`randomCode(24)`,
 * not hex). The token-route guard in no-pii-in-logs.spec.ts fails the build
 * when a controller adds a token param under any other parent.
 */
export const TOKEN_PARENTS: readonly string[] = ['invite', 'pay-requests'];

const HEX_TOKEN = /^[0-9a-f]{32,}$/i;
/** An address in free text, raw or percent-encoded (`name%40domain`). */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * A request path that is safe to log: no query string, and with each segment
 * decoded first (so `name%40domain` counts as an address) an address becomes
 * `[email]`; the segment after a TOKEN_PARENTS segment, any other non-UUID
 * segment of 32+ hex characters and any undecodable segment become `[token]`.
 * Course slugs and certificate uids (public verification codes) stay readable.
 */
export function redactPath(path: string): string {
  const end = path.search(/[?#]/);
  const segments = (end === -1 ? path : path.slice(0, end)).split('/');
  return segments
    .map((segment, i) => {
      if (segment === '') return segment;
      const value = decoded(segment);
      if (value === null) return '[token]';
      if (value.includes('@')) return '[email]';
      const parent = i > 0 ? decoded(segments[i - 1])?.toLowerCase() : undefined;
      if (parent !== undefined && TOKEN_PARENTS.includes(parent)) return '[token]';
      if (HEX_TOKEN.test(value) && !isUuid(value)) return '[token]';
      return segment;
    })
    .join('/');
}

/** `a***@example.com`: enough to tell two addresses apart in a log, not to write to one. */
export function maskEmail(email: string | null | undefined): string {
  const value = String(email ?? '');
  const at = value.lastIndexOf('@');
  if (at < 1) return '***';
  return `${value[0]}***${value.slice(at)}`;
}

/** Free text (a provider's reason, an error message) with every address replaced by `[email]`. */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_IN_TEXT, '[email]');
}
