import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { db } from "../../src/lib/server/db";
import { providerModels, providers } from "../../src/lib/server/db/schema";
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

// The System screen opens on its General page; every other setting is one
// navigator click away.
async function openAdministrationTab(page: Page, section = "general") {
	await page.goto("/settings");
	await page.waitForLoadState("networkidle");
	await page.getByRole("tab", { name: "Administration" }).click();
	await expect(page.getByTestId("admin-system-screen")).toBeVisible();
	if (section !== "general") {
		await page.getByTestId(`system-nav-${section}`).click();
	}
}

async function openAdministrationUsersPane(page: Page) {
	await page.goto("/settings");
	await page.waitForLoadState("networkidle");
	await page.getByRole("tab", { name: "Administration" }).click();
	await expect(page.getByTestId("admin-system-screen")).toBeVisible();
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
		// The bar names what it is about to write.
		page.getByTestId("system-save").click(),
	]);

	await expect(page.getByText("Configuration saved.")).toBeVisible();
}

async function reloadAdministrationTab(page: Page, section = "general") {
	await page.reload();
	await page.waitForLoadState("networkidle");
	await page.getByRole("tab", { name: "Administration" }).click();
	await expect(page.getByTestId("admin-system-screen")).toBeVisible();
	if (section !== "general") {
		await page.getByTestId(`system-nav-${section}`).click();
	}
}

test.describe("Admin prompt settings", () => {
	test.beforeEach(async ({ page }) => {
		await login(page);
		await setPromptOverrideViaApi(page, "");
		await openAdministrationTab(page, "aiTasks");
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

		// The save bar only writes what changed, so re-saving an untouched field
		// is a no-op now. Go via a custom prompt and back, which is the path an
		// admin actually takes to end up storing the built-in one.
		await savePromptFromUi(page, "A temporary prompt, so the field is dirty.");
		await savePromptFromUi(page, builtInPrompt);

		const savedConfig = await fetchAdminConfig(page);
		if (expectedReference) {
			expect(savedConfig.overrides.SYSTEM_PROMPT).toBe(expectedReference);
		} else {
			expect(savedConfig.overrides.SYSTEM_PROMPT).toBeUndefined();
		}

		await reloadAdministrationTab(page, "aiTasks");
		await expect(page.locator("#SYSTEM_PROMPT")).toHaveValue(builtInPrompt);
	});

	test("saving a custom prompt keeps the custom text", async ({ page }) => {
		const customPrompt =
			"You are a custom assistant.\nAnswer with compact bullet points and no preamble.";

		await savePromptFromUi(page, customPrompt);

		const savedConfig = await fetchAdminConfig(page);
		expect(savedConfig.overrides.SYSTEM_PROMPT).toBe(customPrompt);

		await reloadAdministrationTab(page, "aiTasks");
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

		await reloadAdministrationTab(page, "aiTasks");
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
		await openAdministrationTab(page, "models");
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
			page.getByTestId("system-save").click(),
		]);

		const savedConfig = await fetchAdminConfig(page);
		expect(savedConfig.overrides.MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS).toBe(
			"4500",
		);
		// Only the edited key was written.
		expect(savedConfig.overrides.MAX_MESSAGE_LENGTH).toBeUndefined();

		await reloadAdministrationTab(page, "models");
		await expect(
			page.locator("#MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS"),
		).toHaveValue("4500");
	});
});

