import { BrokerPublishError, stableEventId } from '@ethiopialearn/common';
import { PaymentMethod, PaymentPurpose, PaymentStatus } from '@ethiopialearn/contracts';
import { BulkPurchase, Coupon, Payment, Referral, ReferralCode, Sponsorship, Wallet, WalletTransaction } from './entities';
import { GrowthService } from './growth.service';
import { PaymentService } from './payment.service';
import { SponsorshipService } from './sponsorship.service';
import { fakeDb, fakeOutbox, Row } from './testing/fake-db';

const ACCOUNTS: Record<string, { id: string; name: string; email: string; role: string }> = {
  'sister@x.et': { id: 'sister', name: 'Sister', email: 'sister@x.et', role: 'learner' },
};
const COURSE = { id: 'c1', title: 'Course', owner_id: 'edu-1', owner_type: 'educator', price_etb: 500, pricing_type: 'paid', status: 'published' };

/** The sponsorship handlers wired into the real PaymentService, on the in-memory schema. */
function setup() {
  const db = fakeDb();
  const bus = {
    publish: jest.fn().mockResolvedValue(undefined),
    publishConfirmed: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn(),
  };
  const internal = {
    get: jest.fn(async (path: string) => {
      const byEmail = /\/internal\/users\/by-email\/(.+)$/.exec(path);
      if (byEmail) {
        const account = ACCOUNTS[decodeURIComponent(byEmail[1])];
        if (!account) throw new Error('404');
        return account;
      }
      if (path.includes('/internal/users/')) return { email: 'sponsor@x.et', name: 'Sponsor' };
      if (path.includes('/internal/courses/')) return COURSE;
      if (path.includes('/entitlements')) return { entitlement_status: 'none' };
      throw new Error(`unexpected internal call ${path}`);
    }),
  };
  let txRefs = 0;
  const chapa = { verify: jest.fn(), initialize: jest.fn(), generateTxRef: jest.fn(async () => `TX-${++txRefs}`) };
  const growth = new GrowthService(
    db.repo(Coupon) as never,
    db.repo(Wallet) as never,
    db.repo(WalletTransaction) as never,
    db.repo(ReferralCode) as never,
    db.repo(Referral) as never,
    db.dataSource as never,
    bus as never,
    internal as never,
  );
  const payments = new PaymentService(db.repo(Payment) as never, chapa as never, bus as never, internal as never, growth, db.dataSource as never);
  const { outbox, committed, onEmit } = fakeOutbox(db.dataSource);
  const sponsorships = new SponsorshipService(db.repo(Sponsorship) as never, db.repo(BulkPurchase) as never, payments, bus as never, internal as never, outbox as never);
  sponsorships.onModuleInit();

  const old = new Date(Date.now() - 5 * 60_000);
  const confirmedPayment = (purpose: PaymentPurpose, meta: Row | null, id = 'pay-1') => {
    db.repo(Payment).rows.push({
      id,
      learner_id: 'sponsor',
      course_id: 'c1',
      amount_etb: '500.00',
      method: PaymentMethod.CHAPA,
      status: PaymentStatus.CONFIRMED,
      chapa_tx_ref: `TX-${id}`,
      payee_id: 'edu-1',
      payee_type: 'educator',
      course_title: 'Course',
      purpose,
      meta,
      webhook_received_at: old,
      effects_completed_at: null,
      created_at: old,
    });
  };
  const sponsorship = (over: Row = {}) => {
    const s = {
      id: 'sp-1',
      source: 'gift',
      status: 'pending_payment',
      sponsor_id: 'sponsor',
      sponsor_name: 'Sponsor',
      recipient_user_id: null,
      recipient_email: 'sister@x.et',
      course_id: 'c1',
      course_title: 'Course',
      message: 'Enjoy',
      payment_id: null,
      bulk_purchase_id: null,
      organization_name: null,
      token: 'TOKEN',
      granted_at: null,
      ...over,
    };
    db.repo(Sponsorship).rows.push(s);
    return s;
  };
  const events = (type: string) => bus.publishConfirmed.mock.calls.filter(([t]) => t === type);
  const payment = (id = 'pay-1') => db.repo(Payment).rows.find((p) => p.id === id)!;
  return { db, bus, chapa, internal, payments, sponsorships, confirmedPayment, sponsorship, events, payment, outbox, committed, onEmit };
}

