import { expect, type Page, test } from "@playwright/test";

import { login } from "./helpers";

type AdminProvider = { id: string; enabled?: boolean };
type AdminModel = { id: string };

async function seedTemporaryModels(
	page: Page,
): Promise<Array<{ providerId: string; modelId: string }>> {
	const seedPrefix = `layout-${Date.now()}`;
	const result = await page.evaluate(
		async ({ prefix }) => {
			const providersResponse = await fetch("/api/admin/providers");
			const providersBody = (await providersResponse.json()) as {
				providers?: AdminProvider[];
				error?: string;
			};
			if (!providersResponse.ok || !providersBody.providers?.length) {
				return {
					ok: false,
					status: providersResponse.status,
					error: providersBody.error ?? "No provider available",
					created: [] as Array<{ providerId: string; modelId: string }>,
				};
			}

			const provider = providersBody.providers.find(
				(entry) => entry.enabled !== false,
			);
			if (!provider) {
				return {
					ok: false,
					status: providersResponse.status,
					error: "No enabled provider available",
					created: [] as Array<{ providerId: string; modelId: string }>,
				};
			}
			const providerId = provider.id;
			const models = Array.from({ length: 14 }, (_, index) => ({
				name: `${prefix}-model-${index}`,
				displayName: `Responsive Layout Provider Model ${index + 1} With Long Name`,
				contextLength: 8192,
				supportsChat: true,
				supportsTools: true,
			}));
			const createResponse = await fetch(
				`/api/admin/providers/${providerId}/models/batch`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ models }),
				},
			);
			const createBody = (await createResponse.json()) as {
				models?: AdminModel[];
				error?: string;
			};
			return {
				ok: createResponse.ok,
				status: createResponse.status,
				error: createBody.error,
				created: (createBody.models ?? []).map((model) => ({
					providerId,
					modelId: model.id,
				})),
			};
		},
		{ prefix: seedPrefix },
	);

	expect(
		result.ok,
		`temporary model creation failed with ${result.status}: ${result.error ?? ""}`,
	).toBe(true);
	expect(result.created.length).toBeGreaterThan(0);
	return result.created;
}

async function deleteTemporaryModels(
	page: Page,
	models: Array<{ providerId: string; modelId: string }>,
) {
	for (const model of models) {
		await page.evaluate(async ({ providerId, modelId }) => {
			await fetch(`/api/admin/providers/${providerId}/models/${modelId}`, {
				method: "DELETE",
			});
		}, model);
	}
}

// The Default model control used to be a grid of one 44px pill per model,
// five wide — with fifteen models installed it was the tallest thing on the
// page and the widest thing to overflow. The redesign makes it one select,
// so the test that guarded the grid's wrapping now guards that the control
// costs one row however many models exist, and still fits its column.
test("profile Default model is one select that fits, however many models exist", async ({
	page,
}) => {
	await login(page);
	const temporaryModels = await seedTemporaryModels(page);

	try {
		for (const viewport of [
			{ width: 390, height: 844 },
			{ width: 768, height: 1024 },
			{ width: 1440, height: 900 },
		]) {
			await page.setViewportSize(viewport);
			await page.goto("/settings", { waitUntil: "domcontentloaded" });
			await page.waitForLoadState("networkidle");

			const select = page.getByTestId("settings-default-model-select");
			await expect(select).toBeVisible({ timeout: 10000 });

			// The old pill grid is gone for good.
			await expect(page.getByTestId("settings-default-model-grid")).toHaveCount(
				0,
			);

			const metrics = await select.evaluate((element) => {
				const html = document.documentElement;
				const rect = element.getBoundingClientRect();
				const row = element.closest(".settings-row") as HTMLElement;
				const rowRect = row.getBoundingClientRect();
				return {
					optionCount: (element as HTMLSelectElement).options.length,
					height: rect.height,
					right: rect.right,
					rowRight: rowRect.right,
					documentScrollWidth: html.scrollWidth,
					viewportWidth: html.clientWidth,
				};
			});

			// Every installed model is reachable...
			expect(metrics.optionCount).toBeGreaterThan(10);
			// ...from a control one row tall, and at least 44px on a phone.
			expect(metrics.height).toBeLessThan(60);
			expect(metrics.height).toBeGreaterThanOrEqual(
				viewport.width <= 640 ? 44 : 34,
			);
			// ...that stays inside its row and never widens the page.
			expect(metrics.right).toBeLessThanOrEqual(metrics.rowRight + 1);
			expect(metrics.documentScrollWidth).toBeLessThanOrEqual(
				metrics.viewportWidth + 1,
			);
		}
	} finally {
		await deleteTemporaryModels(page, temporaryModels);
	}
});