// Regression guard for a redesigned-System-screen defect: `.sys-grow` (the
// flex-grow utility the provider row's label span leans on to push the
// model-count/toggle/menu controls to the row's right edge) was scoped as
// `.sys-card-head .sys-grow` — a selector the provider/model list rows never
// match, since they are not inside a `.sys-card-head`. The label span never
// grew, so the row's trailing controls packed against the label instead of
// reaching the row's own right edge, leaving a wide dead gap on wide
// viewports. Creating a provider through the real admin API would dial out to
// validate the connection, so this seeds the row directly, the same way other
// specs seed conversations/messages straight into SQLite.
test.describe("Admin provider table layout", () => {
	const providerId = randomUUID();

	test.beforeEach(async ({ page }) => {
		const now = new Date();
		await db.insert(providers).values({
			id: providerId,
			name: `layout_probe_${providerId.slice(0, 8)}`,
			displayName: "Layout Probe Provider",
			baseUrl: "https://layout-probe.example.com/v1",
			apiKeyEncrypted: "probe-encrypted",
			apiKeyIv: "probe-iv",
			sortOrder: 999,
			enabled: 1,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(providerModels).values([
			{
				id: randomUUID(),
				providerId,
				name: "layout-probe-1",
				displayName: "Layout Probe Model 1",
				enabled: 1,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: randomUUID(),
				providerId,
				name: "layout-probe-2",
				displayName: "Layout Probe Model 2",
				enabled: 1,
				sortOrder: 1,
				createdAt: now,
				updatedAt: now,
			},
		]);

		await login(page);
		await openAdministrationTab(page, "models");
	});

	test.afterEach(async () => {
		await db.delete(providers).where(eq(providers.id, providerId));
	});

	test("provider row controls reach the row's own right edge", async ({
		page,
	}) => {
		// Wide enough that the old bug's dead gap (hundreds of px) is
		// unmistakable next to the tolerance below.
		await page.setViewportSize({ width: 1440, height: 1000 });

		const row = page.getByTestId(`provider-row-${providerId}`);
		await expect(row).toBeVisible();
		const menuButton = page.getByTestId(`provider-menu-${providerId}`);

		const rowBox = await row.boundingBox();
		const menuBox = await menuButton.boundingBox();
		if (!rowBox || !menuBox) throw new Error("Row or menu button not laid out");

		const rowInsets = await row.evaluate((el) => {
			const style = getComputedStyle(el);
			return {
				paddingRight: Number.parseFloat(style.paddingRight) || 0,
				borderRight: Number.parseFloat(style.borderRightWidth) || 0,
			};
		});

		// The row's own content-box right edge: where the last control should
		// land regardless of viewport width, since the label span (not the
		// controls) absorbs the extra space.
		const rowContentRight =
			rowBox.x + rowBox.width - rowInsets.paddingRight - rowInsets.borderRight;
		const menuRight = menuBox.x + menuBox.width;

		expect(Math.abs(menuRight - rowContentRight)).toBeLessThanOrEqual(1);
	});
});

// Phone-width guard for the same `.sys-grow` fix. With `.sys-grow` a real
// utility, the save bar's detail span pushes Discard/Save to the bar's right
// edge. Below 900px the System shell stacks, and if the main column is sized
// to its content rather than to the screen, pages with wide card headers
// (Models, Diagnostics) make that column — and the save bar in it — wider
// than the phone. The pinned-right buttons then sit past the clipped edge
// where nobody can reach them.
test.describe("Admin system screen at phone width", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await login(page);
		await openAdministrationTab(page);
	});

	for (const section of ["models", "diagnostics"]) {
		test(`keeps the save bar and its buttons on screen on ${section}`, async ({
			page,
		}) => {
			await page.getByTestId(`system-nav-${section}`).click();
			const bar = page.getByTestId("system-save-bar");
			await expect(bar).toBeVisible();
			const viewportWidth = page.viewportSize()?.width ?? 390;

			const barBox = await bar.boundingBox();
			if (!barBox) throw new Error("Save bar not laid out");
			expect(barBox.x + barBox.width).toBeLessThanOrEqual(viewportWidth);

			// Discard and Save — the bar's only buttons.
			const buttons = bar.getByRole("button");
			await expect(buttons).toHaveCount(2);
			for (const button of await buttons.all()) {
				const box = await button.boundingBox();
				if (!box) throw new Error("Save bar button not laid out");
				expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth);
			}
		});
	}
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
			page.getByTestId("system-save").click(),
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

		// The pane's description became the account summary line under the title
		// when the rail turned into a table; the width guard stays, so a squeezed
		// header column would still fail here.
		const usersIntroWidth = await page
			.getByText(/\d+ accounts · \d+ admins/)
			.evaluate((element) => element.getBoundingClientRect().width);
		expect(usersIntroWidth).toBeGreaterThan(220);
		await expect(page.getByText("1970")).not.toBeVisible();

		await page.getByRole("button", { name: "Create User" }).click();
		const modalIntroWidth = await page
			.getByText(
				"They can change their name, password and model afterwards. There is no invite email — hand them the password yourself.",
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

		// Promotion is a privilege escalation, so it confirms first.
		await page.getByRole("button", { name: "Promote to Admin" }).click();
		await expect(page.getByText(/an admin\?$/)).toBeVisible();
		await Promise.all([
			page.waitForResponse(
				(response) =>
					/\/api\/admin\/users\/[^/]+$/.test(response.url()) &&
					response.request().method() === "PATCH" &&
					response.status() === 200,
			),
			page.getByTestId("confirm-delete").click(),
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

		// The address appears in both the table row and the detail panel while
		// the account exists, so assert on the count rather than one element.
		await expect(page.getByText(uniqueEmail)).toHaveCount(0);
	});
});
