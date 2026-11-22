import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-config");
});
afterEach(() => {
	vi.restoreAllMocks();
	h.cleanup();
});
describe("native configuration boundary", () => {
	it("applies admin overrides while never serializing tenant credentials", async () => {
		const { db } = await import("$lib/server/db");
		const { adminConfig } = await import("$lib/server/db/schema");
		const config = await import("$lib/server/config-store");
		db.insert(adminConfig)
			.values([
				{
					key: "HINDSIGHT_URL",
					value: "http://127.0.0.1:9999",
					updatedBy: h.userId,
				},
				{ key: "HINDSIGHT_CONCURRENCY", value: "3", updatedBy: h.userId },
				{ key: "HINDSIGHT_WORKER_ENABLED", value: "true", updatedBy: h.userId },
			])
			.run();
		await config.refreshConfig();
		expect(config.getConfig().hindsightUrl).toBe("http://127.0.0.1:9999");
		expect(config.getConfig().hindsightConcurrency).toBe(3);
		expect(config.getConfig().hindsightWorkerEnabled).toBe(true);
		const settings = config.getResolvedAdminConfigValues({
			...config.getConfig(),
			hindsightTenantKeys: '{"tenant":"secret-do-not-return"}',
		});
		expect(JSON.stringify(settings)).not.toContain("secret-do-not-return");
		expect(config.ADMIN_CONFIG_KEYS).not.toContain("HINDSIGHT_TENANT_KEYS");
	});
	it("rejects credential rotation for a bound service instead of deleting elsewhere", async () => {
		const config = await import("$lib/server/config-store");
		vi.spyOn(config, "getConfig").mockReturnValue({
			...config.getConfig(),
			hindsightTenantKeys: '{"a3f54a51-679f-4211-9920-519ec8cb821d":"new-key"}',
			hindsightUrl: "http://wrong-service",
		});
		const { nativeMemoryClient } = await import("./hindsight-client");
		expect(() =>
			nativeMemoryClient(
				"bank",
				"a3f54a51-679f-4211-9920-519ec8cb821d",
				undefined,
				{
					baseUrl: "http://original-service",
					credentialHash: "old-key-hash",
				},
			),
		).toThrow("native_binding_credentials_changed");
	});
});

it("refuses unapproved private and public bank destinations before sending any credential", async () => {
	const config = await import("$lib/server/config-store");
	const current = config.getConfig();
	const tenant = "a3f54a51-679f-4211-9920-519ec8cb821d";
	vi.spyOn(config, "getConfig").mockReturnValue({
		...current,
		hindsightTenantMasterKeys: JSON.stringify({ v1: "ab".repeat(32) }),
		hindsightTenantActiveKey: "v1",
	});
	const { configuredNativeBinding, nativeMemoryClient } = await import(
		"./hindsight-client"
	);
	const binding = configuredNativeBinding(tenant);
	const transport = vi
		.spyOn(await import("./private-endpoint"), "fetchPrivateMemory")
		.mockResolvedValue(new Response("{}"));
	for (const baseUrl of [
		"https://public.example",
		"http://8.8.8.8",
		"http://169.254.169.254",
		"http://127.0.0.1:7000",
		"http://127.0.0.1:8888@public.example",
	]) {
		await expect(async () => {
			await nativeMemoryClient("bank", tenant, undefined, {
				...binding,
				baseUrl,
			}).verifyCapabilities();
		}).rejects.toMatchObject({ code: "native_destination_invalid" });
	}
	expect(transport).not.toHaveBeenCalled();
});
