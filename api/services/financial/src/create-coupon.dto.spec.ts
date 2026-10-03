import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCouponDto } from './growth.controller';

const errorsFor = async (body: Record<string, unknown>) =>
  (await validate(plainToInstance(CreateCouponDto, { kind: 'percent', value: 20, ...body }), { whitelist: true })).map((e) => e.property);

describe('CreateCouponDto max_uses_per_user', () => {
  it('is optional, and a whole number of at least 1 when given', async () => {
    expect(await errorsFor({})).toEqual([]);
    expect(await errorsFor({ max_uses_per_user: 1 })).toEqual([]);
    expect(await errorsFor({ max_uses_per_user: 3 })).toEqual([]);
  });

  it.each([0, -1, 1.5, '2'])('rejects %p', async (value) => {
    expect(await errorsFor({ max_uses_per_user: value })).toEqual(['max_uses_per_user']);
  });
});
