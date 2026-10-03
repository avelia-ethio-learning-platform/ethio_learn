import { stableEventId } from './stable-event-id';

describe('stableEventId', () => {
  it('gives one key the same uuid every time, and another key a different one', () => {
    const id = stableEventId('pay-1:PaymentConfirmed');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableEventId('pay-1:PaymentConfirmed')).toBe(id);
    expect(stableEventId('pay-1:SponsorshipGranted')).not.toBe(id);
    expect(stableEventId('pay-2:PaymentConfirmed')).not.toBe(id);
  });
});
