import { expect, type Page, test } from "@playwright/test";

import { normalizeSystemPromptReference } from "../../src/lib/server/prompts";
import { login } from "./helpers";

type AdminConfigPayload = {
	currentValues: Record<string, string>;
	overrides: Record<string, string>;
	envDefaults: Record<string, string>;
};

async function fetchAdminConfig(page: Page): Promise<AdminConfigPayload> {
	const payload = await page.evaluate(async () => {
		const response = await fetch("/api/admin/config");
		return {
			ok: response.ok,
			status: response.status,
			body: (await response.json()) as AdminConfigPayload,
		};
	});

	expect(
		payload.ok,
		`admin config fetch failed with status ${payload.status}`,
	).toBe(true);
	return payload.body;
}

async function setPromptOverrideViaApi(page: Page, value: string) {
	const result = await page.evaluate(
		async ({ nextValue }) => {
			const response = await fetch("/api/admin/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ SYSTEM_PROMPT: nextValue }),
			});

			return {
				ok: response.ok,
				status: response.status,
			};
		},
		{ nextValue: value },
	);

	expect(
		result.ok,
		`admin config save failed with status ${result.status}`,
	).toBe(true);
}

async function setAdminOverrideViaApi(page: Page, key: string, value: string) {
	const result = await page.evaluate(
		async ({ nextKey, nextValue }) => {
			const response = await fetch("/api/admin/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ [nextKey]: nextValue }),
			});

			return {
				ok: response.ok,
				status: response.status,
			};
		},
		{ nextKey: key, nextValue: value },
	);

	expect(
		result.ok,
		`admin config save failed with status ${result.status}`,
	).toBe(true);
}

async function openAdministrationTab(page: Page) {
	await page.goto("/settings");
	await page.waitForLoadState("networkidle");
	await page.getByRole("tab", { name: "Administration" }).click();
	// Wait for the Models section header to be visible (always present on the System tab)
	await expect(page.getByText("Add Provider")).toBeVisible();
}

async function openAdministrationUsersPane(page: Page) {
	await page.goto("/settings");
	await page.waitForLoadState("networkidle");
	await page.getByRole("tab", { name: "Administration" }).click();
	await expect(page.getByText("Add Provider")).toBeVisible();
	await page.getByRole("button", { name: "Users" }).click();
	await expect(page.getByRole("button", { name: "Create User" })).toBeVisible();
}

async function savePromptFromUi(page: Page, value: string) {
	const field = page.locator("#SYSTEM_PROMPT");
	await field.scrollIntoViewIfNeeded();
	await field.fill(value);

	await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().includes("/api/admin/config") &&
				response.request().method() === "PUT" &&
				response.status() === 200,
		),
		page.getByRole("button", { name: "Save Configuration" }).click(),
	]);

	await expect(page.getByText("Configuration saved.")).toBeVisible();
}

async function reloadAdministrationTab(page: Page) {
	await page.reload();
	await page.waitForLoadState("networkidle");
	await page.getByRole("tab", { name: "Administration" }).click();
	await expect(page.getByText("Add Provider")).toBeVisible();
}

test.describe("Admin prompt settings", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await setPromptOverrideViaApi(page, "");
		await openAdministrationTab(page);
	});

	test.afterEach(async ({ page }) => {
		await setPromptOverrideViaApi(page, "");
	});

	test("saving the built-in prompt stores the canonical prompt reference", async ({
		page,
	}) => {
		const initialConfig = await fetchAdminConfig(page);
		const builtInPrompt = await page.locator("#SYSTEM_PROMPT").inputValue();
		const expectedReference =
			normalizeSystemPromptReference(initialConfig.envDefaults.SYSTEM_PROMPT) ??
			initialConfig.envDefaults.SYSTEM_PROMPT;

		await savePromptFromUi(page, builtInPrompt);

		const savedConfig = await fetchAdminConfig(page);
		if (expectedReference) {
			expect(savedConfig.overrides.SYSTEM_PROMPT).toBe(expectedReference);
		} else {
			expect(savedConfig.overrides.SYSTEM_PROMPT).toBeUndefined();
		}

		await reloadAdministrationTab(page);
		await expect(page.locator("#SYSTEM_PROMPT")).toHaveValue(builtInPrompt);
	});

	test("saving a custom prompt keeps the custom text", async ({ page }) => {
		const customPrompt =
			"You are a custom assistant.\nAnswer with compact bullet points and no preamble.";

		await savePromptFromUi(page, customPrompt);

		const savedConfig = await fetchAdminConfig(page);
		expect(savedConfig.overrides.SYSTEM_PROMPT).toBe(customPrompt);

		await reloadAdministrationTab(page);
		await expect(page.locator("#SYSTEM_PROMPT")).toHaveValue(customPrompt);
	});

	test("clearing the prompt resets the UI back to the default prompt", async ({
		page,
	}) => {
		const builtInPrompt = await page.locator("#SYSTEM_PROMPT").inputValue();
		const customPrompt = "Temporary custom prompt for reset coverage.";

		await savePromptFromUi(page, customPrompt);
		await savePromptFromUi(page, "");

		const savedConfig = await fetchAdminConfig(page);
		expect(savedConfig.overrides.SYSTEM_PROMPT).toBeUndefined();

		await reloadAdministrationTab(page);
		await expect(page.locator("#SYSTEM_PROMPT")).toHaveValue(builtInPrompt);
	});
});

