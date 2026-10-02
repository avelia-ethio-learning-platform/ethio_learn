import { ArgumentMetadata, BadRequestException, Param, ParseUUIDPipe, PipeTransform } from '@nestjs/common';

/**
 * Route param that must be a uuid: 400 before any service code runs.
 * No version option on purpose: the loose "all" check also accepts the nil
 * uuid (PLATFORM_PAYEE_ID) and fixed seed ids.
 */
export const UuidParam = (name: string): ParameterDecorator => Param(name, new ParseUUIDPipe());

/** Rejects (400) any route param that does not fully match `pattern`; the value is passed through unchanged. */
class RegexParamPipe implements PipeTransform<string, string> {
  constructor(
    private readonly pattern: RegExp,
    private readonly label: string,
  ) {}

  transform(value: string, _metadata?: ArgumentMetadata): string {
    if (typeof value !== 'string' || !this.pattern.test(value)) {
      throw new BadRequestException(`Invalid ${this.label}`);
    }
    return value;
  }
}

/** Institution invite token: `randomBytes(32).toString('hex')`. */
export class InviteTokenPipe extends RegexParamPipe {
  constructor() {
    super(/^[0-9a-f]{64}$/, 'invite token');
  }
}

/** Pay-request token: 24 chars of the financial service's CODE_ALPHABET. */
export class PayRequestTokenPipe extends RegexParamPipe {
  constructor() {
    super(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{24}$/, 'pay request token');
  }
}

/** Certificate uid: a `randomUUID()` string held in a varchar column, so case is kept. */
export class CertificateUidPipe extends RegexParamPipe {
  constructor() {
    super(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 'certificate id');
  }
}
