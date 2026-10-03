import { Logger } from '@nestjs/common';
import { redactPath, requestContext, requestIdFrom } from '@ethiopialearn/common';
import { NextFunction, Request, Response } from 'express';

/** What the routing middleware and the proxy learn about a request, for its access line. */
export interface AccessNotes {
  /** Only from a verified JWT. */
  user_id?: string;
  /** The service the route proxies to. */
  upstream?: string;
  /** The proxy's error code (ECONNRESET, ETIMEDOUT, …), never its message or the upstream URL. */
  error_code?: string;
}

export interface AccessLine extends AccessNotes {
  msg: string;
  request_id: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  ip?: string;
}

export type AccessLevel = 'log' | 'error';

export function accessNotes(res: Response): AccessNotes {
  return (res.locals.access ??= {}) as AccessNotes;
}

const accessLogger = new Logger('Access');
const defaultWrite = (level: AccessLevel, line: AccessLine) => accessLogger[level](line);

/**
 * The gateway's first middleware (Phase 9d): gives the request its id (an
 * incoming `x-request-id` only when it is a UUID), forwards it upstream and
 * returns it, and writes one access line when the response finishes. The path
 * is redacted (no query string, emails and tokens replaced); a `/health` or
 * `/ready` 200 isn't logged, so wake pings and probes stay out of the log.
 */
export function requestLog(write: (level: AccessLevel, line: AccessLine) => void = defaultWrite) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = requestIdFrom(req.headers['x-request-id']);
    req.headers['x-request-id'] = requestId; // the proxy forwards the request's headers
    res.setHeader('x-request-id', requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const path = redactPath(req.originalUrl ?? req.url);
      const status = res.statusCode;
      if (status === 200 && (path === '/health' || path === '/ready')) return;
      const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
      const notes = accessNotes(res);
      write(status >= 500 || notes.error_code ? 'error' : 'log', {
        msg: `${req.method} ${path} ${status} ${ms}ms`,
        request_id: requestId,
        method: req.method,
        path,
        status,
        ms,
        user_id: notes.user_id,
        upstream: notes.upstream,
        ip: req.ip,
        error_code: notes.error_code,
      });
    });
    requestContext.run({ request_id: requestId }, next);
  };
}
