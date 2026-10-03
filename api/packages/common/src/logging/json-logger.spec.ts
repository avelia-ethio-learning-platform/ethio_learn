import { ConsoleLogger, Logger } from '@nestjs/common';
import { requestContext } from '../context';
import { JsonLogger, logFormatFromEnv, logLevelFromEnv } from './json-logger';

function capture(level: 'error' | 'warn' | 'log' | 'debug' | 'verbose' = 'log') {
  const lines: string[] = [];
  const logger = new JsonLogger({ service: 'enrollment', format: 'json', level, write: (line) => void lines.push(line) });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

describe('JsonLogger (json)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('writes one JSON object per call, one line each, with the context name Nest passes last', () => {
    const { logger, lines, parsed } = capture();
    logger.log('enrolled', 'EnrollmentService');
    logger.warn('slow', 'Db');

    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
    expect(parsed()[0]).toEqual({ ts: expect.any(String), level: 'log', service: 'enrollment', context: 'EnrollmentService', msg: 'enrolled' });
    expect(new Date(parsed()[0].ts).toISOString()).toBe(parsed()[0].ts);
    expect(parsed()[1]).toMatchObject({ level: 'warn', context: 'Db', msg: 'slow' });
  });

  it("adds the request and event ids of the code it's called from", () => {
    const { logger, parsed } = capture();
    requestContext.run(
      { request_id: 'r-1', user_id: 'u-1', event_id: 'e-1', event_type: 'CourseCompleted', correlation_id: 'r-1', handler: 'quality:tier' },
      () => logger.log('inside', 'H'),
    );
    logger.log('outside', 'H');

    expect(parsed()[0]).toMatchObject({ msg: 'inside', request_id: 'r-1', user_id: 'u-1', event_id: 'e-1', handler: 'quality:tier' });
    expect(parsed()[1]).not.toHaveProperty('request_id');
    expect(parsed()[1]).not.toHaveProperty('handler');
  });

  it('puts the stack Nest passes to error() on the line, and serializes an Error message', () => {
    const { logger, parsed } = capture();
    logger.error('payout failed', 'Error: boom\n    at run (payout.ts:1:1)', 'PayoutService');
    const err = new Error('db down');
    logger.error(err, 'Outbox');
    logger.error('no stack', undefined, 'X');

    expect(parsed()[0]).toMatchObject({ level: 'error', context: 'PayoutService', msg: 'payout failed', stack: 'Error: boom\n    at run (payout.ts:1:1)' });
    expect(parsed()[1]).toMatchObject({ context: 'Outbox', msg: 'db down', stack: err.stack });
    expect(parsed()[2]).toEqual(expect.not.objectContaining({ stack: expect.anything() }));
    expect(parsed()[2]).toMatchObject({ context: 'X', msg: 'no stack' });
  });

  it('merges a plain object message into the line, without overriding its own fields', () => {
    const { logger, parsed } = capture();
    logger.log({ msg: 'GET /api/v1/courses 200', status: 200, ms: 12, level: 'oops', request_id: 'r-9' }, 'Access');

    expect(parsed()[0]).toMatchObject({ level: 'log', context: 'Access', msg: 'GET /api/v1/courses 200', status: 200, ms: 12, request_id: 'r-9' });
  });

  it('filters by level: warn keeps error and warn', () => {
    const { logger, parsed } = capture('warn');
    logger.error('e');
    logger.warn('w');
    logger.log('l');
    logger.debug('d');
    logger.verbose('v');
    expect(parsed().map((l) => l.level)).toEqual(['error', 'warn']);
  });

  it('serves as the logger behind Nest static and instance Loggers', () => {
    const { logger, parsed } = capture();
    Logger.overrideLogger(logger);
    try {
      Logger.log('listening on :4103', 'Bootstrap');
      new Logger('EnrollmentService').warn('peer asleep');
    } finally {
      Logger.overrideLogger(false);
    }
    expect(parsed()).toEqual([
      expect.objectContaining({ context: 'Bootstrap', msg: 'listening on :4103' }),
      expect.objectContaining({ level: 'warn', context: 'EnrollmentService', msg: 'peer asleep' }),
    ]);
  });
});

describe('JsonLogger (pretty)', () => {
  afterEach(() => jest.restoreAllMocks());

  it("hands every call to Nest's ConsoleLogger, with the level filter and an object's msg", () => {
    const log = jest.spyOn(ConsoleLogger.prototype, 'log').mockImplementation(() => undefined);
    const debug = jest.spyOn(ConsoleLogger.prototype, 'debug').mockImplementation(() => undefined);
    const write = jest.fn();
    const logger = new JsonLogger({ service: 'gateway', format: 'pretty', level: 'log', write });
    logger.log('listening', 'Bootstrap');
    logger.log({ msg: 'GET / 200', status: 200 }, 'Access');
    logger.debug('hidden');

    expect(log.mock.calls).toEqual([
      ['listening', 'Bootstrap'],
      ['GET / 200', 'Access'],
    ]);
    expect(debug).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('LOG_FORMAT and LOG_LEVEL', () => {
  it('default to json in production, pretty elsewhere, and log', () => {
    expect(logFormatFromEnv({ NODE_ENV: 'production' })).toBe('json');
    expect(logFormatFromEnv({ NODE_ENV: 'development' })).toBe('pretty');
    expect(logFormatFromEnv({ NODE_ENV: 'production', LOG_FORMAT: 'pretty' })).toBe('pretty');
    expect(logLevelFromEnv({})).toBe('log');
    expect(logLevelFromEnv({ LOG_LEVEL: 'debug' })).toBe('debug');
  });

  it('refuse an unknown value, naming the choices', () => {
    expect(() => logFormatFromEnv({ LOG_FORMAT: 'text' })).toThrow('LOG_FORMAT must be json or pretty');
    expect(() => logLevelFromEnv({ LOG_LEVEL: 'info' })).toThrow('LOG_LEVEL must be one of error, warn, log, debug, verbose');
  });
});
