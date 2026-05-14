import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('bcryptjs', () => ({
  compare: vi.fn()
}));

vi.mock('../db/index', () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    delete: vi.fn(),
  }
}));

vi.mock('../db/schema', () => ({
  sessions: { id: 'sessions.id', userId: 'sessions.userId', expiresAt: 'sessions.expiresAt' },
  users: { id: 'users.id', email: 'users.email', passwordHash: 'users.passwordHash', name: 'users.name' }
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  sql: Object.assign(vi.fn((strings: TemplateStringsArray, ...values: any[]) => values[0]), { raw: vi.fn() }),
}));

import * as bcrypt from 'bcryptjs';
import { db } from '../db/index';
import {
  verifyPassword,
  createSession,
  validateSession,
  deleteSession,
  setSessionCookie,
  clearSessionCookie
} from './auth';

const mockBcrypt = bcrypt as any;
const mockDb = db as any;

function makeSelectChain(result: any[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(result));
  return chain;
}

function makeInsertChain() {
  const chain: any = {};
  chain.values = vi.fn(() => Promise.resolve([]));
  return chain;
}

function makeDeleteChain() {
  const chain: any = {};
  chain.where = vi.fn(() => Promise.resolve());
  return chain;
}

describe('verifyPassword', () => {
  it('returns true when password matches hash', async () => {
    mockBcrypt.compare.mockResolvedValue(true);
    const result = await verifyPassword('secret', '$2b$10$hash');
    expect(result).toBe(true);
    expect(mockBcrypt.compare).toHaveBeenCalledWith('secret', '$2b$10$hash');
  });

  it('returns false when password does not match hash', async () => {
    mockBcrypt.compare.mockResolvedValue(false);
    const result = await verifyPassword('wrong', '$2b$10$hash');
    expect(result).toBe(false);
  });
});

describe('createSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a 64-char hex token and expiresAt ~7 days from now', async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain);

    const before = Date.now();
    const { token, expiresAt } = await createSession('user-123');
    const after = Date.now();

    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + sevenDays - 10);
    expect(expiresAt).toBeLessThanOrEqual(after + sevenDays + 10);

    expect(mockDb.insert).toHaveBeenCalled();
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' })
    );
  });

  it('creates unique tokens on each call', async () => {
    const insertChain = makeInsertChain();
    mockDb.insert.mockReturnValue(insertChain);

    const { token: t1 } = await createSession('user-1');
    const { token: t2 } = await createSession('user-2');
    expect(t1).not.toBe(t2);
  });
});

describe('validateSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SessionUser for a valid non-expired session', async () => {
    const futureExpiry = Date.now() + 3600 * 1000;
    const selectChain = makeSelectChain([{
      sessions: { id: 'tok123', userId: 'user-1', expiresAt: futureExpiry },
      users: { id: 'user-1', email: 'test@example.com', name: 'Test User', passwordHash: 'hash' }
    }]);
    mockDb.select.mockReturnValue(selectChain);

    const result = await validateSession('tok123');
    expect(result).toEqual({
      id: 'user-1',
      email: 'test@example.com',
      displayName: 'Test User',
      role: 'user',
      avatarId: null,
      profilePicture: null,
      titleLanguage: 'auto',
      uiLanguage: 'en'
    });
  });

  it('uses email as displayName when name is null', async () => {
    const futureExpiry = Date.now() + 3600 * 1000;
    const selectChain = makeSelectChain([{
      sessions: { id: 'tok123', userId: 'user-1', expiresAt: futureExpiry },
      users: { id: 'user-1', email: 'noname@example.com', name: null, passwordHash: 'hash' }
    }]);
    mockDb.select.mockReturnValue(selectChain);

    const result = await validateSession('tok123');
    expect(result?.displayName).toBe('noname@example.com');
  });

  it('returns null when session token not found', async () => {
    const selectChain = makeSelectChain([]);
    mockDb.select.mockReturnValue(selectChain);

    const result = await validateSession('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null and deletes session when expired', async () => {
    const pastExpiry = Date.now() - 1000;
    const selectChain = makeSelectChain([{
      sessions: { id: 'expired-tok', userId: 'user-1', expiresAt: pastExpiry },
      users: { id: 'user-1', email: 'test@example.com', name: 'Test', passwordHash: 'hash' }
    }]);
    mockDb.select.mockReturnValue(selectChain);

    const deleteChain = makeDeleteChain();
    mockDb.delete.mockReturnValue(deleteChain);

    const result = await validateSession('expired-tok');
    expect(result).toBeNull();
    expect(mockDb.delete).toHaveBeenCalled();
  });
});

describe('deleteSession', () => {
  it('calls db.delete with the session token', async () => {
    const deleteChain = makeDeleteChain();
    mockDb.delete.mockReturnValue(deleteChain);

    await deleteSession('tok-abc');
    expect(mockDb.delete).toHaveBeenCalled();
    expect(deleteChain.where).toHaveBeenCalled();
  });
});

describe('setSessionCookie', () => {
  it('sets httpOnly cookie with lax sameSite and root path', () => {
    const mockCookies = { set: vi.fn() };
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

    setSessionCookie(mockCookies, 'my-token', expiresAt);

    expect(mockCookies.set).toHaveBeenCalledWith(
      'session',
      'my-token',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      })
    );
    const callArgs = mockCookies.set.mock.calls[0][2];
    expect(callArgs.maxAge).toBeGreaterThan(0);
  });

  it('omits maxAge for browser-session cookies', () => {
    const mockCookies = { set: vi.fn() };
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

    setSessionCookie(mockCookies, 'my-token', expiresAt, { rememberMe: false });

    expect(mockCookies.set).toHaveBeenCalledWith(
      'session',
      'my-token',
      expect.not.objectContaining({
        maxAge: expect.any(Number),
      })
    );
  });
});

describe('clearSessionCookie', () => {
  it('deletes the session cookie at path /', () => {
    const mockCookies = { delete: vi.fn() };
    clearSessionCookie(mockCookies);
    expect(mockCookies.delete).toHaveBeenCalledWith('session', { path: '/' });
  });
});
