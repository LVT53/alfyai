import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/db", () => ({ db: {} }));
vi.mock("$lib/server/services/normal-chat-model", () => ({
	resolveNormalChatModelRunProvider: vi.fn(),
}));
vi.mock("$lib/server/services/providers", () => ({
	getProviderByName: vi.fn(),
}));

import {
	ADMIN_CONFIG_KEYS,
	type AdminConfigKey,
} from "$lib/server/config-store";
import {
	buildEffectiveConfigEntries,
	getEffectiveConfigReport,
	isSecretConfigKey,
	SECRET_MASK,
} from "./admin-effective-config";

function record(values: Partial<Record<AdminConfigKey, string>>) {
	return Object.fromEntries(
		ADMIN_CONFIG_KEYS.map((key) => [key, values[key] ?? ""]),
	) as Record<AdminConfigKey, string>;
}

describe("admin effective config", () => {
	it("classifies secret keys", () => {
		expect(isSecretConfigKey("PARALLEL_API_KEY")).toBe(true);
		expect(isSecretConfigKey("MODEL_1_API_KEY")).toBe(true);
		expect(isSecretConfigKey("GOOGLE_OAUTH_CLIENT_SECRET")).toBe(true);
		expect(isSecretConfigKey("OWNTRACKS_RECORDER_PASS")).toBe(true);
		expect(isSecretConfigKey("WEB_PUSH_VAPID_PRIVATE_KEY")).toBe(true);
		expect(isSecretConfigKey("WEB_PUSH_VAPID_PUBLIC_KEY")).toBe(false);
		expect(isSecretConfigKey("PARALLEL_BASE_URL")).toBe(false);
	});

	it("reports source per key and masks secrets everywhere", () => {
		const entries = buildEffectiveConfigEntries(
			{ PARALLEL_API_KEY: "db-key", MAX_FILE_UPLOAD_SIZE: "123" },
			record({
				PARALLEL_API_KEY: "env-key",
				PARALLEL_BASE_URL: "https://api.parallel.ai",
				ORS_BASE_URL: "http://ors:8082",
			}),
			record({
				PARALLEL_API_KEY: "db-key",
				PARALLEL_BASE_URL: "https://api.parallel.ai",
				ORS_BASE_URL: "http://ors:8082",
				MAX_FILE_UPLOAD_SIZE: "123",
			}),
			(key) => (key === "ORS_BASE_URL" ? "http://ors:8082" : undefined),
		);
		const byKey = Object.fromEntries(
			entries.map((entry) => [entry.key, entry]),
		);

		expect(entries).toHaveLength(ADMIN_CONFIG_KEYS.length);
		expect(byKey.PARALLEL_API_KEY).toEqual({
			key: "PARALLEL_API_KEY",
			envValue: SECRET_MASK,
			adminOverride: SECRET_MASK,
			effectiveValue: SECRET_MASK,
			source: "admin_config",
			secret: true,
		});
		expect(byKey.MAX_FILE_UPLOAD_SIZE.source).toBe("admin_config");
		expect(byKey.MAX_FILE_UPLOAD_SIZE.adminOverride).toBe("123");
		expect(byKey.ORS_BASE_URL.source).toBe("env");
		expect(byKey.ORS_BASE_URL.adminOverride).toBeNull();
		expect(byKey.PARALLEL_BASE_URL.source).toBe("default");
		expect(byKey.PARALLEL_BASE_URL.effectiveValue).toBe(
			"https://api.parallel.ai",
		);
		expect(byKey.BRAVE_SEARCH_API_KEY.effectiveValue).toBe("");
		expect(JSON.stringify(entries)).not.toContain("db-key");
		expect(JSON.stringify(entries)).not.toContain("env-key");
	});

	it("assembles the report from injected deps", async () => {
		const report = await getEffectiveConfigReport({
			loadOverrides: async () => ({ MODEL_1_NAME: "override-model" }),
			envDefaults: () => record({ MODEL_1_NAME: "env-model" }),
			resolvedValues: () => record({ MODEL_1_NAME: "override-model" }),
			processEnv: () => undefined,
			resolveModel: async (key) => ({
				key,
				providerRowFound: key === "model1",
				providerEnabled: key === "model1",
				resolvedModelId: key === "model1" ? "provider:p1:m1" : null,
				resolvedModelName: key === "model1" ? "served-model" : null,
				resolvedBaseUrl: null,
				resolvedFrom: key === "model1" ? "providers_table" : "admin_config_env",
				shadowedOverrides: key === "model1" ? ["MODEL_1_NAME"] : [],
				error: null,
			}),
			now: () => new Date("2026-09-05T10:00:00.000Z"),
		});
		expect(report.generatedAt).toBe("2026-09-05T10:00:00.000Z");
		expect(report.models.map((model) => model.key)).toEqual([
			"model1",
			"model2",
		]);
		expect(report.models[0].shadowedOverrides).toEqual(["MODEL_1_NAME"]);
		const model1Name = report.entries.find((e) => e.key === "MODEL_1_NAME");
		expect(model1Name?.source).toBe("admin_config");
		expect(model1Name?.effectiveValue).toBe("override-model");
	});
});
