import { randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import {
	_resetLoginRateLimitForTests,
	_setLoginRateLimitSleepForTests,
	LOGIN_RATE_LIMIT_POLICY,
} from "$lib/server/services/login-rate-limit";
import { PATCH as changePasswordRoute } from "../password/+server";
import { PATCH as changeEmailRoute } from "../profile/+server";
import {
	POST as clearWorkspaceRoute,
	DELETE as deleteAccountRoute,
} from "./+server";
import { POST as downloadArchiveRoute } from "./archive/+server";
import { POST as clearMemoryRoute } from "./clear-memory/+server";

// Every Settings action that re-asks for the account password shares ONE
// budget of wrong answers (`checkCurrentPassword`, the `account:` namespace of
// the sign-in's limiter). Before, the data archive, clear memory, clear
// workspace and delete account compared the password bare, so a stolen session
// could guess it at bcrypt speed on any of them, then use it on the email
// change. Real account row, real services, real limiter.

const PASSWORD = "current-password-1";
const WRONG = "not-the-password";
const BUDGET = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAccount;
const THROTTLE_KEY = "profileTab.currentPasswordTooManyAttempts";

let userId: string;

beforeEach(async () => {
	// The limiter's buckets live as long as the process, and a penalty waits a
	// real second per case.
	_resetLoginRateLimitForTests();
	_setLoginRateLimitSleepForTests(async () => {});
	userId = randomUUID();
	await db.insert(users).values({
		id: userId,
		email: `${userId}@example.com`,
		passwordHash: bcrypt.hashSync(PASSWORD, 4),
	});
});

afterEach(async () => {
	_setLoginRateLimitSleepForTests();
	await db.delete(users).where(eq(users.id, userId));
});

// The handlers are typed against SvelteKit's generated route events; these
// cases hand them the few fields they read.
type RouteHandler = (event: never) => Response | Promise<Response>;

async function ask(
	handler: RouteHandler,
	path: string,
	method: string,
	body: unknown,
): Promise<Response> {
	const event = {
		request: new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: userId } },
		cookies: { get: () => undefined, delete: vi.fn() },
		params: {},
		url: new URL(`http://localhost${path}`),
	};
	return await handler(event as never);
}

type Attempt = (password: string) => Promise<Response>;

// The six Settings actions, each asked with the given account password. The
// destructive ones are only ever asked with a wrong one here, so what they
// would delete stays where it is.
const downloadArchive: Attempt = (password) =>
	ask(downloadArchiveRoute, "/api/settings/account/archive", "POST", {
		password,
	});
const clearMemory: Attempt = (password) =>
	ask(clearMemoryRoute, "/api/settings/account/clear-memory", "POST", {
		password,
	});
const clearWorkspace: Attempt = (password) =>
	ask(clearWorkspaceRoute, "/api/settings/account", "POST", { password });
const deleteAccount: Attempt = (password) =>
	ask(deleteAccountRoute, "/api/settings/account", "DELETE", { password });
const changeEmail: Attempt = (currentPassword) =>
	ask(changeEmailRoute, "/api/settings/profile", "PATCH", {
		email: "another-address@example.com",
		currentPassword,
	});
const changePassword: Attempt = (currentPassword) =>
	ask(changePasswordRoute, "/api/settings/password", "PATCH", {
		currentPassword,
		newPassword: "a-brand-new-password-1",
	});

const OTHER_ACTIONS: Array<[name: string, attempt: Attempt]> = [
	["clear memory and knowledge", clearMemory],
	["clear workspace data", clearWorkspace],
	["delete account", deleteAccount],
	["the email change", changeEmail],
	["the password change", changePassword],
];
const ALL_ACTIONS: Array<[name: string, attempt: Attempt]> = [
	["the data archive", downloadArchive],
	...OTHER_ACTIONS,
];

async function failTimes(attempt: Attempt, times: number) {
	for (let n = 0; n < times; n += 1) {
		const response = await attempt(WRONG);
		expect(response.status).toBe(401);
	}
}

async function accountStillThere() {
	const rows = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, userId));
	return rows.length === 1;
}

describe("the Settings password re-asks and the limiter", () => {
	it.each(
		ALL_ACTIONS,
	)("wrong passwords on %s end in a 429 the reader can read, never a 401 forever", async (_name, attempt) => {
		await failTimes(attempt, BUDGET);

		const throttled = await attempt(WRONG);

		expect(throttled.status).toBe(429);
		expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(await throttled.json()).toMatchObject({ errorKey: THROTTLE_KEY });
		expect(await accountStillThere()).toBe(true);
	});

	it.each(
		OTHER_ACTIONS,
	)("a lockout earned on the data archive applies to %s", async (_name, attempt) => {
		await failTimes(downloadArchive, BUDGET);

		const response = await attempt(WRONG);

		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({ errorKey: THROTTLE_KEY });
		expect(await accountStillThere()).toBe(true);
	});

	it.each(
		OTHER_ACTIONS,
	)("a lockout earned on %s applies to the data archive", async (_name, attempt) => {
		await failTimes(attempt, BUDGET);

		const response = await downloadArchive(WRONG);

		expect(response.status).toBe(429);
	});

	it("counts the wrong answers of different actions in one budget", async () => {
		// Half the budget on one action, half on another: the next wrong
		// password is over it, whichever action it is asked on.
		await failTimes(downloadArchive, BUDGET / 2);
		await failTimes(clearMemory, BUDGET / 2);

		expect((await deleteAccount(WRONG)).status).toBe(429);
	});

	it("still takes the right password while locked, and then forgets the failures", async () => {
		await failTimes(downloadArchive, BUDGET);
		expect((await downloadArchive(WRONG)).status).toBe(429);

		const right = await downloadArchive(PASSWORD);

		expect(right.status).toBe(200);
		expect(right.headers.get("Content-Type")).toBe("application/zip");
		await right.arrayBuffer();
		// The count was cleared by the success: a wrong answer is a plain 401
		// again, on this action and on the others.
		expect((await downloadArchive(WRONG)).status).toBe(401);
		expect((await clearMemory(WRONG)).status).toBe(401);
	});

	it("keeps the plain 401 under the budget, as before", async () => {
		const response = await downloadArchive(WRONG);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Incorrect password" });
	});
});
