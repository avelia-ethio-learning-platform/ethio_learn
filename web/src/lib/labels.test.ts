import { describe, expect, it } from 'vitest';
import { categoryLabel, pricingLabel, roleLabel, statusLabel } from './labels';

describe('labels', () => {
  it('statusLabel gives a sentence-case label and the badge class for known values', () => {
    expect(statusLabel('under_review')).toEqual({ label: 'Under review', tone: 'badge-warn' });
    expect(statusLabel('published')).toEqual({ label: 'Published', tone: 'badge-success' });
    expect(statusLabel('banned').tone).toBe('badge-danger');
    expect(statusLabel('institution_review').tone).toBe('badge-info');
  });

  it('statusLabel falls back to sentence case and a neutral badge for unknown values', () => {
    expect(statusLabel('waiting_for_bank')).toEqual({ label: 'Waiting for bank', tone: 'badge-neutral' });
  });

  it('roleLabel covers every role and falls back for unknown ones', () => {
    expect(roleLabel('institution_admin')).toBe('Institution admin');
    expect(roleLabel('quality_officer')).toBe('Quality officer');
    expect(roleLabel('platform_admin')).toBe('Platform admin');
    expect(roleLabel('learner')).toBe('Learner');
    expect(roleLabel('educator')).toBe('Educator');
    expect(roleLabel('super_user')).toBe('Super user');
  });

  it('pricingLabel and categoryLabel use curated names then the fallback', () => {
    expect(pricingLabel('freemium')).toBe('Free preview');
    expect(pricingLabel('paid')).toBe('Paid');
    expect(pricingLabel('pay_what_you_want')).toBe('Pay what you want');
    expect(categoryLabel('web_development')).toBe('Web Development');
    expect(categoryLabel('quantum_physics')).toBe('Quantum physics');
  });
});
