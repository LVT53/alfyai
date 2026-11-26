import { randomUUID } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { expect, test } from "@playwright/test";
import { hashSync } from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { sessions, users } from "../../src/lib/server/db/schema";
import {
	beginTwoStepSetup,
	confirmTwoStepSetup,
} from "../../src/lib/server/services/two-step/store";
import { e2eReusesServers } from "./e2e-env";
import { login, loginThroughForm, TEST_EMAIL } from "./sign-in";

const password = "sign-in-helper-test-password";

async function createUser() {
	const id = randomUUID();
	const email = `sign-in-helper-${id}@local.test`;
	await db.insert(users).values({
		id,
		email,
		name: "Sign-in helper test user",
		passwordHash: hashSync(password, 4),
	});
	return { id, email };
}

test.describe("Direct sign-in", () => {
	test.skip(e2eReusesServers(), "Reused servers sign in over HTTP");

	test("login() opens the ready composer on a session accepted by the app", async ({
		page,
	}) => {
		const user = db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, TEST_EMAIL))
			.get();
		if (!user) throw new Error("Expected the seeded admin");
		const countSessions = () =>
			db.$count(sessions, eq(sessions.userId, user.id));
		const before = await countSessions();

		const loginPaths: string[] = [];
		page.on("request", (request) => {
			const { pathname } = new URL(request.url());
			if (pathname === "/login" || pathname === "/api/auth/login") {
				loginPaths.push(pathname);
			}
		});
		await login(page);

		await expect(page).toHaveURL("/");
		await expect(page.getByTestId("message-input")).toBeEnabled();
		expect(await countSessions()).toBe(before + 1);
		const cookie = (await page.context().cookies()).find(
			({ name }) => name === "session",
		);
		expect(cookie).toMatchObject({
			domain: new URL(page.url()).hostname,
			path: "/",
			httpOnly: true,
			secure: false,
			sameSite: "Lax",
		});
		expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000);
		expect((await page.request.get("/api/settings")).status()).toBe(200);
		expect(loginPaths).toEqual([]);
	});

	test("login() refuses a password the account does not have", async ({
		page,
	}) => {
		await expect(login(page, TEST_EMAIL, "not-the-password")).rejects.toThrow(
			"does not have that password",
		);
	});

	test("login() refuses the previously verified password after it changes", async ({
		page,
	}) => {
		const user = await createUser();
		try {
			await login(page, user.email, password);
			const nextPassword = "updated-sign-in-helper-password";
			await db
				.update(users)
				.set({ passwordHash: hashSync(nextPassword, 4) })
				.where(eq(users.id, user.id));
			await page.context().clearCookies();
			await expect(login(page, user.email, password)).rejects.toThrow(
				"does not have that password",
			);
			await login(page, user.email, nextPassword);
		} finally {
			await db.delete(users).where(eq(users.id, user.id));
		}
	});

	test("login() refuses an account with two-step sign-in on", async ({
		page,
	}) => {
		const user = await createUser();
		try {
			const setup = await beginTwoStepSetup(user.id, user.email);
			if (!setup.ok) throw new Error(`Two-step setup failed: ${setup.reason}`);
			const secret = decodeBase32IgnorePadding(setup.key.replace(/\s/g, ""));
			const now = new Date();
			const code = generateHOTP(
				secret,
				BigInt(Math.floor(now.getTime() / 30_000)),
				6,
			);
			expect(await confirmTwoStepSetup(user.id, code, now, null)).toMatchObject(
				{
					ok: true,
				},
			);

			await expect(login(page, user.email, password)).rejects.toThrow(
				"has two-step sign-in on",
			);
			expect(await db.$count(sessions, eq(sessions.userId, user.id))).toBe(0);
		} finally {
			await db.delete(users).where(eq(users.id, user.id));
		}
	});
});

test("login() uses the server's sign-in when reusing a server", async ({
	page,
}) => {
	const previous = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER;
	const before = await db.$count(sessions);
	const loginPaths: string[] = [];
	page.on("request", (request) => {
		const { pathname } = new URL(request.url());
		if (pathname === "/login" || pathname === "/api/auth/login") {
			loginPaths.push(pathname);
		}
	});
	await page.route("**/api/auth/login", async (route) => {
		expect(route.request().method()).toBe("POST");
		expect(await db.$count(sessions)).toBe(before);
		const response = await route.fetch();
		expect(response.status()).toBe(200);
		expect(await db.$count(sessions)).toBe(before + 1);
		await route.fulfill({ response });
	});

	process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER = "true";
	try {
		await login(page);
		expect(loginPaths).toEqual(["/login", "/api/auth/login"]);
		expect(await db.$count(sessions)).toBe(before + 1);
		await expect(page).toHaveURL("/");
		await expect(page.getByTestId("message-input")).toBeEnabled();
		expect((await page.request.get("/api/settings")).status()).toBe(200);
	} finally {
		if (previous === undefined)
			delete process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER;
		else process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER = previous;
	}
});

test("loginThroughForm() visits /login and signs in through the real API", async ({
	page,
}) => {
	const loginPage = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/login",
	);
	const loginPost = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === "/api/auth/login" &&
			response.request().method() === "POST",
	);
	await loginThroughForm(page);

	expect((await loginPage).status()).toBe(200);
	expect((await loginPost).status()).toBe(200);
	await expect(page.getByTestId("message-input")).toBeEnabled();
});