describe('Sponsored payments: access events follow the sponsorship (P0-05)', () => {
  it('a paid gift to an existing account is granted once and published with broker confirms', async () => {
    const t = setup();
    t.sponsorship();
    t.confirmedPayment(PaymentPurpose.GIFT, { sponsorship_id: 'sp-1' });

    await t.payments.completePendingEffects();

    expect(t.db.repo(Sponsorship).rows[0]).toMatchObject({ status: 'granted', recipient_user_id: 'sister', payment_id: 'pay-1' });
    expect(t.events('SponsorshipGranted')).toEqual([
      [
        'SponsorshipGranted',
        expect.objectContaining({ sponsorship_id: 'sp-1', recipient_user_id: 'sister', course_id: 'c1' }),
        { correlationId: 'pay-1', eventId: stableEventId('sp-1:SponsorshipGranted') },
      ],
    ]);
    expect(t.payment().effects_completed_at).toBeInstanceOf(Date);
  });

  it('re-publishes a grant the broker lost, without granting twice', async () => {
    const t = setup();
    t.sponsorship();
    t.confirmedPayment(PaymentPurpose.GIFT, { sponsorship_id: 'sp-1' });
    t.bus.publishConfirmed.mockRejectedValueOnce(new BrokerPublishError('SponsorshipGranted', 'timeout'));
    jest.spyOn((t.payments as any).logger, 'warn').mockImplementation(() => undefined);

    await t.payments.completePendingEffects();
    const grantedAt = t.db.repo(Sponsorship).rows[0].granted_at;
    expect(t.payment().effects_completed_at).toBeNull();

    await t.payments.completePendingEffects();
    expect(t.events('SponsorshipGranted')).toHaveLength(2);
    // the same event to the consumers' dedupe
    expect(t.events('SponsorshipGranted').map(([, , opts]) => opts.eventId)).toEqual([stableEventId('sp-1:SponsorshipGranted'), stableEventId('sp-1:SponsorshipGranted')]);
    expect(t.db.repo(Sponsorship).rows[0].granted_at).toBe(grantedAt);
    expect(t.payment().effects_completed_at).toBeInstanceOf(Date);
  });

  it('a gift to an email with no account invites once and is then done: the next tick sends nothing', async () => {
    const t = setup();
    t.sponsorship({ recipient_email: 'stranger@x.et' });
    t.confirmedPayment(PaymentPurpose.GIFT, { sponsorship_id: 'sp-1' });

    await t.payments.completePendingEffects();
    await t.payments.completePendingEffects();

    expect(t.db.repo(Sponsorship).rows[0]).toMatchObject({ status: 'pending_claim', recipient_user_id: null, payment_id: 'pay-1' });
    expect(t.events('SponsorshipInvited')).toHaveLength(1);
    expect(t.events('SponsorshipInvited')[0][2]).toEqual({ correlationId: 'pay-1', eventId: stableEventId('sp-1:SponsorshipInvited') });
    expect(t.events('SponsorshipGranted')).toHaveLength(0);
    expect(t.payment().effects_completed_at).toBeInstanceOf(Date);
  });

  it('a paid pay request is granted to the learner who asked', async () => {
    const t = setup();
    t.sponsorship({ source: 'pay_request', recipient_user_id: 'asker', recipient_email: 'asker@x.et' });
    t.confirmedPayment(PaymentPurpose.PAY_REQUEST, { sponsorship_id: 'sp-1' });

    await t.payments.completePendingEffects();

    expect(t.events('SponsorshipGranted')).toEqual([
      ['SponsorshipGranted', expect.objectContaining({ recipient_user_id: 'asker' }), { correlationId: 'pay-1', eventId: stableEventId('sp-1:SponsorshipGranted') }],
    ]);
  });

  it('the handler changes the sponsorship once when two runs overlap', async () => {
    const t = setup();
    t.sponsorship();
    t.confirmedPayment(PaymentPurpose.GIFT, { sponsorship_id: 'sp-1' });
    const handler = (t.payments as any).purposeHandlers.get(PaymentPurpose.GIFT)[0];
    const update = jest.spyOn(t.db.repo(Sponsorship), 'update');

    await Promise.all([handler(t.payment()), handler(t.payment())]);

    const changed = await Promise.all(update.mock.results.map((r) => r.value));
    expect(changed.filter((c: { affected: number }) => c.affected === 1)).toHaveLength(1);
  });

  it('nothing to publish (no sponsorship id, or the row is gone) marks the payment done', async () => {
    const t = setup();
    t.confirmedPayment(PaymentPurpose.GIFT, null, 'no-meta');
    t.confirmedPayment(PaymentPurpose.GIFT, { sponsorship_id: 'missing' }, 'no-row');
    jest.spyOn((t.sponsorships as any).logger, 'warn').mockImplementation(() => undefined);

    expect(await t.payments.completePendingEffects()).toEqual({ completed: 2, failed: 0 });
    expect(t.bus.publishConfirmed).not.toHaveBeenCalled();
  });

  it('a paid bulk order is activated once and BulkPurchaseActivated is re-published until acknowledged', async () => {
    const t = setup();
    t.db.repo(BulkPurchase).rows.push({
      id: 'bulk-1',
      buyer_id: 'sponsor',
      organization_name: 'Acme',
      course_id: 'c1',
      course_title: 'Course',
      seats: 10,
      total_etb: '4000.00',
      status: 'pending_payment',
      payment_id: null,
    });
    t.confirmedPayment(PaymentPurpose.BULK, { bulk_purchase_id: 'bulk-1', seats: 10 });
    t.bus.publishConfirmed.mockRejectedValueOnce(new BrokerPublishError('BulkPurchaseActivated', 'channel closed'));
    jest.spyOn((t.payments as any).logger, 'warn').mockImplementation(() => undefined);

    await t.payments.completePendingEffects();
    expect(t.db.repo(BulkPurchase).rows[0]).toMatchObject({ status: 'active', payment_id: 'pay-1' });
    expect(t.payment().effects_completed_at).toBeNull();

    await t.payments.completePendingEffects();
    expect(t.events('BulkPurchaseActivated')).toHaveLength(2);
    expect(t.events('BulkPurchaseActivated')[1][1]).toMatchObject({ bulk_purchase_id: 'bulk-1', seats: 10, buyer_email: 'sponsor@x.et' });
    expect(t.events('BulkPurchaseActivated').map(([, , opts]) => opts.eventId)).toEqual([stableEventId('pay-1:BulkPurchaseActivated'), stableEventId('pay-1:BulkPurchaseActivated')]);
    expect(t.payment().effects_completed_at).toBeInstanceOf(Date);
  });
});

