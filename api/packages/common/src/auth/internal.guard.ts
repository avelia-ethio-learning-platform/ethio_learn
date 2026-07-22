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
    const presented = String(req.headers['x-internal-token'] ?? '');
    const expected = process.env.INTERNAL_API_TOKEN ?? '';
    if (!expected || presented.length !== expected.length) {
      throw new UnauthorizedException('Internal endpoint');
    }
    if (!timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
      throw new UnauthorizedException('Internal endpoint');
    }
    return true;
  }
}
