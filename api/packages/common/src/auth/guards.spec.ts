import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@ethiopialearn/contracts';
import { InternalGuard } from './internal.guard';
import { RolesGuard } from './roles.guard';
import { userFromRequest } from './user-context';

function contextFor(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function rolesGuardWith(required: Role[] | undefined): RolesGuard {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(required) } as unknown as Reflector;
  return new RolesGuard(reflector);
}

describe('userFromRequest', () => {
  it('builds the context from gateway identity headers', () => {
    const user = userFromRequest({
      headers: { 'x-user-id': 'u1', 'x-user-role': 'learner', 'x-user-email': 'a%40b.et' },
    });
    expect(user).toEqual({ id: 'u1', role: 'learner', email: 'a@b.et' });
  });

  it('returns null when identity headers are absent', () => {
    expect(userFromRequest({ headers: {} })).toBeNull();
    expect(userFromRequest({ headers: { 'x-user-id': 'u1' } })).toBeNull();
  });
});

describe('RolesGuard', () => {
  it('rejects unauthenticated requests', () => {
    expect(() => rolesGuardWith([Role.LEARNER]).canActivate(contextFor({}))).toThrow(UnauthorizedException);
  });

  it('rejects the wrong role', () => {
    const ctx = contextFor({ 'x-user-id': 'u1', 'x-user-role': Role.EDUCATOR });
    expect(() => rolesGuardWith([Role.LEARNER]).canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('accepts a matching role', () => {
    const ctx = contextFor({ 'x-user-id': 'u1', 'x-user-role': Role.LEARNER });
    expect(rolesGuardWith([Role.LEARNER]).canActivate(ctx)).toBe(true);
  });

  it('accepts any authenticated role when no roles are specified', () => {
    const ctx = contextFor({ 'x-user-id': 'u1', 'x-user-role': Role.QUALITY_OFFICER });
    expect(rolesGuardWith([]).canActivate(ctx)).toBe(true);
    expect(rolesGuardWith(undefined).canActivate(ctx)).toBe(true);
  });
});

describe('InternalGuard', () => {
  const guard = new InternalGuard();

  beforeEach(() => {
    process.env.INTERNAL_API_TOKEN = 'secret-internal-token';
  });

  it('accepts the exact shared token', () => {
    expect(guard.canActivate(contextFor({ 'x-internal-token': 'secret-internal-token' }))).toBe(true);
  });

  it('rejects a wrong or missing token', () => {
    expect(() => guard.canActivate(contextFor({ 'x-internal-token': 'wrong-internal-tokenn' }))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(contextFor({}))).toThrow(UnauthorizedException);
  });

  it('rejects everything when the expected token is unset (fail closed)', () => {
    delete process.env.INTERNAL_API_TOKEN;
    expect(() => guard.canActivate(contextFor({ 'x-internal-token': '' }))).toThrow(UnauthorizedException);
  });
});
