import { describe, expect, it } from 'vitest';
import { jsonLdScript } from './json-ld';

describe('jsonLdScript', () => {
  const evil = { '@type': 'Course', name: 'Go', description: 'Learn </script><script>alert(1)</script> <!-- now' };

  it('cannot close the script tag or open a comment', () => {
    const out = jsonLdScript(evil);
    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('<');
  });

  it('still parses to the same data', () => {
    expect(JSON.parse(jsonLdScript(evil))).toEqual(evil);
  });
});
