import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows: Array<{ key: string; value: string }> = [];

vi.mock("./db", () => ({
	db: {
		select: () => ({ from: () => Promise.resolve(rows) }),
	},
}));

vi.mock("./services/available-models", () => ({
	getAvailableModelsWithProvidersForSettings: () => Promise.resolve([]),
	projectBuiltInAvailableModels: () => [],
	modelIconUrl: () => null,
}));

describe("picture making settings", () => {
	beforeEach(() => {
		rows.length = 0;
		vi.resetModules();
	});
	afterEach(() => {
		rows.length = 0;
	});

	it("is off with no address and on once an admin sets one", async () => {
		const { getConfig, refreshConfig, isImageMakingConfigured } = await import(
			"./config-store"
		);
		await refreshConfig();
		expect(isImageMakingConfigured(getConfig())).toBe(false);
		rows.push({ key: "COMFYUI_URL", value: " http://127.0.0.1:8188 " });
		await refreshConfig();
		expect(getConfig().comfyuiUrl).toBe("http://127.0.0.1:8188");
		expect(isImageMakingConfigured(getConfig())).toBe(true);
	});

	it("takes the source-picture cap from an admin override, clamped to 1..10", async () => {
		const { getImageReferenceCap, refreshConfig } = await import(
			"./config-store"
		);
		await refreshConfig();
		expect(getImageReferenceCap()).toBe(4);
		rows.push({ key: "IMAGE_REFERENCE_CAP", value: "7" });
		await refreshConfig();
		expect(getImageReferenceCap()).toBe(7);
		rows.length = 0;
		rows.push({ key: "IMAGE_REFERENCE_CAP", value: "99" });
		await refreshConfig();
		expect(getImageReferenceCap()).toBe(10);
	});
});
