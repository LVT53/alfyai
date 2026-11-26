import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { e2eBaseUrl, e2eReusesServers, e2eSlot } from "./e2e-env";

export const TEST_EMAIL = process.env.E2E_EMAIL || "admin@local";
export const TEST_PASSWORD = process.env.E2E_PASSWORD || "admin123";

export async function loginThroughForm(
	page: Page,
	email = TEST_EMAIL,
	password = TEST_PASSWORD,
): Promise<void> {
	await test.step(
		"sign in (form)",
		async () => {
			await page.goto("/login", { waitUntil: "domcontentloaded" });
			const result = await page.evaluate(
				async ({ email: nextEmail, password: nextPassword }) => {
					const response = await fetch("/api/auth/login", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ email: nextEmail, password: nextPassword }),
					});

					return {
						ok: response.ok,
						status: response.status,
					};
				},
				{ email, password },
			);

			expect(result.ok, `Login failed with status ${result.status}`).toBe(true);
			await openReadyComposer(page);
		},
		{ box: true },
	);
}

// Playwright runs tests in separate worker processes. Including the current
// hash in the key makes a password change invalidate any previous answer.
const passwordChecks = new Map<string, boolean>();

export async function login(
	page: Page,
	email = TEST_EMAIL,
	password = TEST_PASSWORD,
): Promise<void> {
	// Reused servers own their sign-in and session storage.
	if (e2eReusesServers()) return loginThroughForm(page, email, password);

	await test.step(
		"sign in",
		async () => {
			// Spec discovery loads this helper before a worker database exists.
			const [
				{ db },
				{ users },
				{ createSession, verifyPassword },
				{ isTwoStepEnabled },
			] = await Promise.all([
				import("../../src/lib/server/db"),
				import("../../src/lib/server/db/schema"),
				import("../../src/lib/server/services/auth"),
				import("../../src/lib/server/services/two-step/store"),
			]);

			const user = await db
				.select({ id: users.id, passwordHash: users.passwordHash })
				.from(users)
				.where(eq(users.email, email))
				.get();
			if (!user) {
				throw new Error(
					`login(): no account with the email ${email} in this worker's database`,
				);
			}

			const key = JSON.stringify([user.id, user.passwordHash, password]);
			let valid = passwordChecks.get(key);
			if (valid === undefined) {
				valid = await verifyPassword(password, user.passwordHash);
				passwordChecks.set(key, valid);
			}
			if (!valid) {
				throw new Error(
					`login(): ${email} does not have that password; a test about passwords signs in with loginThroughForm()`,
				);
			}
			if (await isTwoStepEnabled(user.id)) {
				throw new Error(
					`login(): ${email} has two-step sign-in on; sign in through the code step, as two-step-sign-in.spec.ts does`,
				);
			}

			const { token, expiresAt } = await createSession(user.id, {
				rememberMe: false,
			});
			await page.context().addCookies([
				{
					name: "session",
					value: token,
					// The worker serves plain HTTP and disables Secure in build mode,
					// matching the app cookie issued by the real login endpoint here.
					url: e2eBaseUrl(e2eSlot()),
					secure: false,
					httpOnly: true,
					sameSite: "Lax",
					expires: Math.floor(expiresAt.getTime() / 1000),
				},
			]);
			await openReadyComposer(page);
		},
		{ box: true },
	);
}

async function openReadyComposer(page: Page): Promise<void> {
	await page.goto("/", { waitUntil: "domcontentloaded" });
	const composer = page.getByTestId("message-input");
	await expect(composer).toBeVisible({ timeout: 15_000 });
	await expect(composer).toBeEnabled({ timeout: 15_000 });
}
