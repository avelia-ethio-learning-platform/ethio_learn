import { ArgumentsHost } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { DbErrorFilter } from './db-error.filter';

function httpHost() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = { getType: () => 'http', switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  return { host, res };
}

const dbError = (code: string) => new QueryFailedError('SELECT 1', [], Object.assign(new Error('db'), { code }));

describe('DbErrorFilter', () => {
  it('answers 400 for an invalid uuid (22P02) instead of 500', () => {
    const { host, res } = httpHost();
    new DbErrorFilter().catch(dbError('22P02'), host);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });

  it('answers 409 for a duplicate (23505) with a fixed body and no values', () => {
    const { host, res } = httpHost();
    const err = new QueryFailedError('INSERT', ['x@y.z'], Object.assign(new Error('db'), {
      code: '23505',
      table: 'users',
      detail: 'Key (email)=(x@y.z) already exists.',
    }));
    new DbErrorFilter().catch(err, host);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ statusCode: 409, message: 'This already exists.', error: 'Conflict' });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('x@y.z');
  });

  it.each([
    ['23503', "A related record doesn't exist."],
    ['23502', 'Invalid value.'],
    ['22001', 'Invalid value.'],
    ['22003', 'Invalid value.'],
  ])('answers 400 for %s', (code, message) => {
    const { host, res } = httpHost();
    new DbErrorFilter().catch(dbError(code), host);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ statusCode: 400, message, error: 'Bad Request' });
  });

  it('leaves every other database error to the default handler', () => {
    const { host, res } = httpHost();
    const filter = new DbErrorFilter();
    const fallback = jest.spyOn(Object.getPrototypeOf(DbErrorFilter.prototype), 'catch').mockImplementation(() => undefined);
    filter.catch(dbError('40P01'), host);
    expect(fallback).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    fallback.mockRestore();
  });
});
