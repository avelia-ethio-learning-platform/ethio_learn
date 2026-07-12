'use client';

/** Password strength meter + rule hints. Purely client-side UX. */
export function scorePassword(pw: string): { score: number; label: string; checks: { ok: boolean; text: string }[] } {
  const checks = [
    { ok: pw.length >= 8, text: 'At least 8 characters' },
    { ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw), text: 'Upper and lower case letters' },
    { ok: /\d/.test(pw), text: 'A number' },
    { ok: /[^A-Za-z0-9]/.test(pw), text: 'A symbol' },
  ];
  const score = checks.filter((c) => c.ok).length;
  const label = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][score];
  return { score, label, checks };
}

export function PasswordStrength({ value }: { value: string }) {
  if (!value) return null;
  const { score, label, checks } = scorePassword(value);
  const colors = ['bg-red-500', 'bg-red-500', 'bg-amber-500', 'bg-yellow-500', 'bg-green-600'];
  return (
    <div className="mt-2">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`h-1.5 flex-1 rounded ${i < score ? colors[score] : 'bg-gray-200'}`} />
        ))}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Strength: <span className="font-medium">{label}</span>
      </p>
      <ul className="mt-1 space-y-0.5 text-xs">
        {checks.map((c) => (
          <li key={c.text} className={c.ok ? 'text-green-600' : 'text-gray-400'}>
            {c.ok ? '✓' : '○'} {c.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
