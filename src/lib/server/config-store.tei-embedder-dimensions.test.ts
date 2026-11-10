// TEI_EMBEDDER_DIMENSIONS cuts a Matryoshka embedder (Qwen3-Embedding-4B answers at
// 2560 and stays accurate at 1024) so a bigger model does not make every stored vector,
// and every search that scans them, 2.5 times as heavy. It has to be an admin key (it is
// switched live next to TEI_EMBEDDER_MODEL), show up in the resolved values the settings
// page renders, and never go below 0, which means "send nothing, keep the model's size".
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

describe("TEI_EMBEDDER_DIMENSIONS admin key", () => {
	beforeEach(() => {
		rows.length = 0;
		vi.resetModules();
	});

	afterEach(() => {
		rows.length = 0;
		delete process.env.TEI_EMBEDDER_DIMENSIONS;
	});

	it("is an admin config key and resolves to 0 when nothing is set", async () => {
		const { ADMIN_CONFIG_KEYS, getResolvedAdminConfigValues } = await import(
			"./config-store"
		);
		expect(ADMIN_CONFIG_KEYS as readonly string[]).toContain(
			"TEI_EMBEDDER_DIMENSIONS",
		);
		expect(getResolvedAdminConfigValues().TEI_EMBEDDER_DIMENSIONS).toBe("0");
	});

	it("applies an admin_config row over the env default", async () => {
		process.env.TEI_EMBEDDER_DIMENSIONS = "512";
		rows.push({ key: "TEI_EMBEDDER_DIMENSIONS", value: "1024" });

		const { getConfig, refreshConfig } = await import("./config-store");
		await refreshConfig();

		expect(getConfig().teiEmbedderDimensions).toBe(1024);
	});

	it("never goes below 0", async () => {
		rows.push({ key: "TEI_EMBEDDER_DIMENSIONS", value: "-7" });

		const { getConfig, refreshConfig } = await import("./config-store");
		await refreshConfig();

		expect(getConfig().teiEmbedderDimensions).toBe(0);
	});

	it("keeps the env default when the row is not a number", async () => {
		process.env.TEI_EMBEDDER_DIMENSIONS = "512";
		rows.push({ key: "TEI_EMBEDDER_DIMENSIONS", value: "abc" });

		const { getConfig, refreshConfig } = await import("./config-store");
		await refreshConfig();

		expect(getConfig().teiEmbedderDimensions).toBe(512);
	});
});
