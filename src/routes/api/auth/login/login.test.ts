import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/auth", () => ({
	verifyPassword: vi.fn(),
	createSession: vi.fn(),
	setSessionCookie: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn(),
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	users: {},
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((col, val) => ({ col, val })),
}));

import { db } from "$lib/server/db";
import {
	createSession,
	setSessionCookie,
	verifyPassword,
} from "$lib/server/services/auth";
import {
	_resetLoginRateLimitForTests,
	_setLoginRateLimitSleepForTests,
	LOGIN_RATE_LIMIT_POLICY,
} from "$lib/server/services/login-rate-limit";
import { POST } from "./+server";

const mockVerifyPassword = verifyPassword as ReturnType<typeof vi.fn>;
const mockCreateSession = createSession as ReturnType<typeof vi.fn>;
const mockSetSessionCookie = setSessionCookie as ReturnType<typeof vi.fn>;
type LoginEvent = Parameters<typeof POST>[0];
type MockDb = {
	select: ReturnType<typeof vi.fn>;
};
type SelectChain = {
	from: ReturnType<typeof vi.fn>;
	where: ReturnType<typeof vi.fn>;
	limit: ReturnType<typeof vi.fn>;
};
const mockDb = db as unknown as MockDb;

// A routable address, so the per-address budget is actually exercised.
// resolveRateLimitClientAddress ignores loopback unless ADDRESS_HEADER is set.
const CLIENT_ADDRESS = "203.0.113.10";

function makeEvent(body: unknown, clientAddress = CLIENT_ADDRESS): LoginEvent {
	return {
		request: new Request("http://localhost/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		cookies: {
			set: vi.fn(),
		},
		getClientAddress: () => clientAddress,
	} as unknown as LoginEvent;
}

