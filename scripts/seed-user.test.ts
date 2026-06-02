import { describe, it, expect, vi } from 'vitest';

vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, mkdirSync: vi.fn(), existsSync: vi.fn().mockReturnValue(true) };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const mockedExecSync = vi.fn();
  return {
    ...actual,
    default: { ...actual, execSync: mockedExecSync },
    execSync: mockedExecSync,
  };
});
vi.mock('bcryptjs', () => ({ default: { hashSync: vi.fn().mockReturnValue('hashed-password') } }));
vi.mock('$lib/server/db/index', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));
vi.mock('$lib/server/db/schema', () => ({ users: {} }));

import { execSync } from 'child_process';
import bcrypt from 'bcryptjs';
import { db } from '$lib/server/db/index';

process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-for-validation';
process.env.DATABASE_PATH = './data/test.db';
process.argv = ['node', 'seed-user.ts'];

describe('seed-user script', () => {
  it('runs the script and invokes all expected side effects with default args', async () => {
    await import('../scripts/seed-user');

    expect(vi.mocked(execSync)).toHaveBeenCalledWith('npm run db:prepare', { stdio: 'inherit' });
    expect(vi.mocked(bcrypt.hashSync)).toHaveBeenCalledWith('admin123', 10);
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
    const insertResult = vi.mocked(db.insert).mock.results[0].value;
    expect(insertResult.values).toHaveBeenCalledWith(expect.objectContaining({
      email: 'admin@local',
      name: 'Admin User',
      passwordHash: 'hashed-password',
    }));
  });

  it('db mock is correctly structured', () => {
    expect(typeof db.insert).toBe('function');
  });

  it('execSync mock is correctly structured', () => {
    expect(typeof execSync).toBe('function');
  });

  it('bcrypt.hashSync mock is correctly structured', () => {
    expect(typeof bcrypt.hashSync).toBe('function');
  });

  it('dotenv mock prevents real env loading', async () => {
    const { config } = await import('dotenv');
    expect(typeof config).toBe('function');
  });
});
