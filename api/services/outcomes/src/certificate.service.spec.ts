import { createHmac } from 'crypto';
import { CertificateService } from './certificate.service';

const SECRET = 'test-cert-secret';

function certRow(uid: string, signature: string, invalidated = false) {
  return {
    id: 'cert-1',
    certificate_uid: uid,
    signature,
    invalidated,
    course_title: 'Course',
    learner_name: 'Learner',
    educator_name: 'Educator',
    issued_at: new Date('2026-01-01'),
    trust_tier_snapshot: 'trusted',
    assessment_badges: ['quiz'],
  };
}

function setup(row: Record<string, unknown> | null) {
  const certificates = { findOne: jest.fn().mockResolvedValue(row), find: jest.fn().mockResolvedValue([]) };
  const noop = { findOne: jest.fn(), find: jest.fn() };
  const bus = { subscribe: jest.fn(), publish: jest.fn() };
  const storage = { getSignedStreamUrl: jest.fn() };
  const internal = { get: jest.fn() };
  return new CertificateService(
    certificates as never,
    noop as never,
    noop as never,
    noop as never,
    bus as never,
    storage as never,
    internal as never,
  );
}

describe('CertificateService.verify (public tamper check, spec §9.4)', () => {
  beforeEach(() => {
    process.env.CERT_SIGNING_SECRET = SECRET;
  });

  const uid = 'abc-123';
  const goodSignature = () => createHmac('sha256', SECRET).update(uid).digest('hex');

  it('validates a genuine certificate and returns its public fields only', async () => {
    const service = setup(certRow(uid, goodSignature()));
    const result = await service.verify(uid);
    expect(result).toMatchObject({ valid: true, course_title: 'Course', learner_name: 'Learner', trust_tier: 'trusted' });
    // No internal ids leak through the public endpoint.
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('signature');
  });

  it('flags a tampered signature as invalid', async () => {
    const service = setup(certRow(uid, 'f'.repeat(64)));
    expect(await service.verify(uid)).toEqual({ valid: false });
  });

  it('flags a certificate whose stored uid was swapped (signature no longer matches)', async () => {
    const forged = certRow('some-other-uid', goodSignature());
    forged.certificate_uid = 'some-other-uid';
    const service = setup(forged);
    expect(await service.verify('some-other-uid')).toEqual({ valid: false });
  });

  it('treats unknown and invalidated certificates as invalid', async () => {
    expect(await setup(null).verify(uid)).toEqual({ valid: false });
    expect(await setup(certRow(uid, goodSignature(), true)).verify(uid)).toEqual({ valid: false });
  });
});
