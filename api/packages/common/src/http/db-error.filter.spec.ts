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

  it('leaves every other database error to the default handler', () => {
    const { host, res } = httpHost();
    const filter = new DbErrorFilter();
    const fallback = jest.spyOn(Object.getPrototypeOf(DbErrorFilter.prototype), 'catch').mockImplementation(() => undefined);
    filter.catch(dbError('23505'), host);
    expect(fallback).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    fallback.mockRestore();
  });
});
