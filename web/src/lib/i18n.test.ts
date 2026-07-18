import { describe, expect, it } from 'vitest';
import { dictionaries } from './i18n';

describe('i18n dictionaries', () => {
  it('en and am cover exactly the same keys', () => {
    const en = Object.keys(dictionaries.en).sort();
    const am = Object.keys(dictionaries.am).sort();
    expect(am).toEqual(en);
  });

  it('no translation is empty', () => {
    for (const [locale, dict] of Object.entries(dictionaries)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${locale}.${key}`).not.toBe('');
      }
    }
  });
});