describe('A refused checkout undoes its sponsorship side', () => {
  const SPONSOR = { id: 'sponsor', role: 'learner', email: 'sponsor@x.et' } as never;
  const PAYER_B = { id: 'payer-b', role: 'learner', email: 'b@x.et' } as never;
  const gift = { course_id: 'c1', recipient_email: 'sister@x.et' };
  const bulk = { course_id: 'c1', seats: 10, organization_name: 'Acme' };
  const chapaRefuses = (t: ReturnType<typeof setup>) => t.chapa.initialize.mockRejectedValue(new Error('Chapa is unavailable'));
  /** A pay request nobody has paid yet, as createPayRequest leaves it. */
  const openRequest = (t: ReturnType<typeof setup>) =>
    t.sponsorship({ source: 'pay_request', status: 'requested', sponsor_id: null, sponsor_name: '', recipient_user_id: 'asker', recipient_email: 'asker@x.et' });

  const giftCap = process.env.GIFTS_PER_DAY;
  afterEach(() => {
    if (giftCap === undefined) delete process.env.GIFTS_PER_DAY;
    else process.env.GIFTS_PER_DAY = giftCap;
  });

  it.each([
    ['Chapa cannot open the checkout', {}, 'Chapa is unavailable'],
    ['the wallet cannot cover it', { use_wallet: true }, 'is not enough for 500.00 ETB'],
  ])('a refused gift (%s) leaves no gift behind, so it does not count toward the daily cap', async (_, how, message) => {
    process.env.GIFTS_PER_DAY = '1';
    const t = setup();
    chapaRefuses(t);

    await expect(t.sponsorships.createGift(SPONSOR, { ...gift, ...how })).rejects.toThrow(message);
    expect(t.db.repo(Sponsorship).rows).toEqual([]);

    t.chapa.initialize.mockResolvedValue({ checkout_url: 'https://checkout.example/gift' });
    await expect(t.sponsorships.createGift(SPONSOR, gift)).resolves.toMatchObject({ checkout_url: 'https://checkout.example/gift' });
  });

  it.each([
    ['Chapa cannot open the checkout', {}, 'Chapa is unavailable'],
    ['the wallet cannot cover it', { use_wallet: true }, 'is not enough for 500.00 ETB'],
  ])('a refused pay-request checkout (%s) puts the request back to requested, with no sponsor', async (_, how, message) => {
    const t = setup();
    openRequest(t);
    chapaRefuses(t);

    await expect(t.sponsorships.payRequest(SPONSOR, 'TOKEN', how)).rejects.toThrow(message);

    expect(t.db.repo(Sponsorship).rows).toEqual([expect.objectContaining({ status: 'requested', sponsor_id: null, sponsor_name: '', payment_id: null })]);
  });

  it('does not undo the checkout of a payer who took the request over while the refused one was opening', async () => {
    const t = setup();
    openRequest(t);
    let theirsOpening!: () => void;
    const theirsAtChapa = new Promise<void>((resolve) => (theirsOpening = resolve));
    let releaseTheirs!: () => void;
    const theirsReleased = new Promise<void>((resolve) => (releaseTheirs = resolve));
    let theirCheckout!: Promise<unknown>;
    t.chapa.initialize
      // Ours: payer B takes the request over, and ours is refused while B's checkout is still opening.
      .mockImplementationOnce(async () => {
        theirCheckout = t.sponsorships.payRequest(PAYER_B, 'TOKEN', {});
        await theirsAtChapa;
        throw new Error('Chapa is unavailable');
      })
      .mockImplementationOnce(async () => {
        theirsOpening();
        await theirsReleased;
        return { checkout_url: 'https://checkout.example/b' };
      });

    await expect(t.sponsorships.payRequest(SPONSOR, 'TOKEN', {})).rejects.toThrow('Chapa is unavailable');
    expect(t.db.repo(Sponsorship).rows).toEqual([expect.objectContaining({ status: 'pending_payment', sponsor_id: 'payer-b', payment_id: null })]);

    releaseTheirs();
    await theirCheckout;
    const theirs = t.db.repo(Payment).rows.find((p) => p.learner_id === 'payer-b')!;
    expect(theirs).toMatchObject({ status: PaymentStatus.PENDING, chapa_checkout_url: 'https://checkout.example/b' });
    expect(t.db.repo(Sponsorship).rows).toEqual([expect.objectContaining({ status: 'pending_payment', sponsor_id: 'payer-b', payment_id: theirs.id })]);
  });

  it('does not undo a request whose earlier payer still has an open checkout', async () => {
    const t = setup();
    openRequest(t);
    t.chapa.initialize.mockResolvedValueOnce({ checkout_url: 'https://checkout.example/b' }).mockRejectedValueOnce(new Error('Chapa is unavailable'));
    await t.sponsorships.payRequest(PAYER_B, 'TOKEN', {});
    const theirs = t.db.repo(Payment).rows[0];

    await expect(t.sponsorships.payRequest(SPONSOR, 'TOKEN', {})).rejects.toThrow('Chapa is unavailable');

    expect(t.db.repo(Sponsorship).rows).toEqual([expect.objectContaining({ status: 'pending_payment', payment_id: theirs.id })]);
  });

  it('a refused bulk checkout leaves no order behind', async () => {
    const t = setup();
    chapaRefuses(t);

    await expect(t.sponsorships.createBulk(SPONSOR, bulk)).rejects.toThrow('Chapa is unavailable');

    expect(t.db.repo(BulkPurchase).rows).toEqual([]);
  });

  it('keeps a gift or bulk order that a confirmation already moved on, whatever the checkout throws afterwards', async () => {
    const t = setup();
    const session = jest.spyOn(t.payments, 'createSession');
    session.mockImplementationOnce(async () => {
      t.db.repo(Sponsorship).rows[0].status = 'granted';
      throw new Error('after the confirmation');
    });
    session.mockImplementationOnce(async () => {
      t.db.repo(BulkPurchase).rows[0].status = 'active';
      throw new Error('after the confirmation');
    });

    await expect(t.sponsorships.createGift(SPONSOR, gift)).rejects.toThrow('after the confirmation');
    await expect(t.sponsorships.createBulk(SPONSOR, bulk)).rejects.toThrow('after the confirmation');

    expect(t.db.repo(Sponsorship).rows).toEqual([expect.objectContaining({ status: 'granted' })]);
    expect(t.db.repo(BulkPurchase).rows).toEqual([expect.objectContaining({ status: 'active' })]);
  });

  it('when the undo itself fails, logs it with the gift id and still reports the refusal', async () => {
    const t = setup();
    chapaRefuses(t);
    t.db.repo(Sponsorship).delete.mockRejectedValueOnce(new Error('connection lost'));
    const error = jest.spyOn((t.sponsorships as any).logger, 'error').mockImplementation(() => undefined);

    await expect(t.sponsorships.createGift(SPONSOR, gift)).rejects.toThrow('Chapa is unavailable');

    const left = t.db.repo(Sponsorship).rows[0];
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`gift ${left.id}`));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
  });
});

