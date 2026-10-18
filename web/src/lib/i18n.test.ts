import { describe, expect, it } from 'vitest';
import { en } from './i18n-en';
import { am } from './i18n-am';
import { translate } from './i18n';

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

describe('i18n dictionaries', () => {
  it('en and am cover exactly the same keys', () => {
    expect(Object.keys(am).sort()).toEqual(Object.keys(en).sort());
  });

  it('no translation is empty', () => {
    for (const [locale, dict] of Object.entries({ en, am })) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${locale}.${key}`).not.toBe('');
      }
    }
  });

  it('each Amharic value keeps its English placeholders', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(placeholders(am[key as keyof typeof en]), key).toEqual(placeholders(value));
    }
  });
});

describe('translate', () => {
  it('fills placeholders and leaves unknown ones', () => {
    const dict = { ...en, back: 'Back to {page} ({missing})' };
    expect(translate(dict, 'back', { page: 'courses' })).toBe('Back to courses ({missing})');
  });
});
