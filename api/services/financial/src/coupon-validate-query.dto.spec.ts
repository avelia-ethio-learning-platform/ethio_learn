import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CouponValidateQuery } from './coupon-validate-query.dto';

const ID = '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d';

const errorsFor = async (query: Record<string, unknown>) =>
  (await validate(plainToInstance(CouponValidateQuery, query), { whitelist: true })).map((e) => e.property);

describe('CouponValidateQuery', () => {
  it('accepts a uuid course_id with or without a code', async () => {
    expect(await errorsFor({ course_id: ID, code: 'SAVE20' })).toEqual([]);
    expect(await errorsFor({ course_id: ID })).toEqual([]);
  });

  it.each([{}, { course_id: '' }, { course_id: 'not-a-uuid' }, { course_id: `../users/${ID}` }])('rejects %p', async (query) => {
    expect(await errorsFor(query)).toEqual(['course_id']);
  });
});