describe('Pay requests: a stale call never overwrites a paid request (P2-47)', () => {
  const PAYER_A = { id: 'payer-a', role: 'learner', email: 'a@x.et' } as never;
  const PAYER_B = { id: 'payer-b', role: 'learner', email: 'b@x.et' } as never;
  const NAMES: Record<string, string> = { 'payer-a': 'Payer A', 'payer-b': 'Payer B' };

  function requestSetup() {
    const t = setup();
    const get = t.internal.get.getMockImplementation()!;
    t.internal.get.mockImplementation(async (path: string) => {
      const user = /\/internal\/users\/([^/]+)$/.exec(path);
      if (user && NAMES[user[1]]) return { email: `${user[1]}@x.et`, name: NAMES[user[1]] };
      return get(path);
    });
    t.sponsorship({ source: 'pay_request', status: 'requested', sponsor_id: null, sponsor_name: '', recipient_user_id: 'asker', recipient_email: 'asker@x.et' });
    t.chapa.initialize.mockImplementation(async () => ({ checkout_url: 'https://checkout.example/pay' }));
    const row = () => t.db.repo(Sponsorship).rows[0];
    const paymentOf = (learnerId: string) => t.db.repo(Payment).rows.find((p) => p.learner_id === learnerId)!;
    /** The payer's Chapa checkout completes, and the sponsorship handler runs on it. */
    const confirm = async (learnerId: string) => {
      Object.assign(paymentOf(learnerId), { status: PaymentStatus.CONFIRMED, webhook_received_at: new Date(Date.now() - 5 * 60_000) });
      await t.payments.completePendingEffects();
    };
    return { ...t, row, paymentOf, confirm };
  }

  it('A-1: B opens, A opens, B pays: the grant names B', async () => {
    const t = requestSetup();
    await t.sponsorships.payRequest(PAYER_B, 'TOKEN', {});
    await t.sponsorships.payRequest(PAYER_A, 'TOKEN', {});
    expect(t.row()).toMatchObject({ sponsor_id: 'payer-a', payment_id: t.paymentOf('payer-a').id });

    await t.confirm('payer-b');

    expect(t.row()).toMatchObject({ status: 'granted', sponsor_id: 'payer-b', sponsor_name: 'Payer B', payment_id: t.paymentOf('payer-b').id });
    expect(t.events('SponsorshipGranted')).toEqual([['SponsorshipGranted', expect.objectContaining({ sponsor_id: 'payer-b', sponsor_name: 'Payer B' }), expect.anything()]]);
  });

  it("A-2: A's payment confirms while B's checkout opens: the request stays granted to A, and B gets a 400 with no URL", async () => {
    const t = requestSetup();
    await t.sponsorships.payRequest(PAYER_A, 'TOKEN', {});
    t.chapa.initialize.mockImplementationOnce(async () => {
      await t.confirm('payer-a');
      return { checkout_url: 'https://checkout.example/b' };
    });

    await expect(t.sponsorships.payRequest(PAYER_B, 'TOKEN', {})).rejects.toThrow('This request has already been paid');

    expect(t.row()).toMatchObject({ status: 'granted', sponsor_id: 'payer-a', payment_id: t.paymentOf('payer-a').id });
    expect(t.paymentOf('payer-b')).toMatchObject({ status: PaymentStatus.PENDING });
  });

  it('A-3: a grant that lands during the entitlement check is not cancelled', async () => {
    const t = requestSetup();
    await t.sponsorships.payRequest(PAYER_A, 'TOKEN', {});
    const get = t.internal.get.getMockImplementation()!;
    t.internal.get.mockImplementation(async (path: string) => {
      if (!path.includes('/entitlements')) return get(path);
      await t.confirm('payer-a'); // A's payment is granted meanwhile, so the learner is entitled
      return { entitlement_status: 'active' };
    });

    await expect(t.sponsorships.payRequest(PAYER_B, 'TOKEN', {})).rejects.toThrow('The learner already has access to this course');

    expect(t.row()).toMatchObject({ status: 'granted', sponsor_id: 'payer-a' });
  });

  it('the entitled check still cancels an open request', async () => {
    const t = requestSetup();
    const get = t.internal.get.getMockImplementation()!;
    t.internal.get.mockImplementation(async (path: string) => (path.includes('/entitlements') ? { entitlement_status: 'active' } : get(path)));

    await expect(t.sponsorships.payRequest(PAYER_B, 'TOKEN', {})).rejects.toThrow('The learner already has access to this course');
    expect(t.row()).toMatchObject({ status: 'cancelled' });
  });

  it("A-4: B settles by wallet after A's refused checkout reset the request: the grant names B", async () => {
    const t = requestSetup();
    t.chapa.initialize.mockRejectedValueOnce(new Error('Chapa is unavailable'));
    await expect(t.sponsorships.payRequest(PAYER_A, 'TOKEN', {})).rejects.toThrow('Chapa is unavailable');
    expect(t.row()).toMatchObject({ status: 'requested', sponsor_id: null });
    t.db.repo(Wallet).rows.push({ user_id: 'payer-b', balance_etb: '1000.00' });

    const result = await t.sponsorships.payRequest(PAYER_B, 'TOKEN', { use_wallet: true });

    expect(result).toMatchObject({ confirmed: true });
    expect(t.row()).toMatchObject({ status: 'granted', sponsor_id: 'payer-b', sponsor_name: 'Payer B' });
  });

  it('a call on a request that is already granted answers 400 without opening a checkout', async () => {
    const t = requestSetup();
    t.row().status = 'granted';
    await expect(t.sponsorships.payRequest(PAYER_B, 'TOKEN', {})).rejects.toThrow('This request has already been paid');
    expect(t.db.repo(Payment).rows).toEqual([]);
  });
});

