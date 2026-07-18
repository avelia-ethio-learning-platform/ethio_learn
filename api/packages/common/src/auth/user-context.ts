import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from '@ethiopialearn/contracts';

/**
 * The API Gateway is the sole authenticator. After verifying the JWT it
 * forwards the caller identity to services via these internal headers.
 * Services are never exposed to the internet, so the headers are trustworthy
 * inside the private network.
 */
export interface UserContext {
  id: string;
  role: Role;
  email: string;
}

export function userFromRequest(req: { headers: Record<string, string | string[] | undefined> }): UserContext | null {
  const id = req.headers['x-user-id'];
  const role = req.headers['x-user-role'];
  const email = req.headers['x-user-email'];
  if (!id || !role) return null;
  return {
    id: String(id),
    role: String(role) as Role,
    email: email ? decodeURIComponent(String(email)) : '',
  };
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): UserContext | null => {
  return userFromRequest(ctx.switchToHttp().getRequest());
});
