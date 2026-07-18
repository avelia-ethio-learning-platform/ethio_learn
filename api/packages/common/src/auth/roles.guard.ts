import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@ethiopialearn/contracts';
import { userFromRequest } from './user-context';

export const ROLES_KEY = 'el_roles';

/**
 * Requires an authenticated caller (gateway-forwarded identity headers).
 * Pass roles to additionally restrict; pass none to allow any authenticated role.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest();
    const user = userFromRequest(req);
    if (!user) throw new UnauthorizedException('Authentication required');
    if (roles && roles.length > 0 && !roles.includes(user.role)) {
      throw new ForbiddenException(`Requires role: ${roles.join(' | ')}`);
    }
    return true;
  }
}
