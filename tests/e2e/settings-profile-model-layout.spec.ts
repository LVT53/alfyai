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

async function getDefaultModelLayoutMetrics(page: Page) {
	const choices = page.getByTestId("settings-default-model-grid");
	await expect(choices).toBeVisible({ timeout: 10000 });

	return choices.evaluate((container) => {
		const html = document.documentElement;
		const buttons = Array.from(container.querySelectorAll("button"));
		const containerRect = container.getBoundingClientRect();
		const buttonRects = buttons.map((button) => button.getBoundingClientRect());
		const rowTops = new Set(buttonRects.map((rect) => Math.round(rect.top)));

		return {
			buttonCount: buttons.length,
			documentScrollWidth: html.scrollWidth,
			viewportWidth: html.clientWidth,
			containerScrollWidth: container.scrollWidth,
			containerClientWidth: container.clientWidth,
			containerRight: containerRect.right,
			maxButtonRight: Math.max(...buttonRects.map((rect) => rect.right)),
			rowCount: rowTops.size,
		};
	});
}

test("profile Default model choices wrap without horizontal overflow", async ({
	page,
}) => {
	await login(page);
	const temporaryModels = await seedTemporaryModels(page);

	try {
		for (const viewport of [
			{ width: 390, height: 844 },
			{ width: 768, height: 1024 },
		]) {
			await page.setViewportSize(viewport);
			await page.goto("/settings", { waitUntil: "domcontentloaded" });
			await page.waitForLoadState("networkidle");

			const metrics = await getDefaultModelLayoutMetrics(page);
			expect(metrics.buttonCount).toBeGreaterThan(10);
			expect(metrics.rowCount).toBeGreaterThan(1);
			expect(metrics.documentScrollWidth).toBeLessThanOrEqual(
				metrics.viewportWidth + 1,
			);
			expect(metrics.containerScrollWidth).toBeLessThanOrEqual(
				metrics.containerClientWidth + 1,
			);
			expect(metrics.maxButtonRight).toBeLessThanOrEqual(
				metrics.containerRight + 1,
			);
		}
	} finally {
		await deleteTemporaryModels(page, temporaryModels);
	}
});
