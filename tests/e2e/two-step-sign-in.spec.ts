import { randomUUID } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import { users } from "../../src/lib/server/db/schema";
import { login, logout } from "./helpers";

/**
 * Two-step sign-in end to end: turning it on through all three steps, signing
 * in with a code and with a backup code, the five-try limit, both languages of
 * the main screens, turning it off, and an admin resetting the account.
 *
 * The codes come from the key the setup step draws, with the same library the
 * server uses. R19's replay guard is respected here: every code is computed
 * for an explicit 30-second step, a fresh step is waited for by the clock
 * (never a fixed sleep), and no code is taken in the last five seconds of its
 * step, so typing it cannot cross the boundary.
 */

const STEP_MS = 30_000;
/** Leave this much of the step for the form to reach the server. */
const SAFE_STEP_REMAINDER_MS = 5_000;
const PASSWORD = "two-step-e2e-password";
const ADMIN_EMAIL = process.env.E2E_EMAIL || "admin@local";
const ADMIN_PASSWORD = process.env.E2E_PASSWORD || "admin123";

const state: {
	email: string;
	name: string;
	secret: Uint8Array;
	codes: string[];
	backupIndex: number;
	lastUsedStep: number;
} = {
	email: `two-step-${randomUUID()}@local.test`,
	name: `Two-step ${Date.now()}`,
	secret: new Uint8Array(),
	codes: [],
	backupIndex: 0,
	lastUsedStep: -1,
};

test.describe.configure({ mode: "serial", timeout: 150_000 });

function stepAt(now = Date.now()): number {
	return Math.floor(now / STEP_MS);
}

function codeFor(step: number): string {
	return generateHOTP(state.secret, BigInt(step), 6);
}

/**
 * A step above `afterStep` with enough of it left to submit. Waits by the
 * clock for the next step when the current one is the replay guard's or is
 * nearly over; never a fixed sleep.
 */
async function nextUsableStep(afterStep: number): Promise<number> {
	for (;;) {
		const now = Date.now();
		const step = stepAt(now);
		const intoStep = now - step * STEP_MS;
		if (step > afterStep && intoStep <= STEP_MS - SAFE_STEP_REMAINDER_MS) {
			return step;
		}
		const waitMs =
			step > afterStep
				? STEP_MS - intoStep + 500
				: (afterStep + 1) * STEP_MS - now + 500;
		await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 250)));
	}
}

function wrongCodeCandidate(index: number): string {
	const right = codeFor(stepAt());
	const first = String((Number(right[0] ?? "0") + index) % 10);
	return `${first}${right.slice(1)}`;
}

async function fillPasswordStep(page: Page) {
	await page.goto("/login");
	await page.locator("#email").fill(state.email);
	await page.locator("#password").fill(PASSWORD);
	await page.locator('button[type="submit"]').click();
	await expect(page.getByText("Enter your code")).toBeVisible({
		timeout: 10_000,
	});
}

/** Signs in with a fresh authenticator code and lands on the app. */
async function signInWithCode(page: Page) {
	await fillPasswordStep(page);
	const step = await nextUsableStep(state.lastUsedStep);
	await page.getByLabel("Code").fill(codeFor(step));
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 15_000,
	});
	state.lastUsedStep = step;
}

/** Signs in with the next unused backup code. */
async function signInWithBackupCode(page: Page) {
	await fillPasswordStep(page);
	await page.getByRole("button", { name: "Use a backup code instead" }).click();
	const code = state.codes[state.backupIndex];
	state.backupIndex += 1;
	if (!code) throw new Error("No backup code left for the test");
	await page.getByLabel("Backup code").fill(code);
	await page.getByRole("button", { name: "Verify" }).click();
	await expect(page.getByTestId("message-input")).toBeVisible({
		timeout: 15_000,
	});
}

async function openSettings(page: Page) {
	await page.goto("/settings");
	await page.waitForLoadState("networkidle");
}

async function setLanguage(page: Page, language: "en" | "hu") {
	await page.evaluate(async (nextLanguage) => {
		await fetch("/api/settings/preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ uiLanguage: nextLanguage }),
		});
	}, language);
}

/** Runs the three-step setup dialog and records the key and the ten codes. */
async function turnOn(page: Page) {
	await openSettings(page);
	await page.getByRole("button", { name: "Turn on" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText("Scan this code")).toBeVisible();

	const key = (await dialog.getByTestId("two-step-key").textContent())?.trim();
	if (!key) throw new Error("The setup dialog showed no key");
	const secret = decodeBase32IgnorePadding(key.replaceAll(" ", ""));

	// The key really is what the app will accept a code for.
	await dialog.getByRole("button", { name: "Next" }).click();
	const step = await nextUsableStep(-1);
	await dialog.getByLabel("Code").fill(generateHOTP(secret, BigInt(step), 6));
	await dialog.getByRole("button", { name: "Verify" }).click();

	await expect(dialog.getByText("Save your backup codes")).toBeVisible();
	const codes = (
		await dialog.getByTestId("backup-codes").locator("code").allTextContents()
	).map((code) => code.trim());
	expect(codes).toHaveLength(10);
	expect(new Set(codes).size).toBe(10);

	await dialog.getByLabel("I've saved them somewhere safe").check();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).toBeHidden();

	state.secret = secret;
	state.codes = codes;
	state.backupIndex = 0;
	state.lastUsedStep = step;

	await expect(page.getByTestId("two-step-row")).toContainText("On");
	await expect(page.getByTestId("two-step-row")).toContainText(
		"10 of 10 backup codes left",
	);
}

