import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AnalyticsQuery } from './analytics-query.dto';

const A = '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d';
const B = '00000000-0000-0000-0000-000000000000';

async function run(query: Record<string, unknown>) {
  const dto = plainToInstance(AnalyticsQuery, query);
  const errors = await validate(dto, { whitelist: true });
  return { dto, messages: errors.flatMap((e) => Object.values(e.constraints ?? {})) };
}

describe('AnalyticsQuery', () => {
  it('splits and trims a comma-separated list of uuids', async () => {
    const { dto, messages } = await run({ course_ids: `${A}, ${B},` });
    expect(messages).toEqual([]);
    expect(dto.course_ids).toEqual([A, B]);
  });

  it.each([{}, { course_ids: '' }, { course_ids: ' , ' }])('keeps the "required" 400 for %p', async (query) => {
    const { messages } = await run(query);
    expect(messages).toContain('course_ids is required (comma-separated)');
  });

  it('rejects a non-uuid entry', async () => {
    const { messages } = await run({ course_ids: `${A},../users/${A}` });
    expect(messages).toContain('course_ids must be comma-separated uuids');
  });

  it('accepts 25 ids and rejects 26', async () => {
    expect((await run({ course_ids: Array(25).fill(A).join(',') })).messages).toEqual([]);
    expect((await run({ course_ids: Array(26).fill(A).join(',') })).messages).toContain('course_ids accepts at most 25 ids');
  });
});
