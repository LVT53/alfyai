import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function prepareProviderDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	sqlite.close();
}

async function closeServiceDatabase() {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The service DB may not have been imported if setup failed early.
	}
}

describe("inference provider fallback persistence", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-inference-provider-fallback-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		await closeServiceDatabase();
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("stores rate-limit fallback config without leaking the fallback API key publicly", async () => {
		prepareProviderDatabase();
		const {
			createProvider,
			decryptApiKey,
			getProviderWithSecrets,
			listProviders,
		} = await import("./inference-providers");

		const created = await createProvider({
			name: "firepass",
			displayName: "Fire Pass Turbo",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			apiKey: "fpk_primary",
			modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
			enabled: true,
			maxModelContext: 262_144,
			rateLimitFallbackEnabled: true,
			rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
			rateLimitFallbackApiKey: "fallback-secret",
			rateLimitFallbackModelName: "kimi-k2.6",
			rateLimitFallbackTimeoutMs: 12_000,
		});

		const [publicProvider] = await listProviders();
		const providerWithSecrets = await getProviderWithSecrets(created.id);

		expect(publicProvider).toEqual(
			expect.objectContaining({
				id: created.id,
				rateLimitFallbackEnabled: true,
				rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
				rateLimitFallbackModelName: "kimi-k2.6",
				rateLimitFallbackTimeoutMs: 12_000,
			}),
		);
		expect(publicProvider).not.toHaveProperty("rateLimitFallbackApiKey");
		expect(publicProvider).not.toHaveProperty("rateLimitFallbackApiKeyEncrypted");
		expect(publicProvider).not.toHaveProperty("rateLimitFallbackApiKeyIv");
		expect(providerWithSecrets?.rateLimitFallbackApiKeyEncrypted).toEqual(
			expect.any(String),
		);
		expect(providerWithSecrets?.rateLimitFallbackApiKeyIv).toEqual(expect.any(String));
		expect(
			decryptApiKey(
				providerWithSecrets!.rateLimitFallbackApiKeyEncrypted!,
				providerWithSecrets!.rateLimitFallbackApiKeyIv!,
			),
		).toBe("fallback-secret");
	});

	it("updates fallback config while preserving an omitted fallback API key", async () => {
		prepareProviderDatabase();
		const {
			createProvider,
			decryptApiKey,
			getProviderWithSecrets,
			updateProvider,
		} = await import("./inference-providers");

		const created = await createProvider({
			name: "firepass",
			displayName: "Fire Pass Turbo",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			apiKey: "fpk_primary",
			modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
			enabled: true,
			maxModelContext: 262_144,
			rateLimitFallbackEnabled: true,
			rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1",
			rateLimitFallbackApiKey: "existing-fallback-secret",
			rateLimitFallbackModelName: "kimi-k2.6",
			rateLimitFallbackTimeoutMs: 10_000,
		});

		const updated = await updateProvider(created.id, {
			rateLimitFallbackEnabled: true,
			rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1/openai",
			rateLimitFallbackModelName: "kimi-k2.6-regular",
			rateLimitFallbackTimeoutMs: 18_000,
		});
		const providerWithSecrets = await getProviderWithSecrets(created.id);

		expect(updated).toEqual(
			expect.objectContaining({
				rateLimitFallbackEnabled: true,
				rateLimitFallbackBaseUrl: "https://api.moonshot.ai/v1/openai",
				rateLimitFallbackModelName: "kimi-k2.6-regular",
				rateLimitFallbackTimeoutMs: 18_000,
			}),
		);
		expect(
			decryptApiKey(
				providerWithSecrets!.rateLimitFallbackApiKeyEncrypted!,
				providerWithSecrets!.rateLimitFallbackApiKeyIv!,
			),
		).toBe("existing-fallback-secret");
	});
});
