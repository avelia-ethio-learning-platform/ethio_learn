import { ArgumentsHost, Catch, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/** The peer answered 404. */
export class PeerNotFoundError extends NotFoundException {}

/** The peer is asleep (Render free tier hibernation): worth retrying in a minute. */
export class PeerAsleepError extends ServiceUnavailableException {
  constructor() {
    super({ statusCode: 503, code: 'service_waking', message: 'A service is waking up. Try again in a minute.' });
  }
}

/** The peer failed, timed out or was unreachable. */
export class PeerUnavailableError extends ServiceUnavailableException {
  constructor() {
    super({ statusCode: 503, code: 'service_unavailable', message: 'A service is not responding. Try again in a minute.' });
  }
}

/** Adds `Retry-After` to the two 503s a caller can retry, then lets Nest answer as usual. */
@Catch(PeerAsleepError, PeerUnavailableError)
export class PeerErrorFilter extends BaseExceptionFilter {
  catch(exception: PeerAsleepError | PeerUnavailableError, host: ArgumentsHost) {
    if (host.getType() === 'http') host.switchToHttp().getResponse().setHeader('Retry-After', '30');
    super.catch(exception, host);
  }
}