function makeFormEvent(body: URLSearchParams): LoginEvent {
	return {
		request: new Request("http://localhost/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		}),
		cookies: {
			set: vi.fn(),
		},
		getClientAddress: () => CLIENT_ADDRESS,
	} as unknown as LoginEvent;
}

function makeSelectChain(result: unknown[]) {
	const chain = {} as SelectChain;
	chain.from = vi.fn(() => chain);
	chain.where = vi.fn(() => chain);
	chain.limit = vi.fn(() => Promise.resolve(result));
	return chain;
}

describe("POST /api/auth/login", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// The limiter's buckets are process-lifetime, so without this the
		// deliberate failures in one case would count against the next.
		_resetLoginRateLimitForTests();
		// The over-budget paths below would otherwise spend a real second each
		// waiting out the penalty delay. The delay's own behaviour is covered
		// in src/lib/server/services/login-rate-limit.test.ts.
		_setLoginRateLimitSleepForTests(async () => {});
	});

	it("returns 200 with user object when credentials are valid", async () => {
		const user = {
			id: "user-1",
			email: "alice@example.com",
			name: "Alice",
			passwordHash: "hash",
		};
		mockDb.select.mockReturnValue(makeSelectChain([user]));
		mockVerifyPassword.mockResolvedValue(true);
		mockCreateSession.mockResolvedValue({
			token: "tok-abc",
			expiresAt: Date.now() + 604800000,
		});

		const response = await POST(
			makeEvent({ email: "alice@example.com", password: "correct" }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.user.id).toBe("user-1");
		expect(data.user.email).toBe("alice@example.com");
		expect(data.user.displayName).toBe("Alice");
	});

	it("sets session cookie with the auth helper on successful login", async () => {
		const user = {
			id: "user-1",
			email: "alice@example.com",
			name: "Alice",
			passwordHash: "hash",
		};
		mockDb.select.mockReturnValue(makeSelectChain([user]));
		mockVerifyPassword.mockResolvedValue(true);
		mockCreateSession.mockResolvedValue({
			token: "my-session-token",
			expiresAt: Date.now() + 604800000,
		});

		const event = makeEvent({
			email: "alice@example.com",
			password: "correct",
			rememberMe: true,
		});
		await POST(event);

		expect(mockCreateSession).toHaveBeenCalledWith("user-1", {
			rememberMe: true,
		});
		expect(mockSetSessionCookie).toHaveBeenCalledWith(
			event.cookies,
			"my-session-token",
			expect.any(Number),
			expect.objectContaining({
				rememberMe: true,
			}),
		);
	});

	it("creates a short session when rememberMe is false", async () => {
		const user = {
			id: "user-1",
			email: "alice@example.com",
			name: "Alice",
			passwordHash: "hash",
		};
		mockDb.select.mockReturnValue(makeSelectChain([user]));
		mockVerifyPassword.mockResolvedValue(true);
		mockCreateSession.mockResolvedValue({
			token: "session-only-token",
			expiresAt: Date.now() + 604800000,
		});

		const event = makeEvent({
			email: "alice@example.com",
			password: "correct",
			rememberMe: false,
		});
		await POST(event);

		expect(mockCreateSession).toHaveBeenCalledWith("user-1", {
			rememberMe: false,
		});
		expect(mockSetSessionCookie).toHaveBeenCalledWith(
			event.cookies,
			"session-only-token",
			expect.any(Number),
			expect.objectContaining({
				rememberMe: false,
			}),
		);
	});

	it("sets a persistent cookie when rememberMe is true", async () => {
		const user = {
			id: "user-1",
			email: "alice@example.com",
			name: "Alice",
			passwordHash: "hash",
		};
		mockDb.select.mockReturnValue(makeSelectChain([user]));
		mockVerifyPassword.mockResolvedValue(true);
		mockCreateSession.mockResolvedValue({
			token: "persistent-token",
			expiresAt: Date.now() + 604800000,
		});

		const event = makeEvent({
			email: "alice@example.com",
			password: "correct",
			rememberMe: true,
		});
		await POST(event);

		expect(mockSetSessionCookie).toHaveBeenCalledWith(
			event.cookies,
			"persistent-token",
			expect.any(Number),
			expect.objectContaining({
				rememberMe: true,
			}),
		);
	});

	it("redirects native form login and maps checkbox value to rememberMe", async () => {
		const user = {
			id: "user-1",
			email: "alice@example.com",
			name: "Alice",
			passwordHash: "hash",
		};
		mockDb.select.mockReturnValue(makeSelectChain([user]));
		mockVerifyPassword.mockResolvedValue(true);
		mockCreateSession.mockResolvedValue({
			token: "form-token",
			expiresAt: Date.now() + 604800000,
		});

		const event = makeFormEvent(
			new URLSearchParams({
				email: "alice@example.com",
				password: "correct",
				rememberMe: "true",
			}),
		);
		const response = await POST(event);

		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe("/");
		expect(mockSetSessionCookie).toHaveBeenCalledWith(
			event.cookies,
			"form-token",
			expect.any(Number),
			expect.objectContaining({
				rememberMe: true,
			}),
		);
	});

	it("returns 401 with generic error when user email does not exist", async () => {
		mockDb.select.mockReturnValue(makeSelectChain([]));

		const response = await POST(
			makeEvent({ email: "nobody@example.com", password: "any" }),
		);
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data.error).toBe("Invalid email or password");
		// A password comparison still runs, against a decoy hash. Returning
		// before the bcrypt work would make the unknown-account path roughly
		// 250ms faster than the wrong-password path, which answers "does this
		// account exist?" just as clearly as a different error message would.
		expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
	});

	it("returns 401 with same generic error when password is wrong", async () => {
		const user = {
			id: "user-1",
			email: "alice@example.com",
			name: "Alice",
			passwordHash: "hash",
		};
		mockDb.select.mockReturnValue(makeSelectChain([user]));
		mockVerifyPassword.mockResolvedValue(false);

		const response = await POST(
			makeEvent({ email: "alice@example.com", password: "wrong" }),
		);
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data.error).toBe("Invalid email or password");
	});

	it("returns 401 for non-existent user (any string accepted as email)", async () => {
		const response = await POST(
			makeEvent({ email: "not-an-email", password: "pass" }),
		);
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data.error).toBe("Invalid email or password");
	});

	it("returns 400 when password field is missing", async () => {
		const response = await POST(makeEvent({ email: "alice@example.com" }));

		expect(response.status).toBe(400);
	});

	it("uses email as displayName when user has no name", async () => {
		const user = {
			id: "user-2",
			email: "noname@example.com",
			name: null,
			passwordHash: "hash",
		};
		mockDb.select.mockReturnValue(makeSelectChain([user]));
		mockVerifyPassword.mockResolvedValue(true);
		mockCreateSession.mockResolvedValue({
			token: "tok-xyz",
			expiresAt: Date.now() + 604800000,
		});

		const response = await POST(
			makeEvent({ email: "noname@example.com", password: "pass" }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.user.displayName).toBe("noname@example.com");
	});

	describe("rate limiting", () => {
		const user = {
			id: "user-1",
			email: "alice@example.com",
			name: "Alice",
			passwordHash: "hash",
		};

		function arrangeWrongPassword() {
			mockDb.select.mockReturnValue(makeSelectChain([user]));
			mockVerifyPassword.mockResolvedValue(false);
		}

		function arrangeCorrectPassword() {
			mockDb.select.mockReturnValue(makeSelectChain([user]));
			mockVerifyPassword.mockResolvedValue(true);
			mockCreateSession.mockResolvedValue({
				token: "tok",
				expiresAt: Date.now() + 604800000,
			});
		}

		async function failLogin(email = "alice@example.com", address?: string) {
			return POST(makeEvent({ email, password: "wrong" }, address));
		}

		it("returns 429 with Retry-After once the per-email cap is reached", async () => {
			arrangeWrongPassword();
			const cap = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerEmail;

			for (let attempt = 0; attempt < cap; attempt += 1) {
				expect((await failLogin()).status).toBe(401);
			}

			const response = await failLogin();
			const data = await response.json();

			expect(response.status).toBe(429);
			expect(data.errorKey).toBe("login.tooManyAttempts");
			const retryAfter = Number(response.headers.get("Retry-After"));
			expect(retryAfter).toBeGreaterThan(0);
			expect(retryAfter).toBeLessThanOrEqual(
				LOGIN_RATE_LIMIT_POLICY.windowMs / 1000,
			);
		});

		// The account-lockout question, at the route level. Anybody can put
		// anybody's email over the budget from anywhere, so if being over the
		// budget refused the request outright, a stranger who knows the owner's
		// address could keep this deployment's only door shut indefinitely.
		it("still lets the CORRECT password through once the budget is blown", async () => {
			arrangeWrongPassword();
			const cap = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerEmail;
			for (let attempt = 0; attempt < cap * 2; attempt += 1) await failLogin();

			arrangeCorrectPassword();
			const response = await POST(
				makeEvent({ email: "alice@example.com", password: "correct" }),
			);

			expect(response.status).toBe(200);

			// And getting in clears the budget, so the next mistake is an
			// ordinary 401 again.
			arrangeWrongPassword();
			expect((await failLogin()).status).toBe(401);
		});

		it("refuses a concurrent over-budget attempt without burning a hash", async () => {
			arrangeWrongPassword();
			const cap = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerEmail;
			for (let attempt = 0; attempt < cap; attempt += 1) await failLogin();

			// Hold the first over-budget comparison open, then fire a second.
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let markEntered: (() => void) | undefined;
			const entered = new Promise<void>((resolve) => {
				markEntered = resolve;
			});
			mockVerifyPassword.mockImplementation(async () => {
				markEntered?.();
				await gate;
				return false;
			});

			const first = failLogin();
			// Deterministic: the first request is now provably inside bcrypt and
			// holding the key's single in-flight slot.
			await entered;
			const comparisonsBefore = mockVerifyPassword.mock.calls.length;

			const second = await failLogin();

			// This is what caps an attacker's guess rate however many
			// connections they open: the second attempt never reaches bcrypt.
			expect(second.status).toBe(429);
			expect(mockVerifyPassword.mock.calls.length).toBe(comparisonsBefore);

			release?.();
			expect((await first).status).toBe(429);
		});

		it("does not count successful logins", async () => {
			arrangeCorrectPassword();
			const attempts = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAddress + 10;

			for (let attempt = 0; attempt < attempts; attempt += 1) {
				const response = await POST(
					makeEvent({ email: "alice@example.com", password: "correct" }),
				);
				expect(response.status).toBe(200);
			}
		});

		it("resets the email budget after a success", async () => {
			const cap = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerEmail;

			arrangeWrongPassword();
			for (let attempt = 0; attempt < cap - 1; attempt += 1) await failLogin();

			arrangeCorrectPassword();
			expect(
				(
					await POST(
						makeEvent({ email: "alice@example.com", password: "correct" }),
					)
				).status,
			).toBe(200);

			// Budget is clean again, so the next wrong password is a 401 rather
			// than the 429 it would have been without the reset.
			arrangeWrongPassword();
			expect((await failLogin()).status).toBe(401);
		});

		it("caps an address that is spraying many different accounts", async () => {
			// Every attempt is a different email, so the per-email budget never
			// bites; only the per-address budget can stop this.
			mockDb.select.mockReturnValue(makeSelectChain([]));
			const cap = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAddress;

			for (let attempt = 0; attempt < cap; attempt += 1) {
				const response = await failLogin(`victim-${attempt}@example.com`);
				expect(response.status).toBe(401);
			}

			const response = await failLogin("victim-final@example.com");
			expect(response.status).toBe(429);
			expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
		});

		it("does not let one address's failures throttle another", async () => {
			mockDb.select.mockReturnValue(makeSelectChain([]));
			const cap = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAddress;

			for (let attempt = 0; attempt < cap; attempt += 1) {
				await failLogin(`victim-${attempt}@example.com`);
			}
			expect((await failLogin("someone@example.com")).status).toBe(429);

			const other = await failLogin("someone-else@example.com", "198.51.100.7");
			expect(other.status).toBe(401);
		});

		it("ignores a proxy's loopback address instead of giving everyone one shared budget", async () => {
			// This is production's shape today: Apache proxies from 127.0.0.1 and
			// adapter-node has no ADDRESS_HEADER, so getClientAddress() is the same
			// for every human on the internet. Keying the address budget on that
			// would lock the whole product out after 30 typos.
			mockDb.select.mockReturnValue(makeSelectChain([]));
			const attempts = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAddress + 5;

			for (let attempt = 0; attempt < attempts; attempt += 1) {
				const response = await failLogin(
					`person-${attempt}@example.com`,
					"127.0.0.1",
				);
				expect(response.status).toBe(401);
			}
		});
	});
});
