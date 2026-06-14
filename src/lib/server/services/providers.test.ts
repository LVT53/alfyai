import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

let dbPath: string;

function createProvidersTable() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS providers (
			id TEXT PRIMARY KEY,
			name TEXT UNIQUE NOT NULL,
			display_name TEXT NOT NULL,
			base_url TEXT NOT NULL,
			api_key_encrypted TEXT NOT NULL,
			api_key_iv TEXT NOT NULL,
			icon_asset_id TEXT,
			rate_limit_fallback_enabled INTEGER NOT NULL DEFAULT 0,
			rate_limit_fallback_base_url TEXT,
			rate_limit_fallback_api_key_encrypted TEXT,
			rate_limit_fallback_api_key_iv TEXT,
			rate_limit_fallback_model_name TEXT,
			rate_limit_fallback_timeout_ms INTEGER NOT NULL DEFAULT 10000,
			sort_order INTEGER NOT NULL DEFAULT 0,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		)
	`);
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

function assertDefined<T>(value: T | undefined | null, label: string): T {
	if (value === undefined || value === null) {
		throw new Error(`${label} was undefined or null`);
	}
	return value;
}

// ─── Encryption ────────────────────────────────────────────────

describe("encryptApiKey / decryptApiKey", () => {
	it("round-trips an API key", async () => {
		const { encryptApiKey, decryptApiKey } = await import("./providers");
		const original = "sk-test-key-12345";
		const { encrypted, iv } = encryptApiKey(original);
		expect(encrypted).toBeTruthy();
		expect(typeof encrypted).toBe("string");
		expect(iv).toBeTruthy();
		expect(typeof iv).toBe("string");
		expect(iv).not.toBe(encrypted);

		const decrypted = decryptApiKey(encrypted, iv);
		expect(decrypted).toBe(original);
	});

	it("accepts legacy plaintext provider API keys stored without an IV", async () => {
		const { decryptApiKey } = await import("./providers");
		expect(decryptApiKey("legacy-local-token", "")).toBe("legacy-local-token");
	});

	it("produces unique ciphertexts for the same plaintext", async () => {
		const { encryptApiKey } = await import("./providers");
		const key = "same-key";
		const a = encryptApiKey(key);
		const b = encryptApiKey(key);
		expect(a.encrypted).not.toBe(b.encrypted);
		expect(a.iv).not.toBe(b.iv);
	});
});

// ─── Validation ────────────────────────────────────────────────

describe("validateProviderName", () => {
	it("accepts valid machine-name slugs", async () => {
		const { validateProviderName } = await import("./providers");
		expect(validateProviderName("openai")).toBe(true);
		expect(validateProviderName("my_provider_01")).toBe(true);
		expect(validateProviderName("deepseek-chat")).toBe(true);
		expect(validateProviderName("ProviderABC123")).toBe(true);
	});

	it("rejects names with spaces or special chars", async () => {
		const { validateProviderName } = await import("./providers");
		expect(validateProviderName("open ai")).toBe(false);
		expect(validateProviderName("provider@test")).toBe(false);
		expect(validateProviderName("provider!")).toBe(false);
		expect(validateProviderName("")).toBe(false);
	});
});

// ─── Persistence CRUD ──────────────────────────────────────────

describe("Provider CRUD", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-providers-crud-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		createProvidersTable();
		vi.resetModules();
	});

	afterEach(async () => {
		await closeServiceDatabase();
		try {
			unlinkSync(dbPath);
		} catch {
			// best-effort cleanup
		}
	});

	describe("createProvider", () => {
		it("creates a provider and returns public fields (no secrets)", async () => {
			const { createProvider } = await import("./providers");

			const provider = await createProvider({
				name: "test-openai",
				displayName: "Test OpenAI",
				baseUrl: "https://api.openai.com/v1",
				apiKey: "sk-abc123",
			});

			expect(provider.id).toBeTruthy();
			expect(provider.name).toBe("test-openai");
			expect(provider.displayName).toBe("Test OpenAI");
			expect(provider.baseUrl).toBe("https://api.openai.com/v1");
			expect(provider.enabled).toBe(true);
			expect(provider.sortOrder).toBe(0);
			expect(provider.createdAt).toBeInstanceOf(Date);
			expect(provider.updatedAt).toBeInstanceOf(Date);

			// Public interface must not leak key material
			expect(
				(provider as Record<string, unknown>).apiKeyEncrypted,
			).toBeUndefined();
			expect((provider as Record<string, unknown>).apiKeyIv).toBeUndefined();
			expect((provider as Record<string, unknown>).apiKey).toBeUndefined();
		});

		it("persists optional rate-limit fallback fields", async () => {
			const { createProvider, getProviderWithSecrets } = await import(
				"./providers"
			);

			const provider = await createProvider({
				name: "with-fallback",
				displayName: "Fallback Provider",
				baseUrl: "https://api.primary.com/v1",
				apiKey: "pk-123",
				rateLimitFallbackEnabled: true,
				rateLimitFallbackBaseUrl: "https://api.fallback.com/v1",
				rateLimitFallbackApiKey: "fk-456",
				rateLimitFallbackModelName: "fallback-model",
				rateLimitFallbackTimeoutMs: 15000,
			});

			const secrets = assertDefined(
				await getProviderWithSecrets(provider.id),
				"provider with secrets",
			);

			expect(secrets.rateLimitFallbackEnabled).toBe(true);
			expect(secrets.rateLimitFallbackBaseUrl).toBe(
				"https://api.fallback.com/v1",
			);
			expect(secrets.rateLimitFallbackModelName).toBe("fallback-model");
			expect(secrets.rateLimitFallbackTimeoutMs).toBe(15000);
			expect(secrets.rateLimitFallbackApiKeyEncrypted).toBeTruthy();
			expect(secrets.rateLimitFallbackApiKeyIv).toBeTruthy();

			// Decrypt fallback key
			const { decryptApiKey } = await import("./providers");
			const decryptedFallback = decryptApiKey(
				assertDefined(
					secrets.rateLimitFallbackApiKeyEncrypted,
					"fallback encrypted",
				),
				assertDefined(secrets.rateLimitFallbackApiKeyIv, "fallback iv"),
			);
			expect(decryptedFallback).toBe("fk-456");
		});

		it("rejects duplicate names", async () => {
			const { createProvider } = await import("./providers");

			await createProvider({
				name: "unique-name",
				displayName: "First",
				baseUrl: "https://api.example.com/v1",
				apiKey: "key1",
			});

			await expect(
				createProvider({
					name: "unique-name",
					displayName: "Second",
					baseUrl: "https://api.other.com/v1",
					apiKey: "key2",
				}),
			).rejects.toThrow();
		});
	});

	describe("getProvider / getProviderWithSecrets", () => {
		it("returns null for unknown id", async () => {
			const { getProvider, getProviderWithSecrets } = await import(
				"./providers"
			);
			expect(await getProvider("nonexistent")).toBeNull();
			expect(await getProviderWithSecrets("nonexistent")).toBeNull();
		});

		it("getProvider excludes encrypted key fields", async () => {
			const { createProvider, getProvider } = await import("./providers");

			const created = await createProvider({
				name: "getter-test",
				displayName: "Getter Test",
				baseUrl: "https://api.test.com/v1",
				apiKey: "sk-secret-key",
			});

			const fetched = assertDefined(
				await getProvider(created.id),
				"fetched provider",
			);
			expect(fetched.name).toBe("getter-test");
			expect(
				(fetched as Record<string, unknown>).apiKeyEncrypted,
			).toBeUndefined();
		});

		it("getProviderWithSecrets includes encrypted fields and decrypts", async () => {
			const { createProvider, getProviderWithSecrets, decryptApiKey } =
				await import("./providers");

			const created = await createProvider({
				name: "secrets-test",
				displayName: "Secrets Test",
				baseUrl: "https://api.secrets.com/v1",
				apiKey: "sk-super-secret",
			});

			const secrets = assertDefined(
				await getProviderWithSecrets(created.id),
				"provider with secrets",
			);

			expect(secrets.apiKeyEncrypted).toBeTruthy();
			expect(secrets.apiKeyIv).toBeTruthy();
			expect(decryptApiKey(secrets.apiKeyEncrypted, secrets.apiKeyIv)).toBe(
				"sk-super-secret",
			);
		});
	});

	describe("getProviderByName", () => {
		it("finds a provider by machine name", async () => {
			const { createProvider, getProviderByName } = await import("./providers");

			await createProvider({
				name: "by-name-test",
				displayName: "By Name",
				baseUrl: "https://api.byname.com/v1",
				apiKey: "key",
			});

			const found = assertDefined(
				await getProviderByName("by-name-test"),
				"provider by name",
			);
			expect(found.displayName).toBe("By Name");
		});

		it("returns null for unknown name", async () => {
			const { getProviderByName } = await import("./providers");
			expect(await getProviderByName("ghost-provider")).toBeNull();
		});
	});

	describe("listProviders / listEnabledProviders", () => {
		it("lists all providers ordered by sort_order", async () => {
			const { createProvider, listProviders } = await import("./providers");

			await createProvider({
				name: "first",
				displayName: "First",
				baseUrl: "https://api.a.com/v1",
				apiKey: "k1",
				sortOrder: 2,
			});
			await createProvider({
				name: "second",
				displayName: "Second",
				baseUrl: "https://api.b.com/v1",
				apiKey: "k2",
				sortOrder: 1,
			});

			const all = await listProviders();
			expect(all).toHaveLength(2);
			expect(all[0].name).toBe("second"); // lower sortOrder first
			expect(all[1].name).toBe("first");
		});

		it("filters disabled providers in listEnabledProviders", async () => {
			const { createProvider, listEnabledProviders } = await import(
				"./providers"
			);

			await createProvider({
				name: "enabled-one",
				displayName: "Enabled",
				baseUrl: "https://api.enabled.com/v1",
				apiKey: "k",
				enabled: true,
			});
			await createProvider({
				name: "disabled-one",
				displayName: "Disabled",
				baseUrl: "https://api.disabled.com/v1",
				apiKey: "k",
				enabled: false,
			});

			const enabled = await listEnabledProviders();
			expect(enabled).toHaveLength(1);
			expect(enabled[0].name).toBe("enabled-one");

			// But listProviders still returns both
			const { listProviders } = await import("./providers");
			expect(await listProviders()).toHaveLength(2);
		});
	});

	describe("updateProvider", () => {
		it("updates display name without touching encrypted fields", async () => {
			const {
				createProvider,
				updateProvider,
				getProviderWithSecrets,
				decryptApiKey,
			} = await import("./providers");

			const created = await createProvider({
				name: "update-display",
				displayName: "Old Name",
				baseUrl: "https://api.old.com/v1",
				apiKey: "old-key",
			});

			const updated = assertDefined(
				await updateProvider(created.id, { displayName: "New Name" }),
				"updated provider",
			);
			expect(updated.displayName).toBe("New Name");

			// Key should still decrypt to original
			const secrets = assertDefined(
				await getProviderWithSecrets(created.id),
				"secrets after update",
			);
			expect(decryptApiKey(secrets.apiKeyEncrypted, secrets.apiKeyIv)).toBe(
				"old-key",
			);
		});

		it("re-encrypts API key when changed", async () => {
			const {
				createProvider,
				updateProvider,
				getProviderWithSecrets,
				decryptApiKey,
			} = await import("./providers");

			const created = await createProvider({
				name: "rotate-key",
				displayName: "Rotate",
				baseUrl: "https://api.rotate.com/v1",
				apiKey: "old-key",
			});

			await updateProvider(created.id, { apiKey: "new-key" });

			const secrets = assertDefined(
				await getProviderWithSecrets(created.id),
				"secrets after rotation",
			);
			expect(decryptApiKey(secrets.apiKeyEncrypted, secrets.apiKeyIv)).toBe(
				"new-key",
			);
		});

		it("clears fallback key when set to empty", async () => {
			const { createProvider, updateProvider, getProviderWithSecrets } =
				await import("./providers");

			const created = await createProvider({
				name: "clear-fallback",
				displayName: "Clear Fallback",
				baseUrl: "https://api.clear.com/v1",
				apiKey: "key",
				rateLimitFallbackEnabled: true,
				rateLimitFallbackApiKey: "fb-key",
			});

			await updateProvider(created.id, { rateLimitFallbackApiKey: "" });

			const secrets = assertDefined(
				await getProviderWithSecrets(created.id),
				"secrets after clearing fallback",
			);
			expect(secrets.rateLimitFallbackApiKeyEncrypted).toBeNull();
			expect(secrets.rateLimitFallbackApiKeyIv).toBeNull();
		});

		it("disables a provider", async () => {
			const { createProvider, updateProvider, listEnabledProviders } =
				await import("./providers");

			const created = await createProvider({
				name: "disable-me",
				displayName: "Disable Me",
				baseUrl: "https://api.disable.com/v1",
				apiKey: "key",
				enabled: true,
			});

			await updateProvider(created.id, { enabled: false });
			const enabled = await listEnabledProviders();
			expect(enabled.find((p) => p.id === created.id)).toBeUndefined();
		});

		it("returns null for non-existent provider", async () => {
			const { updateProvider } = await import("./providers");
			expect(
				await updateProvider("nonexistent", { displayName: "Nope" }),
			).toBeNull();
		});

		it("partially updates rate-limit fallback config", async () => {
			const { createProvider, updateProvider, getProviderWithSecrets } =
				await import("./providers");

			const created = await createProvider({
				name: "partial-fallback",
				displayName: "Partial",
				baseUrl: "https://api.partial.com/v1",
				apiKey: "key",
			});

			await updateProvider(created.id, {
				rateLimitFallbackEnabled: true,
				rateLimitFallbackBaseUrl: "https://fb.example.com/v1",
			});

			const secrets = assertDefined(
				await getProviderWithSecrets(created.id),
				"secrets after partial fallback update",
			);
			expect(secrets.rateLimitFallbackEnabled).toBe(true);
			expect(secrets.rateLimitFallbackBaseUrl).toBe(
				"https://fb.example.com/v1",
			);
		});
	});

	describe("deleteProvider", () => {
		it("deletes an existing provider", async () => {
			const { createProvider, deleteProvider, getProvider } = await import(
				"./providers"
			);

			const created = await createProvider({
				name: "delete-me",
				displayName: "Delete Me",
				baseUrl: "https://api.del.com/v1",
				apiKey: "key",
			});

			const result = await deleteProvider(created.id);
			expect(result).toBe(true);
			expect(await getProvider(created.id)).toBeNull();
		});

		it("returns false for non-existent provider", async () => {
			const { deleteProvider } = await import("./providers");
			expect(await deleteProvider("nonexistent")).toBe(false);
		});
	});
});

// ─── Connection Validation (mocked fetch) ──────────────────────

describe("validateProviderConnection", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("returns valid when /v1/models responds 200", async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ object: "list", data: [{ id: "gpt-4" }] }),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const { validateProviderConnection } = await import("./providers");
		const result = await validateProviderConnection(
			"https://api.example.com/v1",
			"sk-key",
		);
		expect(result.valid).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("returns invalid for 401 response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Unauthorized", { status: 401 })),
		);
		const { validateProviderConnection } = await import("./providers");
		const result = await validateProviderConnection(
			"https://api.example.com/v1",
			"bad-key",
		);
		expect(result.valid).toBe(false);
		expect(result.error).toBe("Invalid API key");
	});

	it("returns invalid for non-http protocol", async () => {
		const { validateProviderConnection } = await import("./providers");
		const result = await validateProviderConnection(
			"ftp://api.example.com/v1",
			"key",
		);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("HTTP");
	});
});

// ─── Model Discovery (mocked fetch) ────────────────────────────

describe("modelDiscovery", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("discovers model IDs from standard /v1/models endpoint", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					object: "list",
					data: [
						{ id: "gpt-4", object: "model" },
						{ id: "gpt-3.5-turbo", object: "model" },
					],
				}),
			),
		);

		const { modelDiscovery } = await import("./providers");
		const models = await modelDiscovery("https://api.openai.com/v1", "sk-key");
		expect(models).toEqual([{ id: "gpt-4" }, { id: "gpt-3.5-turbo" }]);
	});

	it("handles deepseek.com /models endpoint", async () => {
		const fetchSpy = vi.fn(async () =>
			Response.json({ data: [{ id: "deepseek-chat" }] }),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const { modelDiscovery } = await import("./providers");
		const models = await modelDiscovery("https://api.deepseek.com", "sk-key");

		expect(models).toEqual([{ id: "deepseek-chat" }]);
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining("api.deepseek.com/models"),
			expect.any(Object),
		);
	});

	it("handles fireworks.ai /inference/v1/models endpoint", async () => {
		const fetchSpy = vi.fn(async () =>
			Response.json({
				data: [{ id: "accounts/fireworks/models/mixtral-8x7b-instruct" }],
			}),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const { modelDiscovery } = await import("./providers");
		const models = await modelDiscovery(
			"https://api.fireworks.ai/inference/v1",
			"sk-key",
		);

		expect(models).toHaveLength(1);
		expect(models[0].id).toBe(
			"accounts/fireworks/models/mixtral-8x7b-instruct",
		);
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining("/inference/v1/models"),
			expect.any(Object),
		);
	});

	it("throws on 401 with Invalid API key message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 401 })),
		);
		const { modelDiscovery } = await import("./providers");
		await expect(
			modelDiscovery("https://api.example.com/v1", "bad-key"),
		).rejects.toThrow("Invalid API key");
	});

	it("throws on 404 with endpoint not supported message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 404 })),
		);
		const { modelDiscovery } = await import("./providers");
		await expect(
			modelDiscovery("https://api.example.com/v1", "key"),
		).rejects.toThrow("not supported");
	});

	it("throws on timeout", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				const error = new Error("The operation was aborted");
				error.name = "TimeoutError";
				return Promise.reject(error);
			}),
		);
		const { modelDiscovery } = await import("./providers");
		await expect(
			modelDiscovery("https://api.example.com/v1", "key"),
		).rejects.toThrow("timeout");
	});

	it("handles { models: [...] } response format as fallback", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					models: [{ id: "model-a" }, { id: "model-b" }],
				}),
			),
		);
		const { modelDiscovery } = await import("./providers");
		const models = await modelDiscovery("https://api.custom.com/v1", "key");
		expect(models).toEqual([{ id: "model-a" }, { id: "model-b" }]);
	});

	it("extracts Fireworks metadata from /inference/v1/models", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: [
						{
							id: "accounts/fireworks/models/mixtral-8x7b",
							supports_chat: true,
							supports_tools: true,
							context_length: 32768,
						},
						{
							id: "accounts/fireworks/models/embedding-model",
							supports_chat: false,
							supports_tools: false,
							context_length: 8192,
						},
					],
				}),
			),
		);
		const { modelDiscovery } = await import("./providers");
		const models = await modelDiscovery(
			"https://api.fireworks.ai/inference/v1",
			"sk-key",
		);
		expect(models).toEqual([
			{
				id: "accounts/fireworks/models/mixtral-8x7b",
				contextLength: 32768,
				supportsChat: true,
				supportsTools: true,
			},
			{
				id: "accounts/fireworks/models/embedding-model",
				contextLength: 8192,
				supportsChat: false,
				supportsTools: false,
			},
		]);
	});

	it("extracts vLLM max_model_len metadata", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: [
						{ id: "meta-llama/Llama-3-70b", max_model_len: 8192 },
						{ id: "mistralai/Mistral-7B-v0.1", max_model_len: 32768 },
					],
				}),
			),
		);
		const { modelDiscovery } = await import("./providers");
		const models = await modelDiscovery("https://vllm.example.com/v1", "key");
		expect(models).toEqual([
			{ id: "meta-llama/Llama-3-70b", contextLength: 8192 },
			{ id: "mistralai/Mistral-7B-v0.1", contextLength: 32768 },
		]);
	});

	it("returns models without metadata when response lacks extra fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: [
						{ id: "gpt-4", object: "model" },
						{ id: "gpt-3.5-turbo", object: "model" },
					],
				}),
			),
		);
		const { modelDiscovery } = await import("./providers");
		const models = await modelDiscovery("https://api.openai.com/v1", "sk-key");
		expect(models).toEqual([{ id: "gpt-4" }, { id: "gpt-3.5-turbo" }]);
	});
});
