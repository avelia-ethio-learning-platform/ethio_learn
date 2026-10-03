import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { limitQuery, pageQuery } from './page-query';

class Paged extends pageQuery({ defaultLimit: 20, maxLimit: 100 }) {}
class LimitOnly extends limitQuery({ defaultLimit: 12, maxLimit: 50 }) {}

const pipe = new ValidationPipe({ whitelist: true, transform: true });
const run = (type: new () => object, query: Record<string, string | undefined>) =>
  pipe.transform(query, { type: 'query', metatype: type } as ArgumentMetadata) as Promise<any>;

describe('pageQuery', () => {
  it('uses the defaults when absent', async () => {
    expect(await run(Paged, {})).toMatchObject({ page: 1, limit: 20 });
    expect(await run(LimitOnly, {})).toMatchObject({ limit: 12 });
  });

  it('accepts in-range values as numbers', async () => {
    expect(await run(Paged, { page: '3', limit: '50' })).toMatchObject({ page: 3, limit: 50 });
    expect(await run(Paged, { limit: '100' })).toMatchObject({ limit: 100 });
  });

  it.each([{ limit: '-5' }, { limit: '1000' }, { limit: 'abc' }, { limit: '0' }, { limit: '1.5' }, { page: '0' }, { page: '10001' }])(
    'rejects %j with 400',
    async (q) => {
      await expect(run(Paged, q)).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('applies each endpoint max and ignores page on a limit-only DTO', async () => {
    await expect(run(LimitOnly, { limit: '51' })).rejects.toBeInstanceOf(BadRequestException);
    expect(await run(LimitOnly, { page: '9' })).not.toHaveProperty('page');
  });
});
