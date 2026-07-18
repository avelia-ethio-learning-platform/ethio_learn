import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, getAuth, setAuth } from './api';

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api()', () => {
  it('returns the parsed JSON body on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { hello: 'world' }));
    expect(await api('/courses/c1')).toEqual({ hello: 'world' });
  });

  it('sends the bearer token from stored auth', async () => {
    setAuth({ access_token: 'tok-123', user: { id: 'u1', name: 'N', email: 'e', role: 'learner' } });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await api('/enrollments');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer tok-123');
  });

  it('throws ApiError with the server message on failure', async () => {
    // Fresh Response per call — a Response body can only be consumed once.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(403, { message: 'Not your enrollment' })));
    await expect(api('/enrollments/x')).rejects.toMatchObject({ status: 403, message: 'Not your enrollment' });
    await expect(api('/enrollments/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('joins array validation messages', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(400, { message: ['a is required', 'b is required'] })));
    await expect(api('/x')).rejects.toMatchObject({ message: 'a is required, b is required' });
  });

  it('retries once via the refresh cookie on 401, then replays the request', async () => {
    setAuth({ access_token: 'expired', user: { id: 'u1', name: 'N', email: 'e', role: 'learner' } });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'jwt expired' })) // original call
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'fresh', user: { id: 'u1', name: 'N', email: 'e', role: 'learner' } })) // refresh
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })); // replay

    expect(await api('/enrollments')).toEqual({ ok: true });
    expect(getAuth()?.access_token).toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clears stored auth when the refresh also fails', async () => {
    setAuth({ access_token: 'expired', user: { id: 'u1', name: 'N', email: 'e', role: 'learner' } });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { message: 'jwt expired' }))
      .mockResolvedValueOnce(jsonResponse(401, { message: 'no cookie' }));

    await expect(api('/enrollments')).rejects.toMatchObject({ status: 401 });
    expect(getAuth()).toBeNull();
  });
});
