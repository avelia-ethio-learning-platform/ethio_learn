import { createHmac } from 'crypto';
import { QueryFailedError } from 'typeorm';
import { CertificateService } from './certificate.service';

// No spec here checks the QR image; a real one costs about 300 ms per certificate.
jest.mock('qrcode', () => ({ toBuffer: jest.fn().mockResolvedValue(Buffer.from('png')) }));

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

  it('refuses to sign without CERT_SIGNING_SECRET rather than falling back to another value', async () => {
    const jwtSecret = process.env.JWT_SECRET;
    delete process.env.CERT_SIGNING_SECRET;
    process.env.JWT_SECRET = 'some-jwt-secret';
    try {
      await expect(setup(certRow(uid, goodSignature())).verify(uid)).rejects.toThrow('Missing required environment variable: CERT_SIGNING_SECRET');
    } finally {
      if (jwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = jwtSecret;
    }
  });
});

describe('CertificateService.issue: a redelivered completion (P1-16)', () => {
  beforeEach(() => {
    process.env.CERT_SIGNING_SECRET = SECRET;
    // These specs are about the save, not the PDF: a real render made the race spec
    // time out at 5 s under the full suite.
    jest.spyOn(CertificateService.prototype as never, 'renderPdf').mockResolvedValue(Buffer.from('%PDF') as never);
  });
  afterEach(() => jest.restoreAllMocks());

  const completion = {
    enrollment_id: 'enr-1', learner_id: 'u1', learner_email: 'l@e.et', learner_name: 'Learner',
    course_id: 'c1', course_title: 'Course', educator_id: 'edu-1', educator_name: 'Educator', completed_at: '2026-10-03T00:00:00Z',
  };

  it('two deliveries racing past the existence check give one certificate, one CertificateIssued and no throw', async () => {
    const saved: unknown[] = [];
    const certificates = {
      findOne: jest.fn().mockResolvedValue(null), // both see no certificate yet
      create: jest.fn((row: object) => row),
      save: jest.fn(async (row: object) => {
        // The unique enrollment_id index lets the first one in.
        if (saved.length) throw new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate key'), { code: '23505' }));
        saved.push(row);
        return { id: 'cert-1', ...row };
      }),
    };
    const none = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) };
    const bus = { subscribe: jest.fn(), publish: jest.fn().mockResolvedValue(undefined) };
    const storage = { putObject: jest.fn().mockResolvedValue(undefined) };
    const service = new CertificateService(certificates as never, none as never, none as never, none as never, bus as never, storage as never, { get: jest.fn() } as never);

    await Promise.all([service.issue(completion), service.issue(completion)]);

    expect(saved).toHaveLength(1);
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish).toHaveBeenCalledWith('CertificateIssued', expect.objectContaining({ enrollment_id: 'enr-1' }));
  });

  it('any other save error still throws, so the bus retries', async () => {
    const certificates = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: object) => row),
      save: jest.fn().mockRejectedValue(new Error('connection reset')),
    };
    const none = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) };
    const service = new CertificateService(
      certificates as never, none as never, none as never, none as never,
      { subscribe: jest.fn(), publish: jest.fn() } as never, { putObject: jest.fn() } as never, { get: jest.fn() } as never,
    );
    await expect(service.issue(completion)).rejects.toThrow('connection reset');
  });
});
