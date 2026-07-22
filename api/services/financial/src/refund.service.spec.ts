import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PaymentStatus, RefundStatus } from '@ethiopialearn/contracts';
import { RefundService } from './refund.service';

const DAY = 86_400_000;
const ctx = { id: 'u1', role: 'learner', email: 'l@e.et' } as never;

interface Options {
  paymentStatus?: PaymentStatus;
  learnerId?: string;
  enrolledDaysAgo?: number;
  progress?: number;
  certificateIssued?: boolean;
  assessmentPassed?: boolean;
}

function setup(opts: Options = {}) {
  const payment = {
    id: 'pay-1',
    learner_id: opts.learnerId ?? 'u1',
    course_id: 'c1',
    course_title: 'Course',
    amount_etb: '500.00',
    status: opts.paymentStatus ?? PaymentStatus.CONFIRMED,
    chapa_tx_ref: 'TX-1',
  };
  const refunds = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn(async (r: object) => ({ id: 'ref-1', ...r })),
    create: jest.fn((r: object) => r),
    find: jest.fn().mockResolvedValue([]),
  };
  const payments = { findOne: jest.fn().mockResolvedValue(payment), save: jest.fn(async (p: unknown) => p) };
  const bus = { publish: jest.fn().mockResolvedValue(undefined) };
  const internal = {
    get: jest.fn(async (path: string) => {
      if (path.startsWith('/api/v1/internal/entitlements')) {
        return {
          enrollment_id: 'e1',
          enrolled_at: new Date(Date.now() - (opts.enrolledDaysAgo ?? 1) * DAY).toISOString(),
          progress_percent: opts.progress ?? 0,
        };
      }
      if (path.includes('/outcomes-status')) {
        return {
          certificate_issued: opts.certificateIssued ?? false,
          assessment_passed: opts.assessmentPassed ?? false,
        };
      }
      return { email: 'l@e.et' };
    }),
  };
  const service = new RefundService(refunds as never, payments as never, bus as never, internal as never);
  return { service, bus, payments };
}

describe('RefundService rule engine (spec §10.4)', () => {
  it('auto-approves <20% progress within 7 days and revokes entitlement via RefundApproved', async () => {
    const { service, bus, payments } = setup({ progress: 10, enrolledDaysAgo: 2 });
    const result = await service.request(ctx, 'pay-1', 'changed my mind');
    expect(result.status).toBe(RefundStatus.APPROVED);
    expect(result.rule).toBe('auto_approve_under_20pct_within_7d');
    expect(bus.publish).toHaveBeenCalledWith('RefundApproved', expect.objectContaining({ payment_id: 'pay-1' }));
    // the payment itself is marked refunded
    expect(payments.save).toHaveBeenCalledWith(expect.objectContaining({ status: PaymentStatus.REFUNDED }));
  });

  it('sends 20–50% progress to manual review (pending, admin notified)', async () => {
    const { service, bus } = setup({ progress: 35, enrolledDaysAgo: 2 });
    const result = await service.request(ctx, 'pay-1', 'not what I expected');
    expect(result.status).toBe(RefundStatus.PENDING);
    expect(result.rule).toBe('manual_review_20_to_50pct');
    expect(bus.publish).toHaveBeenCalledWith('RefundRequested', expect.anything());
  });

  it('denies >50% consumed', async () => {
    const { service } = setup({ progress: 80, enrolledDaysAgo: 2 });
    const result = await service.request(ctx, 'pay-1', 'finished it, want money back');
    expect(result.status).toBe(RefundStatus.DENIED);
    expect(result.rule).toBe('over_50pct_consumed');
  });

  it('denies outside the 7-day window regardless of progress', async () => {
    const { service } = setup({ progress: 5, enrolledDaysAgo: 9 });
    const result = await service.request(ctx, 'pay-1', 'late');
    expect(result.status).toBe(RefundStatus.DENIED);
    expect(result.rule).toBe('outside_7_day_window');
  });

  it('denies once a certificate was issued, even inside the window', async () => {
    const { service } = setup({ progress: 10, enrolledDaysAgo: 1, certificateIssued: true });
    const result = await service.request(ctx, 'pay-1', 'got cert, want refund');
    expect(result.status).toBe(RefundStatus.DENIED);
    expect(result.rule).toBe('certificate_already_issued');
  });

  it('denies once an assessment was passed', async () => {
    const { service } = setup({ progress: 10, enrolledDaysAgo: 1, assessmentPassed: true });
    const result = await service.request(ctx, 'pay-1', 'passed, refund pls');
    expect(result.status).toBe(RefundStatus.DENIED);
    expect(result.rule).toBe('assessment_already_passed');
  });

  it("refuses to act on someone else's payment", async () => {
    const { service } = setup({ learnerId: 'someone-else' });
    await expect(service.request(ctx, 'pay-1', 'x')).rejects.toThrow(ForbiddenException);
  });

  it('only refunds confirmed payments', async () => {
    const { service } = setup({ paymentStatus: PaymentStatus.PENDING });
    await expect(service.request(ctx, 'pay-1', 'x')).rejects.toThrow(BadRequestException);
  });
});
