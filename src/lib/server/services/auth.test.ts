import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("bcryptjs", () => ({
	compare: vi.fn(),
}));

vi.mock("../db/index", () => ({
	db: {
		insert: vi.fn(),
		select: vi.fn(),
		delete: vi.fn(),
	},
}));

vi.mock("../db/schema", () => ({
	sessions: {
		id: "sessions.id",
		userId: "sessions.userId",
		expiresAt: "sessions.expiresAt",
	},
	users: {
		id: "users.id",
		email: "users.email",
		passwordHash: "users.passwordHash",
		name: "users.name",
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((col, val) => ({ col, val })),
	sql: Object.assign(
		vi.fn((_strings: TemplateStringsArray, ...values: unknown[]) => values[0]),
		{ raw: vi.fn() },
	),
}));

import * as bcrypt from "bcryptjs";
import { db } from "../db/index";
import {
	clearSessionCookie,
	createSession,
	deleteSession,
	setSessionCookie,
	validateSession,
	verifyPassword,
} from "./auth";

type MockFn = ReturnType<typeof vi.fn>;

const mockBcryptCompare = vi.mocked(bcrypt.compare);
const mockDb = db as unknown as {
	delete: MockFn;
	insert: MockFn;
	select: MockFn;
};

function makeSelectChain(result: unknown[]) {
	const chain: Record<string, Mock> = {};
	chain.from = vi.fn(() => chain);
	chain.innerJoin = vi.fn(() => chain);
	chain.where = vi.fn(() => Promise.resolve(result));
	return chain;
}

function makeInsertChain() {
	const chain: Record<string, Mock> = {};
	chain.values = vi.fn(() => Promise.resolve([]));
	return chain;
}

function makeDeleteChain() {
	const chain: Record<string, Mock> = {};
	chain.where = vi.fn(() => Promise.resolve());
	return chain;
}

describe("verifyPassword", () => {
	it("returns true when password matches hash", async () => {
		mockBcryptCompare.mockImplementation(async () => true);
		const result = await verifyPassword("secret", "$2b$10$hash");
		expect(result).toBe(true);
		expect(mockBcryptCompare).toHaveBeenCalledWith("secret", "$2b$10$hash");
	});

	it("returns false when password does not match hash", async () => {
		mockBcryptCompare.mockImplementation(async () => false);
		const result = await verifyPassword("wrong", "$2b$10$hash");
		expect(result).toBe(false);
	});
});

describe("createSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns a 64-char hex token and expiresAt ~14 days from now by default", async () => {
		const insertChain = makeInsertChain();
		mockDb.insert.mockReturnValue(insertChain);

		const before = Date.now();
		const { token, expiresAt } = await createSession("user-123");
		const after = Date.now();

		expect(token).toMatch(/^[a-f0-9]{64}$/);

		const fourteenDays = 14 * 24 * 60 * 60 * 1000;
		expect(expiresAt).toBeGreaterThanOrEqual(before + fourteenDays - 10);
		expect(expiresAt).toBeLessThanOrEqual(after + fourteenDays + 10);

		expect(mockDb.insert).toHaveBeenCalled();
		expect(insertChain.values).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-123" }),
		);
	});

	it("uses a 1-day expiry when rememberMe is false", async () => {
		const insertChain = makeInsertChain();
		mockDb.insert.mockReturnValue(insertChain);

		const before = Date.now();
		const { expiresAt } = await createSession("user-123", {
			rememberMe: false,
		});
		const after = Date.now();

		const oneDay = 24 * 60 * 60 * 1000;
		expect(expiresAt).toBeGreaterThanOrEqual(before + oneDay - 10);
		expect(expiresAt).toBeLessThanOrEqual(after + oneDay + 10);
	});

	it("creates unique tokens on each call", async () => {
		const insertChain = makeInsertChain();
		mockDb.insert.mockReturnValue(insertChain);

		const { token: t1 } = await createSession("user-1");
		const { token: t2 } = await createSession("user-2");
		expect(t1).not.toBe(t2);
	});
});

