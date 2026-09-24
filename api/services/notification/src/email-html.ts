/**
 * Email bodies are HTML, and almost every value put into one is user text:
 * course titles, names, reviewer notes, gift messages, change-log summaries.
 * Escaping each value by hand missed some, so a course title or summary could
 * put a live link or a tracking pixel into a platform-branded email.
 *
 * `html` is a tagged template that escapes every interpolated value unless the
 * value is itself SafeHtml, i.e. markup built by `html`. A template therefore
 * cannot insert raw markup by accident, and layout() only accepts SafeHtml, so
 * a body built from a plain template string does not type-check.
 */

/** Course titles and reviewer notes are user text; never let them inject markup into an email. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Markup that is safe to put in an email as it is: built by `html` from escaped values. */
export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

/** null, undefined and false render as nothing, so `${cond && html`...`}` works. Arrays render each item. */
type HtmlValue = SafeHtml | string | number | boolean | null | undefined | readonly HtmlValue[];

function render(value: HtmlValue): string {
  if (value instanceof SafeHtml) return value.value;
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0];
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1];
  });
  return new SafeHtml(out);
}