async function openAdministrationUsers(page: Page) {
	await openSettings(page);
	await page.getByRole("tab", { name: "Administration" }).click();
	await page.getByRole("button", { name: "Users" }).click();
	await expect(page.getByRole("button", { name: "Create User" })).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
	const result = await page.evaluate(
		async (payload) => {
			const response = await fetch("/api/admin/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			return { ok: response.ok, status: response.status };
		},
		{
			email: state.email,
			name: state.name,
			password: PASSWORD,
			role: "user",
		},
	);
	expect(result.ok, `creating the account failed: ${result.status}`).toBe(true);
	await context.close();
});

test.afterAll(async () => {
	// The account and everything it owns (factor, codes, sessions) go with it.
	await db.delete(users).where(eq(users.email, state.email));
});

test("turns two-step sign-in on through all three steps", async ({ page }) => {
	await login(page, state.email, PASSWORD);
	await turnOn(page);

	// The Account card says it is on, since today, with all ten codes.
	await expect(page.getByTestId("two-step-on-badge")).toBeVisible();
});

test("signs out and signs in with a code", async ({ page }) => {
	await signInWithCode(page);
	await expect(page).toHaveURL("/");
});

test("signs in with a backup code and says how many are left", async ({
	page,
}) => {
	await signInWithBackupCode(page);

	// R16: the count travels in the first page's URL as a toast, and the URL
	// is cleaned again.
	await expect(page.getByTestId("toast-entry")).toContainText(
		"You used a backup code. 9 left.",
	);
	await expect(page).toHaveURL("/");
});

test("five wrong codes end the attempt and return to the password step", async ({
	page,
}) => {
	await fillPasswordStep(page);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		await page.getByLabel("Code").fill(wrongCodeCandidate(attempt + 1));
		await expect(page.getByTestId("login-code-error")).toContainText(
			`${4 - attempt} tries left`,
		);
	}

	await page.getByLabel("Code").fill(wrongCodeCandidate(5));
	await expect(page.getByText("Too many tries. Sign in again.")).toBeVisible();
	await expect(page.getByLabel("Email address")).toBeVisible();
});

test("the main screens speak Hungarian and English", async ({ page }) => {
	await signInWithBackupCode(page);

	await setLanguage(page, "hu");
	await openSettings(page);
	await expect(page.getByTestId("two-step-row")).toContainText(
		"Kétlépcsős bejelentkezés",
	);
	await page.getByRole("button", { name: "Kikapcsolás" }).click();
	await expect(
		page.getByText("Kikapcsolod a kétlépcsős bejelentkezést?"),
	).toBeVisible();
	await page.keyboard.press("Escape");

	await setLanguage(page, "en");
	await openSettings(page);
	await expect(page.getByTestId("two-step-row")).toContainText(
		"Two-step sign-in",
	);
});

test("turns two-step sign-in off with a backup code", async ({ page }) => {
	await signInWithBackupCode(page);

	await openSettings(page);
	await page.getByRole("button", { name: "Turn off" }).click();
	const dialog = page.getByRole("dialog");
	const backupCode = state.codes[state.backupIndex];
	state.backupIndex += 1;
	if (!backupCode) throw new Error("No backup code left for the test");
	await dialog.getByLabel("Code or backup code").fill(backupCode);
	await dialog.getByRole("button", { name: "Confirm" }).click();

	await expect(dialog).toBeHidden();
	await expect(page.getByTestId("two-step-row")).toContainText("Off.");
	await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
});

test("an admin resets the account's two-step sign-in", async ({ page }) => {
	// The previous test turned it off, so the password alone opens a session
	// (a plain login, not the two-step card).
	await login(page, state.email, PASSWORD);
	await turnOn(page);
	await logout(page);

	await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
	await openAdministrationUsers(page);

	await expect(page.getByRole("cell", { name: state.email })).toBeVisible();
	const row = page
		.getByTestId("admin-user-row")
		.filter({ hasText: state.email });
	await row.getByRole("button").first().click();

	const detail = page.getByTestId("admin-user-detail");
	await expect(detail).toContainText("On since");
	await expect(detail).toContainText("10 backup codes left");

	await detail.getByRole("button", { name: "Reset two-step sign-in" }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByText(`Reset ${state.name}'s two-step sign-in?`),
	).toBeVisible();
	await dialog.getByLabel("Your password").fill(ADMIN_PASSWORD);
	await dialog.getByRole("button", { name: "Reset" }).click();

	await expect(dialog).toBeHidden();
	await expect(detail).toContainText("Off");
});
