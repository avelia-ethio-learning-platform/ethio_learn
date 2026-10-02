import { describe, expect, it } from 'vitest';
import { isHibernation } from './hibernation';

const none = new Headers();

describe('isHibernation', () => {
  it('is never true for a status other than 429', () => {
    expect(isHibernation(503, none, 'Service Unavailable')).toBe(false);
    expect(isHibernation(200, new Headers({ 'x-render-routing': 'hibernate-rate-limited' }), '')).toBe(false);
  });

  it('trusts the Render header when it is readable (server side)', () => {
    const headers = new Headers({ 'x-render-routing': 'hibernate-rate-limited' });
    expect(isHibernation(429, headers, JSON.stringify({ statusCode: 429 }))).toBe(true);
  });

  it('treats a plain-text 429 without a readable header as hibernation (the browser case)', () => {
    expect(isHibernation(429, none, 'Too Many Requests')).toBe(true);
    expect(isHibernation(429, none, '')).toBe(true);
  });

  it("leaves the gateway limiter's JSON 429 alone", () => {
    const body = JSON.stringify({ statusCode: 429, message: 'Too many requests — please slow down and try again shortly.' });
    expect(isHibernation(429, none, body)).toBe(false);
  });

  it('treats JSON that is not the limiter shape as hibernation', () => {
    expect(isHibernation(429, none, JSON.stringify({ error: 'x' }))).toBe(true);
    expect(isHibernation(429, none, 'null')).toBe(true);
  });
});
