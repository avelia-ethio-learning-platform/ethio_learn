'use client';

import { Check, Circle } from 'lucide-react';
import { useT, type TKey } from '@/lib/i18n';

const CATEGORIES = [
  { re: /[a-z]/, text: 'lowercase' },
  { re: /[A-Z]/, text: 'uppercase' },
  { re: /\d/, text: 'number' },
  { re: /[^A-Za-z0-9]/, text: 'symbol' },
];

/**
 * Mirrors the server rule (api/services/auth/src/dto.ts, IsStrongPassword):
 * 8 to 128 characters and at least 3 of 4 categories. `ok` is what forms gate on.
 */
export function scorePassword(pw: string) {
  const lengthOk = pw.length >= 8;
  const categories = CATEGORIES.map((c) => ({ ok: c.re.test(pw), text: c.text }));
  const count = categories.filter((c) => c.ok).length;
  const ok = lengthOk && pw.length <= 128 && count >= 3;
  // Meter bars: categories met, held at 2 until the password is long enough.
  const score = lengthOk ? count : Math.min(count, 2);
  const label = !pw ? 'Very weak' : !ok ? 'Weak' : count === 4 ? 'Strong' : 'Good';
  return { ok, score, label, lengthOk, categoriesMet: count, categories };
}

const STRENGTH_KEY: Record<string, TKey> = { 'Very weak': 'strength_very_weak', Weak: 'strength_weak', Good: 'strength_good', Strong: 'strength_strong' };
const CATEGORY_KEY: Record<string, TKey> = { lowercase: 'pw_lowercase', uppercase: 'pw_uppercase', number: 'pw_number', symbol: 'pw_symbol' };

export function PasswordStrength({ value }: { value: string }) {
  const { t } = useT();
  if (!value) return null;
  const { score, label, lengthOk, categoriesMet, categories } = scorePassword(value);
  const colors = ['bg-red-500', 'bg-red-500', 'bg-amber-500', 'bg-yellow-500', 'bg-green-600'];
  const tone = (ok: boolean) => (ok ? 'text-green-700 dark:text-green-400' : 'text-gray-500');
  const mark = (ok: boolean) => (
    <>
      {ok ? <Check className="mr-1 inline h-3 w-3" aria-hidden="true" /> : <Circle className="mr-1 inline h-3 w-3" aria-hidden="true" />}
      <span className="sr-only">{t(ok ? 'pw_met' : 'pw_not_met')} </span>
    </>
  );
  return (
    <div className="mt-2">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`h-1.5 flex-1 rounded ${i < score ? colors[score] : 'bg-gray-200'}`} />
        ))}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {t('strength')} <span className="font-medium">{t(STRENGTH_KEY[label])}</span>
      </p>
      <ul className="mt-1 space-y-0.5 text-xs">
        <li className={tone(lengthOk)}>
          {mark(lengthOk)}
          {t('pw_at_least_8')}
        </li>
        <li className={tone(categoriesMet >= 3)}>
          {mark(categoriesMet >= 3)}
          {t('pw_three_of_four')}
          <ul className="ml-4 mt-0.5 flex flex-wrap gap-x-3">
            {categories.map((c) => (
              <li key={c.text} className={tone(c.ok)}>
                {mark(c.ok)}
                {t(CATEGORY_KEY[c.text])}
              </li>
            ))}
          </ul>
        </li>
      </ul>
    </div>
  );
}
