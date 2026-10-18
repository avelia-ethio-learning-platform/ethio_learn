import { randomUUID } from 'crypto';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { getMany, idsQuery, learnerProgress, ProgressPairsQuery, UserIdsQuery, userSummaries } from './batch';
import { internalPath } from './internal-client';
import { PeerUnavailableError } from './internal-errors';

const pipe = new ValidationPipe({ whitelist: true, transform: true });
const run = (type: new () => object, query: Record<string, string>) =>
  pipe.transform(query, { type: 'query', metatype: type } as ArgumentMetadata) as Promise<Record<string, unknown> & { ids: string[]; pairs: string[] }>;
const uuids = (n: number) => Array.from({ length: n }, () => randomUUID());

describe('batch query DTOs', () => {
  class Ids100 extends idsQuery(100) {}

  it('splits and accepts up to the cap', async () => {
    const ids = uuids(100);
    expect((await run(Ids100, { ids: ids.join(',') })).ids).toEqual(ids);
  });

  it.each([
    ['101 ids', { ids: uuids(101).join(',') }],
    ['no ids', {}],
    ['a non-uuid', { ids: `${randomUUID()},nope` }],
  ])('rejects %s with 400', async (_label, q) => {
    await expect(run(Ids100, q as Record<string, string>)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('users: fields is email or absent', async () => {
    expect(await run(UserIdsQuery, { ids: randomUUID(), fields: 'email' })).toMatchObject({ fields: 'email' });
    await expect(run(UserIdsQuery, { ids: randomUUID(), fields: 'password_hash' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pairs: 50 accepted, 51 or a malformed pair rejected', async () => {
    const pairs = (n: number) => Array.from({ length: n }, () => `${randomUUID()}:${randomUUID()}`);
    expect((await run(ProgressPairsQuery, { pairs: pairs(50).join(',') })).pairs).toHaveLength(50);
    await expect(run(ProgressPairsQuery, { pairs: pairs(51).join(',') })).rejects.toBeInstanceOf(BadRequestException);
    await expect(run(ProgressPairsQuery, { pairs: randomUUID() })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('getMany', () => {
  it('chunks distinct items by the cap, one call per chunk, in order', async () => {
    const client = { get: jest.fn(async (path: string) => path) };
    const items = Array.from({ length: 120 }, (_, i) => `i${i}`);
    const out = await getMany<string>(client as never, [...items, 'i0'], 50, (chunk) => internalPath`/api/v1/internal/x?ids=${chunk}`);
    expect(client.get).toHaveBeenCalledTimes(3);
    expect(out.map((p) => p.split('ids=')[1].split(',').length)).toEqual([50, 50, 20]);
  });

  it('makes no call for an empty list', async () => {
    const client = { get: jest.fn() };
    expect(await getMany(client as never, [], 100, () => internalPath`/api/v1/internal/x`)).toEqual([]);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('propagates the typed error', async () => {
    const client = { get: jest.fn().mockRejectedValue(new PeerUnavailableError()) };
    await expect(userSummaries(client as never, ['a'])).rejects.toBeInstanceOf(PeerUnavailableError);
  });
});

describe('batch helpers', () => {
  it('userSummaries asks for email only when told to, and maps by id', async () => {
    const client = { get: jest.fn(async () => [{ id: 'u1', name: 'Abebe', role: 'learner' }]) };
    const names = await userSummaries(client as never, ['u1', 'u2']);
    expect(client.get.mock.calls[0]).toEqual(['/api/v1/internal/users?ids=u1,u2']);
    expect(names.get('u1')?.name).toBe('Abebe');
    expect(names.has('u2')).toBe(false);
    await userSummaries(client as never, ['u1'], { email: true });
    expect(client.get.mock.calls[1]).toEqual(['/api/v1/internal/users?ids=u1&fields=email']);
  });

  it('learnerProgress: 120 pairs take 3 calls and come back keyed by pair', async () => {
    const client = {
      get: jest.fn(async (path: string) =>
        decodeURIComponent(path.split('pairs=')[1])
          .split(',')
          .map((pair) => ({ learner_id: pair.split(':')[0], course_id: pair.split(':')[1], progress_percent: 10 })),
      ),
    };
    const pairs = Array.from({ length: 120 }, (_, i) => `l${i}:c${i}`);
    const out = await learnerProgress(client as never, pairs);
    expect(client.get).toHaveBeenCalledTimes(3);
    expect(out.get('l119:c119')?.progress_percent).toBe(10);
  });
});
