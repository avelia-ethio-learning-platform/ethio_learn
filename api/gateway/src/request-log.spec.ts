import { currentContext } from '@ethiopialearn/common';
import { EventEmitter } from 'events';
import { Request, Response } from 'express';
import { AccessLevel, AccessLine, accessNotes, requestLog } from './request-log';

const uuid = '0b6f3c1e-5d2a-4f8e-9c71-2a4d6e8f0b13';

function exchange(url: string, headers: Record<string, string> = {}, method = 'GET') {
  const req = { method, originalUrl: url, url, headers: { ...headers }, ip: '196.188.0.7' } as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableFinished: false,
    locals: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  });
  const lines: Array<{ level: AccessLevel; line: AccessLine }> = [];
  let nextContext: unknown;
  requestLog((level, line) => void lines.push({ level, line }))(req, res as unknown as Response, () => {
    nextContext = currentContext();
  });
  const finish = (status: number) => {
    res.statusCode = status;
    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');
  };
  const abort = () => void res.emit('close');
  return { req, res: res as unknown as Response & { headers: Record<string, string> }, lines, finish, abort, nextContext: () => nextContext };
}

describe('requestLog', () => {
  it('keeps a UUID request id, forwards it upstream and echoes it', () => {
    const { req, res, nextContext } = exchange('/api/v1/courses', { 'x-request-id': uuid });
    expect(req.headers['x-request-id']).toBe(uuid);
    expect(res.headers['x-request-id']).toBe(uuid);
    expect(nextContext()).toEqual({ request_id: uuid });
  });

  it.each(['checkout-1', '6f1b2a439a0e4c2d8f532b1f6a9e7c10'])('replaces a non-UUID request id (%s) before forwarding it', (incoming) => {
    const { req, res } = exchange('/api/v1/courses', { 'x-request-id': incoming });
    expect(req.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.headers['x-request-id']).toBe(req.headers['x-request-id']);
  });

  it('writes one access line with the fields, a redacted path and no query string', () => {
    const { res, lines, finish } = exchange(`/api/v1/auth/invite/${'ab'.repeat(32)}?next=/home`, { 'x-request-id': uuid });
    accessNotes(res).upstream = 'auth';
    accessNotes(res).user_id = 'user-1';
    finish(200);

    expect(lines).toEqual([
      {
        level: 'log',
        line: {
          msg: expect.stringMatching(/^GET \/api\/v1\/auth\/invite\/\[token\] 200 \d+ms$/),
          request_id: uuid,
          method: 'GET',
          path: '/api/v1/auth/invite/[token]',
          status: 200,
          ms: expect.any(Number),
          user_id: 'user-1',
          upstream: 'auth',
          ip: '196.188.0.7',
          error_code: undefined,
        },
      },
    ]);
  });

  it('logs a proxy error at error level with its code', () => {
    const { res, lines, finish } = exchange('/api/v1/enrollments', {}, 'POST');
    accessNotes(res).upstream = 'enrollment';
    accessNotes(res).error_code = 'ECONNRESET';
    finish(502);
    expect(lines[0].level).toBe('error');
    expect(lines[0].line).toMatchObject({ method: 'POST', status: 502, upstream: 'enrollment', error_code: 'ECONNRESET' });
  });

  it('skips a /health or /ready 200, and logs a failing one', () => {
    for (const path of ['/health', '/ready', '/health?wake=1', '/health/']) {
      const { lines, finish } = exchange(path);
      finish(200);
      expect(lines).toEqual([]);
    }
    const failing = exchange('/health');
    failing.finish(503);
    expect(failing.lines[0]).toMatchObject({ level: 'error', line: { path: '/health', status: 503 } });
  });

  it('logs a request the client aborted once, marked aborted, probes included', () => {
    for (const path of ['/api/v1/courses', '/health']) {
      const { lines, abort } = exchange(path);
      abort();
      abort();
      expect(lines).toEqual([{ level: 'log', line: expect.objectContaining({ path, aborted: true, msg: expect.stringMatching(/ aborted$/) }) }]);
    }
  });
});