describe('Seat claims commit with their events (9b outbox)', () => {
  const signup = (t: ReturnType<typeof setup>) => {
    const [, handler] = t.bus.subscribe.mock.calls.find(([type]) => type === 'UserRegistered')!;
    return (user_id: string, email: string) => handler({ user_id, email });
  };

  it('a signup claims its waiting seat with SponsorshipGranted; a failure before commit leaves the seat waiting and the redelivery claims it once', async () => {
    const t = setup();
    t.sponsorship({ status: 'pending_claim', recipient_email: 'new@x.et' });
    t.onEmit.mockImplementationOnce(() => {
      throw new Error('outbox insert failed');
    });

    await expect(signup(t)('u-new', 'New@x.et')).rejects.toThrow('outbox insert failed');
    expect(t.db.repo(Sponsorship).rows[0]).toMatchObject({ status: 'pending_claim', recipient_user_id: null, granted_at: null });
    expect(t.committed).toEqual([]);

    await signup(t)('u-new', 'New@x.et');
    await signup(t)('u-new', 'New@x.et');
    expect(t.db.repo(Sponsorship).rows[0]).toMatchObject({ status: 'granted', recipient_user_id: 'u-new' });
    expect(t.committed).toEqual([['SponsorshipGranted', expect.objectContaining({ sponsorship_id: 'sp-1', recipient_user_id: 'u-new' })]]);
    expect(t.bus.publish).not.toHaveBeenCalled();
  });

  it("the dashboard's claim racing the signup's grants and announces the seat once", async () => {
    const t = setup();
    t.sponsorship({ status: 'pending_claim', recipient_email: 'new@x.et' });
    const [a, b] = await Promise.all([signup(t)('u-new', 'new@x.et'), t.sponsorships.claimMine({ id: 'u-new', email: 'new@x.et' } as never)]);
    expect([a, b]).toEqual([undefined, expect.objectContaining({ claimed: expect.any(Number) })]);
    expect(t.committed.filter(([type]) => type === 'SponsorshipGranted')).toHaveLength(1);
  });

  it('an assigned bulk seat commits with its SponsorshipGranted or SponsorshipInvited; a failure leaves no seat', async () => {
    const t = setup();
    t.db.repo(BulkPurchase).rows.push({ id: 'bp-1', buyer_id: 'buyer', organization_name: 'Org', course_id: 'c1', course_title: 'Course', seats: 5, status: 'active' });
    const buyer = { id: 'buyer', role: 'institution_admin', email: 'buyer@x.et' } as never;
    t.onEmit.mockImplementationOnce(() => {
      throw new Error('outbox insert failed');
    });
    await expect(t.sponsorships.assignSeats(buyer, 'bp-1', ['stranger@x.et'])).rejects.toThrow('outbox insert failed');
    expect(t.db.repo(Sponsorship).rows).toHaveLength(0);
    expect(t.committed).toEqual([]);

    await expect(t.sponsorships.assignSeats(buyer, 'bp-1', ['stranger@x.et', 'sister@x.et'])).resolves.toMatchObject({
      results: [
        { email: 'stranger@x.et', status: 'invited' },
        { email: 'sister@x.et', status: 'granted' },
      ],
    });
    expect(t.db.repo(Sponsorship).rows.map((s) => s.status)).toEqual(['pending_claim', 'granted']);
    expect(t.committed.map(([type]) => type)).toEqual(['SponsorshipInvited', 'SponsorshipGranted']);
    expect(t.bus.publish).not.toHaveBeenCalled();
  });
});
