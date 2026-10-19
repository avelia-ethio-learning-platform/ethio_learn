import 'reflect-metadata';
import { Controller, Get, Module, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { matchPath } from './request-path';

/**
 * The gateway classifies a request by `matchPath` of its path and forwards the
 * raw path. That is only safe while every path variant a service routes to a
 * handler normalises to that handler's path. A service answers the way
 * `bootstrapService` sets it up (Nest on Express, the api/v1 prefix), so this
 * runs one and checks which variants reach a handler, and with what query.
 */
@Controller('internal/users')
class InternalController {
  @Get()
  list(@Query() query: Record<string, unknown>) {
    return { reached: 'internal/users', query };
  }
}

@Module({ controllers: [InternalController] })
class ServiceModule {}

let app: NestExpressApplication;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(ServiceModule, { logger: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
});

const CANONICAL = '/api/v1/internal/users';

describe('service routing as the gateway sees it', () => {
  it.each(['/api/v1/internal/users', '/API/V1/Internal/Users', '/api/v1/internal/users/'])('reaches the handler: %s', async (path) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    expect(matchPath(path)).toBe(CANONICAL);
  });

  it.each([
    '/api/v1/internal/users//',
    '/api/v1//internal/users',
    '/api/v1/%69nternal/users',
    '/api/v1/internal%2Fusers',
    '/api/v1/internal/users;x',
    '/api/v1/internal/users.json',
    '/api/v1/internal/users%20',
    '/api/v1/internal/users/x',
  ])('a handler reached by %s is the one matchPath names', async (path) => {
    const res = await fetch(`${base}${path}`);
    if (res.status === 200) expect(matchPath(path)).toBe(CANONICAL);
    else expect(res.status).toBe(404);
  });
});

describe('the query a service handler gets', () => {
  const query = async (qs: string) => ((await (await fetch(`${base}${CANONICAL}?${qs}`)).json()) as { query: unknown }).query;

  it('keeps a comma list as one string (batch reads split it themselves)', async () => {
    expect(await query('ids=a,b')).toEqual({ ids: 'a,b' });
  });

  it('turns a repeated key into an array', async () => {
    expect(await query('q=a&q=b')).toEqual({ q: ['a', 'b'] });
  });

  it('never builds nested objects or arrays from brackets', async () => {
    expect(await query('x[]=1&y[z]=2')).toEqual({ 'x[]': '1', 'y[z]': '2' });
  });
});
