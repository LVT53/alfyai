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
		delete process.env.IMAGE_MODEL;
		delete process.env.COMFYUI_H3_URL;
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

	it("keeps the explicit-picture filter on by default and lets an admin turn it off", async () => {
		const { getConfig, refreshConfig, getResolvedAdminConfigValues } =
			await import("./config-store");
		await refreshConfig();
		expect(getConfig().imageExplicitFilterEnabled).toBe(true);
		rows.push({ key: "IMAGE_EXPLICIT_FILTER_ENABLED", value: "false" });
		await refreshConfig();
		expect(getConfig().imageExplicitFilterEnabled).toBe(false);
		expect(
			getResolvedAdminConfigValues(getConfig()).IMAGE_EXPLICIT_FILTER_ENABLED,
		).toBe("false");
		rows.length = 0;
		rows.push({ key: "IMAGE_EXPLICIT_FILTER_ENABLED", value: "true" });
		await refreshConfig();
		expect(getConfig().imageExplicitFilterEnabled).toBe(true);
	});

	it("uses only the selected picture model's own address", async () => {
		const {
			getConfig,
			refreshConfig,
			isImageMakingConfigured,
			getImageModel,
			getComfyuiH3Url,
			getComfyuiUrlForModel,
		} = await import("./config-store");
		await refreshConfig();
		expect(getImageModel()).toBe("qwen");
		expect(getComfyuiH3Url()).toBe("");
		expect(isImageMakingConfigured(getConfig())).toBe(false);

		rows.push({ key: "COMFYUI_URL", value: "http://127.0.0.1:8188" });
		await refreshConfig();
		expect(isImageMakingConfigured(getConfig())).toBe(true);
		expect(getComfyuiUrlForModel("qwen")).toBe("http://127.0.0.1:8188");

		// An H3 address is read and selectable, but the Qwen server is still
		// the one the selected model uses.
		rows.push({ key: "COMFYUI_H3_URL", value: " http://127.0.0.1:8189 " });
		await refreshConfig();
		expect(getComfyuiH3Url()).toBe("http://127.0.0.1:8189");
		expect(getComfyuiUrlForModel("h3")).toBe("http://127.0.0.1:8189");
		expect(isImageMakingConfigured(getConfig())).toBe(true);

		// H3 selected without its own address is off, even with the Qwen URL
		// still configured.
		rows.length = 0;
		rows.push(
			{ key: "COMFYUI_URL", value: "http://127.0.0.1:8188" },
			{ key: "IMAGE_MODEL", value: "h3" },
		);
		await refreshConfig();
		expect(getImageModel()).toBe("h3");
		expect(isImageMakingConfigured(getConfig())).toBe(false);

		rows.push({ key: "COMFYUI_H3_URL", value: "http://127.0.0.1:8189" });
		await refreshConfig();
		expect(isImageMakingConfigured(getConfig())).toBe(true);

		// Switching back to Qwen ignores the H3 address.
		rows.length = 0;
		rows.push(
			{ key: "IMAGE_MODEL", value: "qwen" },
			{ key: "COMFYUI_H3_URL", value: "http://127.0.0.1:8189" },
		);
		await refreshConfig();
		expect(isImageMakingConfigured(getConfig())).toBe(false);
	});

	it("applies the picture model switch live", async () => {
		const { getImageModel, refreshConfig } = await import("./config-store");
		await refreshConfig();
		expect(getImageModel()).toBe("qwen");

		rows.push({ key: "IMAGE_MODEL", value: "h3" });
		await refreshConfig();
		expect(getImageModel()).toBe("h3");

		rows.length = 0;
		rows.push({ key: "IMAGE_MODEL", value: "qwen" });
		await refreshConfig();
		expect(getImageModel()).toBe("qwen");
	});

	it("projects both picture model keys into the admin config values", async () => {
		const { getResolvedAdminConfigValues, refreshConfig } = await import(
			"./config-store"
		);
		await refreshConfig();
		expect(getResolvedAdminConfigValues()).toMatchObject({
			IMAGE_MODEL: "qwen",
			COMFYUI_H3_URL: "",
		});

		rows.push(
			{ key: "IMAGE_MODEL", value: "h3" },
			{ key: "COMFYUI_H3_URL", value: "http://127.0.0.1:8189" },
		);
		await refreshConfig();
		expect(getResolvedAdminConfigValues()).toMatchObject({
			IMAGE_MODEL: "h3",
			COMFYUI_H3_URL: "http://127.0.0.1:8189",
		});
	});
});