describe("validateSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns SessionUser for a valid non-expired session", async () => {
		const futureExpiry = Date.now() + 3600 * 1000;
		const selectChain = makeSelectChain([
			{
				sessions: { id: "tok123", userId: "user-1", expiresAt: futureExpiry },
				users: {
					id: "user-1",
					email: "test@example.com",
					name: "Test User",
					passwordHash: "hash",
				},
			},
		]);
		mockDb.select.mockReturnValue(selectChain);

		const result = await validateSession("tok123");
		expect(result).toEqual({
			id: "user-1",
			email: "test@example.com",
			displayName: "Test User",
			role: "user",
			profilePicture: null,
			titleLanguage: "auto",
			uiLanguage: "en",
		});
	});

	it("uses email as displayName when name is null", async () => {
		const futureExpiry = Date.now() + 3600 * 1000;
		const selectChain = makeSelectChain([
			{
				sessions: { id: "tok123", userId: "user-1", expiresAt: futureExpiry },
				users: {
					id: "user-1",
					email: "noname@example.com",
					name: null,
					passwordHash: "hash",
				},
			},
		]);
		mockDb.select.mockReturnValue(selectChain);

		const result = await validateSession("tok123");
		expect(result?.displayName).toBe("noname@example.com");
	});

	it("returns null when session token not found", async () => {
		const selectChain = makeSelectChain([]);
		mockDb.select.mockReturnValue(selectChain);

		const result = await validateSession("nonexistent");
		expect(result).toBeNull();
	});

	it("returns null and deletes session when expired", async () => {
		const pastExpiry = Date.now() - 1000;
		const selectChain = makeSelectChain([
			{
				sessions: {
					id: "expired-tok",
					userId: "user-1",
					expiresAt: pastExpiry,
				},
				users: {
					id: "user-1",
					email: "test@example.com",
					name: "Test",
					passwordHash: "hash",
				},
			},
		]);
		mockDb.select.mockReturnValue(selectChain);

		const deleteChain = makeDeleteChain();
		mockDb.delete.mockReturnValue(deleteChain);

		const result = await validateSession("expired-tok");
		expect(result).toBeNull();
		expect(mockDb.delete).toHaveBeenCalled();
	});
});

describe("deleteSession", () => {
	it("calls db.delete with the session token", async () => {
		const deleteChain = makeDeleteChain();
		mockDb.delete.mockReturnValue(deleteChain);

		await deleteSession("tok-abc");
		expect(mockDb.delete).toHaveBeenCalled();
		expect(deleteChain.where).toHaveBeenCalled();
	});
});

describe("setSessionCookie", () => {
	it("sets httpOnly cookie with lax sameSite and root path", () => {
		const mockCookies = { set: vi.fn() };
		const expiresAt = Date.now() + 14 * 24 * 60 * 60 * 1000;

		setSessionCookie(mockCookies, "my-token", expiresAt);

		expect(mockCookies.set).toHaveBeenCalledWith(
			"session",
			"my-token",
			expect.objectContaining({
				httpOnly: true,
				sameSite: "lax",
				path: "/",
			}),
		);
		const callArgs = mockCookies.set.mock.calls[0][2];
		expect(callArgs.maxAge).toBeGreaterThan(0);
	});

	it("sets Max-Age for short non-remembered cookies", () => {
		const mockCookies = { set: vi.fn() };
		const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

		setSessionCookie(mockCookies, "my-token", expiresAt, { rememberMe: false });

		expect(mockCookies.set).toHaveBeenCalledWith(
			"session",
			"my-token",
			expect.objectContaining({
				maxAge: expect.any(Number),
			}),
		);
		const callArgs = mockCookies.set.mock.calls[0][2];
		expect(callArgs.maxAge).toBeGreaterThan(0);
		expect(callArgs.maxAge).toBeLessThanOrEqual(24 * 60 * 60);
	});
});

describe("clearSessionCookie", () => {
	it("deletes the session cookie at path /", () => {
		const mockCookies = { delete: vi.fn() };
		clearSessionCookie(mockCookies);
		expect(mockCookies.delete).toHaveBeenCalledWith("session", { path: "/" });
	});
});
