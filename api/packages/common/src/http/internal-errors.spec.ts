import { ArgumentsHost } from '@nestjs/common';
import { PeerAsleepError, PeerErrorFilter, PeerUnavailableError } from './internal-errors';

describe('PeerErrorFilter', () => {
  it.each([
    [new PeerAsleepError(), 'service_waking'],
    [new PeerUnavailableError(), 'service_unavailable'],
  ])('answers 503 with the code and Retry-After: 30', (error, code) => {
    const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = { getType: () => 'http', getArgByIndex: (i: number) => (i === 1 ? res : undefined), switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
    const adapter = { reply: jest.fn(), isHeadersSent: () => false };
    new PeerErrorFilter(adapter as never).catch(error, host);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    expect(adapter.reply).toHaveBeenCalledWith(res, expect.objectContaining({ statusCode: 503, code }), 503);
  });

  it('adds no header outside HTTP and falls through to the default handler', () => {
    const fallback = jest.spyOn(Object.getPrototypeOf(PeerErrorFilter.prototype), 'catch').mockImplementation(() => undefined);
    const host = { getType: () => 'rpc', switchToHttp: jest.fn() } as unknown as ArgumentsHost;
    new PeerErrorFilter().catch(new PeerUnavailableError(), host);
    expect(host.switchToHttp).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalled();
    fallback.mockRestore();
  });
});
