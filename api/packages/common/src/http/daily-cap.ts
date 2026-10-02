import { HttpException, HttpStatus } from '@nestjs/common';

/** 429 in the standard error envelope for a per-account daily cap ("referral invites", "gifts", ...). */
export function dailyCapExceeded(what: string): HttpException {
  return new HttpException(`You've reached today's limit for ${what}. Try again tomorrow.`, HttpStatus.TOO_MANY_REQUESTS);
}

/** 429 for a per-recipient daily cap. */
export function recipientCapExceeded(what: string): HttpException {
  return new HttpException(`You've reached today's limit for ${what} to this email. Try again tomorrow.`, HttpStatus.TOO_MANY_REQUESTS);
}
