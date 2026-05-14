import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { login } from './auth';

describe('client auth API', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        user: {
          id: 'user-1',
          email: 'alice@example.com',
          displayName: 'Alice',
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    ));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends rememberMe in the JSON login payload', async () => {
    await login('alice@example.com', 'correct', true);

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'alice@example.com',
      password: 'correct',
      rememberMe: true,
    });
  });

  it('defaults rememberMe to false', async () => {
    await login('alice@example.com', 'correct');

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'alice@example.com',
      password: 'correct',
      rememberMe: false,
    });
  });
});
