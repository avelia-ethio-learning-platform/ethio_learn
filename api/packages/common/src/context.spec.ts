import { currentContext, isUuid, requestContext, requestContextMiddleware, RequestContext, requestIdFrom } from './context';

const uuid = '0b6f3c1e-5d2a-4f8e-9c71-2a4d6e8f0b13';

function run(headers: Record<string, string>): { context: RequestContext | undefined; responseId: string; forwarded: unknown } {
  const req = { headers: { ...headers } as Record<string, string | string[] | undefined> };
  let responseId = '';
  let context: RequestContext | undefined;
  requestContextMiddleware(req, { setHeader: (_name: string, value: string) => (responseId = value) }, () => {
    context = currentContext();
  });
  return { context, responseId, forwarded: req.headers['x-request-id'] };
}

describe('requestIdFrom', () => {
  it('keeps a UUID, lower-cased the way Postgres stores it', () => {
    expect(requestIdFrom(uuid)).toBe(uuid);
    expect(requestIdFrom(uuid.toUpperCase())).toBe(uuid);
  });

  it.each([
    ['a label', 'checkout-1'],
    ["nginx's 32-hex id", '6f1b2a439a0e4c2d8f532b1f6a9e7c10'],
    ['a UUID with a suffix', `${uuid}x`],
    ['nothing', undefined],
    ['a repeated header', [uuid, uuid]],
  ])('replaces %s with a fresh UUID', (_label, incoming) => {
    const id = requestIdFrom(incoming);
    expect(isUuid(id)).toBe(true);
    expect(id).not.toBe(incoming);
  });
});

describe('requestContextMiddleware', () => {
  it('runs the request under an incoming UUID id, forwards it and returns it', () => {
    const { context, responseId, forwarded } = run({ 'x-request-id': uuid, 'x-user-id': 'user-1' });
    expect(context).toEqual({ request_id: uuid, user_id: 'user-1' });
    expect(responseId).toBe(uuid);
    expect(forwarded).toBe(uuid);
  });

  it.each(['checkout-1', '6f1b2a439a0e4c2d8f532b1f6a9e7c10'])('replaces a non-UUID id (%s) everywhere it goes', (incoming) => {
    const { context, responseId, forwarded } = run({ 'x-request-id': incoming });
    expect(isUuid(context?.request_id)).toBe(true);
    expect(context?.request_id).not.toBe(incoming);
    expect(responseId).toBe(context?.request_id);
    expect(forwarded).toBe(context?.request_id);
    expect(context?.user_id).toBeUndefined();
  });

  it('keeps the context across awaits and timers, and leaves none behind', async () => {
    const seen: (string | undefined)[] = [];
    await new Promise<void>((resolve) =>
      requestContextMiddleware({ headers: { 'x-request-id': uuid } }, { setHeader: () => undefined }, async () => {
        await Promise.resolve();
        setTimeout(() => {
          seen.push(currentContext()?.request_id);
          resolve();
        }, 1);
      }),
    );
    expect(seen).toEqual([uuid]);
    expect(currentContext()).toBeUndefined();
  });

  it('nests: an inner run replaces the store and the outer one comes back', () => {
    requestContext.run({ request_id: uuid }, () => {
      requestContext.run({ request_id: 'other' }, () => expect(currentContext()?.request_id).toBe('other'));
      expect(currentContext()?.request_id).toBe(uuid);
    });
  });
});
