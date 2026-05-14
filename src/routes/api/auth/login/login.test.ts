import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/services/auth', () => ({
  verifyPassword: vi.fn(),
  createSession: vi.fn(),
  setSessionCookie: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({
  db: {
    select: vi.fn(),
  }
}));

vi.mock('$lib/server/db/schema', () => ({
  users: {}
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

import { POST } from './+server';
import { verifyPassword, createSession, setSessionCookie } from '$lib/server/services/auth';
import { db } from '$lib/server/db';

const mockVerifyPassword = verifyPassword as ReturnType<typeof vi.fn>;
const mockCreateSession = createSession as ReturnType<typeof vi.fn>;
const mockSetSessionCookie = setSessionCookie as ReturnType<typeof vi.fn>;
const mockDb = db as any;

function makeEvent(body: unknown) {
  return {
    request: new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    cookies: {
      set: vi.fn(),
    },
  } as any;
}

function makeFormEvent(body: URLSearchParams) {
  return {
    request: new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }),
    cookies: {
      set: vi.fn(),
    },
  } as any;
}

function makeSelectChain(result: any[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(result));
  return chain;
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with user object when credentials are valid', async () => {
    const user = { id: 'user-1', email: 'alice@example.com', name: 'Alice', passwordHash: 'hash' };
    mockDb.select.mockReturnValue(makeSelectChain([user]));
    mockVerifyPassword.mockResolvedValue(true);
    mockCreateSession.mockResolvedValue({ token: 'tok-abc', expiresAt: Date.now() + 604800000 });

    const response = await POST(makeEvent({ email: 'alice@example.com', password: 'correct' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.user.id).toBe('user-1');
    expect(data.user.email).toBe('alice@example.com');
    expect(data.user.displayName).toBe('Alice');
  });

  it('sets session cookie with the auth helper on successful login', async () => {
    const user = { id: 'user-1', email: 'alice@example.com', name: 'Alice', passwordHash: 'hash' };
    mockDb.select.mockReturnValue(makeSelectChain([user]));
    mockVerifyPassword.mockResolvedValue(true);
    mockCreateSession.mockResolvedValue({ token: 'my-session-token', expiresAt: Date.now() + 604800000 });

    const event = makeEvent({ email: 'alice@example.com', password: 'correct', rememberMe: true });
    await POST(event);

    expect(mockCreateSession).toHaveBeenCalledWith('user-1', { rememberMe: true });
    expect(mockSetSessionCookie).toHaveBeenCalledWith(
      event.cookies,
      'my-session-token',
      expect.any(Number),
      expect.objectContaining({
        rememberMe: true,
      })
    );
  });

  it('creates a short session when rememberMe is false', async () => {
    const user = { id: 'user-1', email: 'alice@example.com', name: 'Alice', passwordHash: 'hash' };
    mockDb.select.mockReturnValue(makeSelectChain([user]));
    mockVerifyPassword.mockResolvedValue(true);
    mockCreateSession.mockResolvedValue({ token: 'session-only-token', expiresAt: Date.now() + 604800000 });

    const event = makeEvent({
      email: 'alice@example.com',
      password: 'correct',
      rememberMe: false,
    });
    await POST(event);

    expect(mockCreateSession).toHaveBeenCalledWith('user-1', { rememberMe: false });
    expect(mockSetSessionCookie).toHaveBeenCalledWith(
      event.cookies,
      'session-only-token',
      expect.any(Number),
      expect.objectContaining({
        rememberMe: false,
      })
    );
  });

  it('sets a persistent cookie when rememberMe is true', async () => {
    const user = { id: 'user-1', email: 'alice@example.com', name: 'Alice', passwordHash: 'hash' };
    mockDb.select.mockReturnValue(makeSelectChain([user]));
    mockVerifyPassword.mockResolvedValue(true);
    mockCreateSession.mockResolvedValue({ token: 'persistent-token', expiresAt: Date.now() + 604800000 });

    const event = makeEvent({
      email: 'alice@example.com',
      password: 'correct',
      rememberMe: true,
    });
    await POST(event);

    expect(mockSetSessionCookie).toHaveBeenCalledWith(
      event.cookies,
      'persistent-token',
      expect.any(Number),
      expect.objectContaining({
        rememberMe: true,
      })
    );
  });

  it('redirects native form login and maps checkbox value to rememberMe', async () => {
    const user = { id: 'user-1', email: 'alice@example.com', name: 'Alice', passwordHash: 'hash' };
    mockDb.select.mockReturnValue(makeSelectChain([user]));
    mockVerifyPassword.mockResolvedValue(true);
    mockCreateSession.mockResolvedValue({ token: 'form-token', expiresAt: Date.now() + 604800000 });

    const event = makeFormEvent(new URLSearchParams({
      email: 'alice@example.com',
      password: 'correct',
      rememberMe: 'true',
    }));
    const response = await POST(event);

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/');
    expect(mockSetSessionCookie).toHaveBeenCalledWith(
      event.cookies,
      'form-token',
      expect.any(Number),
      expect.objectContaining({
        rememberMe: true,
      })
    );
  });

  it('returns 401 with generic error when user email does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));

    const response = await POST(makeEvent({ email: 'nobody@example.com', password: 'any' }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Invalid email or password');
    expect(mockVerifyPassword).not.toHaveBeenCalled();
  });

  it('returns 401 with same generic error when password is wrong', async () => {
    const user = { id: 'user-1', email: 'alice@example.com', name: 'Alice', passwordHash: 'hash' };
    mockDb.select.mockReturnValue(makeSelectChain([user]));
    mockVerifyPassword.mockResolvedValue(false);

    const response = await POST(makeEvent({ email: 'alice@example.com', password: 'wrong' }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Invalid email or password');
  });

  it('returns 401 for non-existent user (any string accepted as email)', async () => {
    const response = await POST(makeEvent({ email: 'not-an-email', password: 'pass' }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Invalid email or password');
  });

  it('returns 400 when password field is missing', async () => {
    const response = await POST(makeEvent({ email: 'alice@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(400);
  });

  it('uses email as displayName when user has no name', async () => {
    const user = { id: 'user-2', email: 'noname@example.com', name: null, passwordHash: 'hash' };
    mockDb.select.mockReturnValue(makeSelectChain([user]));
    mockVerifyPassword.mockResolvedValue(true);
    mockCreateSession.mockResolvedValue({ token: 'tok-xyz', expiresAt: Date.now() + 604800000 });

    const response = await POST(makeEvent({ email: 'noname@example.com', password: 'pass' }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.user.displayName).toBe('noname@example.com');
  });
});
