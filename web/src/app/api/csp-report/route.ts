/**
 * Browsers post Content Security Policy violation reports here, through the
 * policy's `report-uri` and `report-to` (lib/csp.mjs). They go to the function
 * log, where the user reviews them before setting CSP_ENFORCE=true.
 *
 * The route is public, so it's bounded: a body over 8 KB is refused, and after
 * its first 100 reports an instance logs 1 in 10. URLs are logged without
 * their query, because signed storage URLs carry their signature there.
 */
const MAX_BYTES = 8 * 1024;
const LOG_ALL_FIRST = 100;
const SAMPLE_EVERY = 10;

let received = 0;

/** The body as text, or null when it's over `max` bytes. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function withoutQuery(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  return url.split(/[?#]/)[0].slice(0, 300);
}

type Fields = Record<string, unknown>;

/** The fields worth keeping from either format: `{ "csp-report": {…} }` (report-uri) or `[{ type, body }]` (report-to). */
function summarize(text: string): Fields[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [{ unparsable: true }];
  }
  const reports: Fields[] = Array.isArray(parsed)
    ? parsed.map((r: Fields) => (r?.body ?? {}) as Fields)
    : [((parsed as Fields)?.['csp-report'] ?? {}) as Fields];
  return reports.slice(0, 10).map((r) => ({
    page: withoutQuery(r['document-uri'] ?? r.documentURL),
    directive: r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'],
    blocked: withoutQuery(r['blocked-uri'] ?? r.blockedURL),
    source: withoutQuery(r['source-file'] ?? r.sourceFile),
    line: r['line-number'] ?? r.lineNumber,
    disposition: r.disposition,
  }));
}

export async function POST(req: Request): Promise<Response> {
  const body = await readCapped(req, MAX_BYTES);
  if (body === null) return new Response(null, { status: 413 });
  received += 1;
  if (received <= LOG_ALL_FIRST || received % SAMPLE_EVERY === 0) {
    for (const report of summarize(body)) console.warn(`csp-report ${JSON.stringify(report)}`);
  }
  return new Response(null, { status: 204 });
}