// Memory v2 removed the Honcho turn-path config (HONCHO_CONTEXT_WAIT_MS /
// HONCHO_PERSONA_CONTEXT_WAIT_MS) from the admin UI. This block preserves the
// original intent — a numeric admin-config latency override persists through
// the UI save + reload cycle — against the surviving model-timeout-failover
// latency budget field.
test.describe("Admin model routing settings", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await setAdminOverrideViaApi(page, "MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS", "");
		await openAdministrationTab(page);
	});

	test.afterEach(async ({ page }) => {
		await setAdminOverrideViaApi(page, "MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS", "");
	});

	test("saving the model-timeout failover override persists the latency budget", async ({
		page,
	}) => {
		const field = page.locator("#MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS");
		await field.fill("4500");

		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().includes("/api/admin/config") &&
					response.request().method() === "PUT" &&
					response.status() === 200,
			),
			page.getByRole("button", { name: "Save Configuration" }).click(),
		]);

		const savedConfig = await fetchAdminConfig(page);
		expect(savedConfig.overrides.MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS).toBe(
			"4500",
		);

		await reloadAdministrationTab(page);
		await expect(
			page.locator("#MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS"),
		).toHaveValue("4500");
	});
});

test.describe("Admin app version settings", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await setAdminOverrideViaApi(page, "APP_VERSION_OVERRIDE", "");
		await openAdministrationTab(page);
	});

	test.afterEach(async ({ page }) => {
		await setAdminOverrideViaApi(page, "APP_VERSION_OVERRIDE", "");
	});

	test("refreshes the sidebar version badge after saving the app version override", async ({
		page,
	}) => {
		await page.locator("#APP_VERSION_OVERRIDE").fill("2026.05-admin");

		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().includes("/api/admin/config") &&
					response.request().method() === "PUT" &&
					response.status() === 200,
			),
			page.getByRole("button", { name: "Save Configuration" }).click(),
		]);

		await page.getByRole("button", { name: "Expand sidebar" }).click();
		await expect(
			page.getByRole("button", { name: "App version v2026.05-admin" }),
		).toBeVisible();
	});
});

test.describe("Admin user management", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
	});

	test("creates, promotes, demotes, and deletes a user from the Users pane", async ({
		page,
	}) => {
		const uniqueEmail = `admin-users-${Date.now()}@local.test`;

		await openAdministrationUsersPane(page);

		const usersIntroWidth = await page
			.getByText(
				"Create accounts, manage admin access, revoke sessions, and remove users when needed.",
			)
			.evaluate((element) => element.getBoundingClientRect().width);
		expect(usersIntroWidth).toBeGreaterThan(220);
		await expect(page.getByText("1970")).not.toBeVisible();

		await page.getByRole("button", { name: "Create User" }).click();
		const modalIntroWidth = await page
			.getByText(
				"Create a new local account and optionally grant it admin access immediately.",
			)
			.evaluate((element) => element.getBoundingClientRect().width);
		expect(modalIntroWidth).toBeGreaterThan(220);
		await page.locator("#create-user-name").fill("Managed User");
		await page.locator("#create-user-email").fill(uniqueEmail);
		await page.locator("#create-user-password").fill("supersecret");

		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().endsWith("/api/admin/users") &&
					response.request().method() === "POST" &&
					response.status() === 201,
			),
			page.getByRole("button", { name: "Create User" }).last().click(),
		]);

		await expect(page.getByText(uniqueEmail)).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Promote to Admin" }),
		).toBeVisible();

		await Promise.all([
			page.waitForResponse(
				(response) =>
					/\/api\/admin\/users\/[^/]+$/.test(response.url()) &&
					response.request().method() === "PATCH" &&
					response.status() === 200,
			),
			page.getByRole("button", { name: "Promote to Admin" }).click(),
		]);

		await expect(
			page.getByRole("button", { name: "Demote to User" }),
		).toBeVisible();

		await Promise.all([
			page.waitForResponse(
				(response) =>
					/\/api\/admin\/users\/[^/]+$/.test(response.url()) &&
					response.request().method() === "PATCH" &&
					response.status() === 200,
			),
			page.getByRole("button", { name: "Demote to User" }).click(),
		]);

		await expect(
			page.getByRole("button", { name: "Promote to Admin" }),
		).toBeVisible();

		await page.getByRole("button", { name: "Delete User" }).click();

		await Promise.all([
			page.waitForResponse(
				(response) =>
					/\/api\/admin\/users\/[^/]+$/.test(response.url()) &&
					response.request().method() === "DELETE" &&
					response.status() === 200,
			),
			page.getByTestId("confirm-delete").click(),
		]);

		await expect(page.getByText(uniqueEmail)).not.toBeVisible();
	});
});
