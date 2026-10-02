/**
 * Serialize structured data for `<script type="application/ld+json">`.
 * `<` is escaped as `<` (still valid JSON for crawlers) so text such as
 * a course description can never close the script tag (P0-01).
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
