import { ArgumentsHost, Catch, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { QueryFailedError } from 'typeorm';

/**
 * A malformed id in a URL (e.g. `/lessons/undefined`) reaches Postgres as an
 * invalid uuid and used to surface as a 500. Postgres reports that as
 * "invalid text representation" (22P02): answer 400 instead. Every other
 * database error keeps Nest's default handling.
 */
@Catch(QueryFailedError)
export class DbErrorFilter extends BaseExceptionFilter {
  catch(exception: QueryFailedError, host: ArgumentsHost) {
    const code = (exception as { driverError?: { code?: string } }).driverError?.code;
    if (code === '22P02' && host.getType() === 'http') {
      host
        .switchToHttp()
        .getResponse()
        .status(HttpStatus.BAD_REQUEST)
        .json({ statusCode: 400, message: 'Invalid identifier in the request URL or body', error: 'Bad Request' });
      return;
    }
    super.catch(exception, host);
  }
}
