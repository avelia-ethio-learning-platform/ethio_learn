import { ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { QueryFailedError } from 'typeorm';

/** A unique index or constraint rejected the write (Postgres 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof QueryFailedError && (err.driverError as { code?: string } | undefined)?.code === '23505';
}

const INVALID_VALUE = { statusCode: 400, message: 'Invalid value.', error: 'Bad Request' };

/** Postgres SQLSTATE -> the 4xx answer. Bodies are fixed text: never the constraint detail or values. */
const MAPPED: Record<string, { statusCode: number; message: string; error: string }> = {
  '22P02': { statusCode: 400, message: 'Invalid identifier in the request URL or body', error: 'Bad Request' },
  '23505': { statusCode: 409, message: 'This already exists.', error: 'Conflict' },
  '23503': { statusCode: 400, message: "A related record doesn't exist.", error: 'Bad Request' },
  '23502': INVALID_VALUE,
  '22001': INVALID_VALUE,
  '22003': INVALID_VALUE,
};

/**
 * Constraint and data errors a client can cause used to surface as a 500:
 * a malformed id (22P02), a duplicate (23505), a missing referenced row
 * (23503), a null, too-long or out-of-range value (23502, 22001, 22003).
 * Answer 409 or 400 with a fixed message. Every other database error keeps
 * Nest's default handling.
 */
@Catch(QueryFailedError)
export class DbErrorFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(DbErrorFilter.name);

  catch(exception: QueryFailedError, host: ArgumentsHost) {
    const driverError = (exception as { driverError?: { code?: string; table?: string } }).driverError;
    const mapped = driverError?.code ? MAPPED[driverError.code] : undefined;
    if (mapped && host.getType() === 'http') {
      // Code and table only: never the detail, parameters or query.
      this.logger.warn(`Database error ${driverError?.code}${driverError?.table ? ` on ${driverError.table}` : ''} answered ${mapped.statusCode}`);
      host.switchToHttp().getResponse().status(mapped.statusCode).json(mapped);
      return;
    }
    super.catch(exception, host);
  }
}
