import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/**
 * Guards service-to-service endpoints. Cross-service reads travel through the
 * API Gateway carrying `x-internal-token`; this guard verifies it again at the
 * service (defense in depth).
 */
@Injectable()
export class InternalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    // Byte lengths: a non-ASCII token of the right character count must be a 401, not a timingSafeEqual throw.
    const presented = Buffer.from(String(req.headers['x-internal-token'] ?? ''));
    const expected = Buffer.from(process.env.INTERNAL_API_TOKEN ?? '');
    if (expected.length === 0 || presented.length !== expected.length) {
      throw new UnauthorizedException('Internal endpoint');
    }
    if (!timingSafeEqual(presented, expected)) {
      throw new UnauthorizedException('Internal endpoint');
    }
    return true;
  }
}
