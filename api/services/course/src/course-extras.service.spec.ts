import { chunkText } from './course-extras.service';

describe('chunkText (tutor knowledge base)', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n ')).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    expect(chunkText('Hello world. This is short.')).toEqual(['Hello world. This is short.']);
  });

  it('splits long text at sentence boundaries under the size limit', () => {
    const sentence = 'Variables store values in memory and can be reassigned later in the program. ';
    const text = sentence.repeat(40); // ~3200 chars
    const chunks = chunkText(text, 800);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(800);
      expect(c.endsWith('.')).toBe(true); // never cut mid-sentence
    }
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.trim().replace(/\s+/g, ' '));
  });

  it('handles Amharic sentence terminators (።) and paragraphs', () => {
    const am = 'ተማሪዎች ትምህርታቸውን ይማራሉ። መምህራን ያስተምራሉ።';
    const chunks = chunkText(`${am}\n\n${'Next paragraph. '.repeat(3)}`);
    expect(chunks.join(' ')).toContain('።');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('hard-splits a single oversized sentence rather than dropping it', () => {
    const huge = 'x'.repeat(2000);
    const chunks = chunkText(huge, 800);
    expect(chunks.join('')).toHaveLength(2000);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(800);
  });
});
