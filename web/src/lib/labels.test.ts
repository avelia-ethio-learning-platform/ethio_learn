import { describe, expect, it } from 'vitest';
import { assessmentTypeLabel, categoryLabel, pricingLabel, refundRuleLabel, roleLabel, statusLabel } from './labels';

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
    expect(categoryLabel(null)).toBe('Other');
    expect(categoryLabel('')).toBe('Other');
  });

  it('assessmentTypeLabel names every assessment type, then falls back to sentence case', () => {
    expect(assessmentTypeLabel('quiz')).toBe('Quiz');
    expect(assessmentTypeLabel('ai_viva')).toBe('AI viva');
    expect(assessmentTypeLabel('project')).toBe('Project');
    expect(assessmentTypeLabel('oral_exam')).toBe('Oral exam');
  });

  it('refundRuleLabel gives a reason for every rule the engine uses, and nothing raw for others', () => {
    for (const rule of [
      'auto_approve_under_20pct_within_7d',
      'manual_review_20_to_50pct',
      'over_50pct_consumed',
      'outside_7_day_window',
      'certificate_already_issued',
      'assessment_already_passed',
    ]) {
      expect(refundRuleLabel(rule), rule).not.toBe('');
      expect(refundRuleLabel(rule), rule).not.toContain('_');
    }
    expect(refundRuleLabel('some_new_rule')).toBe('');
  });
});
