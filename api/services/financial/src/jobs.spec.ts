import { FinancialJobs } from './jobs';

/** A data source whose lease upsert always wins (the lease SQL is covered in common's job-lease specs). */
const dataSource = {
  getRepository: () => ({ metadata: { tablePath: 'financial.job_leases' } }),
  query: jest.fn(async (sql: string, params: unknown[] = []) => (sql.startsWith('INSERT') ? [{ name: params[0] }] : [[], 1])),
};

describe('FinancialJobs', () => {
  it('the sweep job runs the Chapa sweep, then the expiry of abandoned checkouts (P2-01), and reports both counts', async () => {
    const order: string[] = [];
    const payments = {
      sweepPendingPayments: jest.fn(async () => (order.push('sweep'), { checked: 3 })),
      expireAbandonedCheckouts: jest.fn(async () => (order.push('expire'), { expired: 2 })),
    };
    const jobs = new FinancialJobs(dataSource as never, payments as never, {} as never);

    expect(await jobs.runner.run('sweep')).toEqual({ checked: 3, expired: 2 });
    expect(order).toEqual(['sweep', 'expire']);
  });
});
