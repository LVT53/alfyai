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
	await page.getByRole("button", { name: "Administration" }).click();
	// Wait for the Models section header to be visible (always present on the System tab)
	await expect(page.getByText("Add Provider")).toBeVisible();
}

async function openAdministrationUsersPane(page: Page) {
	await page.goto("/settings");
	await page.waitForLoadState("networkidle");
	await page.getByRole("button", { name: "Administration" }).click();
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
	await page.getByRole("button", { name: "Administration" }).click();
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

test.describe("Admin model routing settings", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await setAdminOverrideViaApi(page, "HONCHO_CONTEXT_WAIT_MS", "");
		await setAdminOverrideViaApi(page, "HONCHO_PERSONA_CONTEXT_WAIT_MS", "");
		await openAdministrationTab(page);
	});

	test.afterEach(async ({ page }) => {
		await setAdminOverrideViaApi(page, "HONCHO_CONTEXT_WAIT_MS", "");
		await setAdminOverrideViaApi(page, "HONCHO_PERSONA_CONTEXT_WAIT_MS", "");
	});

	test("saving the Honcho context wait override persists the latency budget", async ({
		page,
	}) => {
		const field = page.locator("#HONCHO_CONTEXT_WAIT_MS");
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
		expect(savedConfig.overrides.HONCHO_CONTEXT_WAIT_MS).toBe("4500");

		await reloadAdministrationTab(page);
		await expect(page.locator("#HONCHO_CONTEXT_WAIT_MS")).toHaveValue("4500");
	});

	test("saving the Honcho persona context wait override persists the dedicated latency budget", async ({
		page,
	}) => {
		const field = page.locator("#HONCHO_PERSONA_CONTEXT_WAIT_MS");
		await field.fill("1200");

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
		expect(savedConfig.overrides.HONCHO_PERSONA_CONTEXT_WAIT_MS).toBe("1200");

		await reloadAdministrationTab(page);
		await expect(page.locator("#HONCHO_PERSONA_CONTEXT_WAIT_MS")).toHaveValue(
			"1200",
		);
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

test.describe("Admin Deep Research settings", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await setAdminOverrideViaApi(page, "DEEP_RESEARCH_DEPTH_BUDGETS_JSON", "");
		await openAdministrationTab(page);
	});

	test.afterEach(async ({ page }) => {
		await setAdminOverrideViaApi(page, "DEEP_RESEARCH_DEPTH_BUDGETS_JSON", "");
	});

	test("exposes and persists the Deep Research runtime, model, and depth budget config", async ({
		page,
	}) => {
		const expectedFields = [
			"DEEP_RESEARCH_ENABLED",
			"DEEP_RESEARCH_WORKER_ENABLED",
			"DEEP_RESEARCH_WORKER_INTERVAL_MS",
			"DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS",
			"DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS",
			"DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY",
			"DEEP_RESEARCH_WORKER_USER_CONCURRENCY",
			"DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT",
			"DEEP_RESEARCH_ACTIVE_USER_LIMIT",
			"DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT",
			"DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY",
			"DEEP_RESEARCH_USER_REASONING_CONCURRENCY",
			"DEEP_RESEARCH_DEPTH_BUDGETS_JSON",
			"DEEP_RESEARCH_PLAN_MODEL",
			"DEEP_RESEARCH_PLAN_REVISION_MODEL",
			"DEEP_RESEARCH_SOURCE_REVIEW_MODEL",
			"DEEP_RESEARCH_RESEARCH_TASK_MODEL",
			"DEEP_RESEARCH_SYNTHESIS_MODEL",
			"DEEP_RESEARCH_CITATION_AUDIT_MODEL",
			"DEEP_RESEARCH_REPORT_MODEL",
		];
		for (const fieldId of expectedFields) {
			await expect(
				page.locator(`#${fieldId}`),
				`${fieldId} should be visible`,
			).toBeVisible();
		}

		const depthBudgetOverride = JSON.stringify({
			focused: {
				sourceReviewCeiling: 19,
				meaningfulPassFloor: 2,
				meaningfulPassCeiling: 4,
				repairPassCeiling: 2,
				sourceProcessingConcurrency: 5,
				modelReasoningConcurrency: 2,
			},
		});
		await page
			.locator("#DEEP_RESEARCH_DEPTH_BUDGETS_JSON")
			.fill(depthBudgetOverride);

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
		expect(savedConfig.overrides.DEEP_RESEARCH_DEPTH_BUDGETS_JSON).toBe(
			depthBudgetOverride,
		);

		await reloadAdministrationTab(page);
		const reloadedDepthBudgets = JSON.parse(
			await page.locator("#DEEP_RESEARCH_DEPTH_BUDGETS_JSON").inputValue(),
		);
		expect(reloadedDepthBudgets.focused.sourceReviewCeiling).toBe(19);
		expect(reloadedDepthBudgets.standard.sourceReviewCeiling).toBeGreaterThan(
			19,
		);
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
