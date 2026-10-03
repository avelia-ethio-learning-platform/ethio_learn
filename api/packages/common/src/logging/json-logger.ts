import { ConsoleLogger, LoggerService, LogLevel } from '@nestjs/common';
import { currentContext } from '../context';

export type LogFormat = 'json' | 'pretty';

/** Most to least severe. `LOG_LEVEL` keeps its own level and everything above it. */
const LEVELS = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
type Level = (typeof LEVELS)[number];

/** `LOG_FORMAT`: `json` by default in production, readable `pretty` elsewhere. */
export function logFormatFromEnv(environment: NodeJS.ProcessEnv = process.env): LogFormat {
  const raw = environment.LOG_FORMAT;
  if (!raw) return environment.NODE_ENV === 'production' ? 'json' : 'pretty';
  if (raw === 'json' || raw === 'pretty') return raw;
  throw new Error('LOG_FORMAT must be json or pretty');
}

/** `LOG_LEVEL`, default `log`. */
export function logLevelFromEnv(environment: NodeJS.ProcessEnv = process.env): Level {
  const raw = environment.LOG_LEVEL;
  if (!raw) return 'log';
  if ((LEVELS as readonly string[]).includes(raw)) return raw as Level;
  throw new Error(`LOG_LEVEL must be one of ${LEVELS.join(', ')}`);
}

export interface JsonLoggerOptions {
  service: string;
  format?: LogFormat;
  level?: Level;
  /** Where a JSON line goes; stdout by default. */
  write?: (line: string) => void;
}

/**
 * Nest's logger for the services and the gateway (Phase 9d). In `json` format
 * every call is one line: `ts`, `level`, `service`, `context`, `msg`, the
 * request context's ids when set, and `stack` on errors. A plain object message
 * is merged into the line (the gateway's access line). `pretty` hands every
 * call to Nest's ConsoleLogger, so local output reads as before.
 */
export class JsonLogger implements LoggerService {
  private readonly service: string;
  private readonly threshold: number;
  private readonly pretty?: ConsoleLogger;
  private readonly out: (line: string) => void;

  constructor(options: JsonLoggerOptions) {
    this.service = options.service;
    const level = options.level ?? logLevelFromEnv();
    this.threshold = LEVELS.indexOf(level);
    this.out = options.write ?? ((line) => void process.stdout.write(line));
    if ((options.format ?? logFormatFromEnv()) === 'pretty') {
      this.pretty = new ConsoleLogger();
      this.pretty.setLogLevels(['fatal', ...LEVELS.slice(0, this.threshold + 1)] as LogLevel[]);
    }
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('log', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('verbose', message, params);
  }

  private emit(level: Level | 'fatal', message: unknown, params: unknown[]): void {
    if (LEVELS.indexOf(level === 'fatal' ? 'error' : level) > this.threshold) return;
    if (this.pretty) {
      this.pretty[level](isFields(message) ? String(message.msg ?? '') : message, ...params);
      return;
    }
    // Nest's convention: a Logger with a context passes it last; error(message, stack).
    const rest = [...params];
    const context = rest.length > 0 && typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    let stack: string | undefined;
    if ((level === 'error' || level === 'fatal') && rest.length > 0 && (typeof rest[0] === 'string' || rest[0] === undefined)) {
      stack = rest.shift() as string | undefined;
    }

    let msg: string;
    let fields: Record<string, unknown> = {};
    if (message instanceof Error) {
      msg = message.message;
      stack ??= message.stack;
    } else if (isFields(message)) {
      ({ msg: msg = '', ...fields } = message as { msg?: string });
    } else {
      msg = typeof message === 'string' ? message : safeJson(message);
    }
    if (rest.length > 0) msg = [msg, ...rest.map((p) => (typeof p === 'string' ? p : safeJson(p)))].join(' ');

    const ctx = currentContext();
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: this.service,
      context,
      msg,
      request_id: ctx?.request_id,
      user_id: ctx?.user_id,
      event_id: ctx?.event_id,
      handler: ctx?.handler,
    };
    for (const [key, value] of Object.entries(fields)) if (!(key in line) || line[key] === undefined) line[key] = value;
    if (stack) line.stack = stack;
    this.out(`${safeJson(line)}\n`);
  }
}

/** A plain object: its fields go on the line, `msg` becomes the message. */
function isFields(message: unknown): message is Record<string, unknown> & { msg?: unknown } {
  return typeof message === 'object' && message !== null && Object.getPrototypeOf(message) === Object.prototype;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
