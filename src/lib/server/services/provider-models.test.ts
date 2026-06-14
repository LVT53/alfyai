import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dbPath: string;

function createTestTables() {
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
		);

		CREATE TABLE IF NOT EXISTS provider_models (
			id TEXT PRIMARY KEY,
			provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			display_name TEXT NOT NULL,
			max_model_context INTEGER,
			compaction_ui_threshold INTEGER,
			target_constructed_context INTEGER,
			max_message_length INTEGER,
			max_tokens INTEGER,
			reasoning_effort TEXT,
			thinking_type TEXT,
			capabilities_json TEXT NOT NULL DEFAULT '{}',
			input_usd_micros_per_1m INTEGER NOT NULL DEFAULT 0,
			cached_input_usd_micros_per_1m INTEGER NOT NULL DEFAULT 0,
			cache_hit_usd_micros_per_1m INTEGER NOT NULL DEFAULT 0,
			cache_miss_usd_micros_per_1m INTEGER NOT NULL DEFAULT 0,
			output_usd_micros_per_1m INTEGER NOT NULL DEFAULT 0,
			enabled INTEGER NOT NULL DEFAULT 1,
			sort_order INTEGER NOT NULL DEFAULT 0,
			icon_asset_id TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
			UNIQUE(provider_id, name)
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

// ─── Helpers ───────────────────────────────────────────────────

async function seedProvider(
	name = "test-provider",
	displayName = "Test Provider",
) {
	const { createProvider } = await import("./providers");
	return createProvider({
		name,
		displayName,
		baseUrl: "https://api.test.com/v1",
		apiKey: "sk-test",
	});
}

// ─── ProviderModel CRUD ────────────────────────────────────────

describe("ProviderModel CRUD", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-provider-models-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		createTestTables();
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

	describe("createProviderModel", () => {
		it("creates a model from an admin payload with server-owned defaults", async () => {
			const { createProviderModelFromPayload } = await import(
				"./provider-models"
			);
			const provider = await seedProvider();

			const model = await createProviderModelFromPayload(provider.id, {
				name: "  payload-model  ",
				displayName: "  Payload Model  ",
				maxModelContext: 200_000,
				maxTokens: 4096,
				reasoningEffort: "high",
				thinkingType: "enabled",
				inputUsdMicrosPer1m: 15,
			});

			expect(model.name).toBe("payload-model");
			expect(model.displayName).toBe("Payload Model");
			expect(model.maxModelContext).toBe(200_000);
			expect(model.compactionUiThreshold).toBe(160_000);
			expect(model.targetConstructedContext).toBe(180_000);
			expect(model.maxTokens).toBe(4096);
			expect(model.reasoningEffort).toBe("high");
			expect(model.thinkingType).toBe("enabled");
			expect(model.inputUsdMicrosPer1m).toBe(15);
		});

		it("creates a model from the client form payload when blank optional fields are null", async () => {
			const { createProviderModelFromPayload } = await import(
				"./provider-models"
			);
			const provider = await seedProvider();

			const model = await createProviderModelFromPayload(provider.id, {
				name: "  nullable-create  ",
				displayName: "  Nullable Create  ",
				maxModelContext: null,
				compactionUiThreshold: null,
				targetConstructedContext: null,
				maxMessageLength: null,
				maxTokens: null,
				reasoningEffort: null,
				thinkingType: null,
				capabilitiesJson: null,
				inputUsdMicrosPer1m: 0,
				cachedInputUsdMicrosPer1m: 0,
				cacheHitUsdMicrosPer1m: 0,
				cacheMissUsdMicrosPer1m: 0,
				outputUsdMicrosPer1m: 0,
				enabled: true,
			});

			expect(model.name).toBe("nullable-create");
			expect(model.displayName).toBe("Nullable Create");
			expect(model.maxModelContext).toBeNull();
			expect(model.compactionUiThreshold).toBeNull();
			expect(model.targetConstructedContext).toBeNull();
			expect(model.maxMessageLength).toBeNull();
			expect(model.maxTokens).toBeNull();
			expect(model.reasoningEffort).toBeNull();
			expect(model.thinkingType).toBeNull();
			expect(model.capabilitiesJson).toBe("{}");
		});

		it("creates a model with default values", async () => {
			const { createProviderModel } = await import("./provider-models");
			const provider = await seedProvider();

			const model = await createProviderModel({
				providerId: provider.id,
				name: "gpt-4",
				displayName: "GPT-4",
			});

			expect(model.id).toBeTruthy();
			expect(model.providerId).toBe(provider.id);
			expect(model.name).toBe("gpt-4");
			expect(model.displayName).toBe("GPT-4");
			expect(model.enabled).toBe(true);
			expect(model.sortOrder).toBe(0);
			expect(model.inputUsdMicrosPer1m).toBe(0);
			expect(model.cachedInputUsdMicrosPer1m).toBe(0);
			expect(model.cacheHitUsdMicrosPer1m).toBe(0);
			expect(model.cacheMissUsdMicrosPer1m).toBe(0);
			expect(model.outputUsdMicrosPer1m).toBe(0);
			expect(model.capabilitiesJson).toBe("{}");
			expect(model.maxModelContext).toBeNull();
			expect(model.maxTokens).toBeNull();
			expect(model.reasoningEffort).toBeNull();
			expect(model.createdAt).toBeInstanceOf(Date);
			expect(model.updatedAt).toBeInstanceOf(Date);
		});

		it("creates a model with full configuration including pricing", async () => {
			const { createProviderModel } = await import("./provider-models");
			const provider = await seedProvider();

			const model = await createProviderModel({
				providerId: provider.id,
				name: "claude-3-opus",
				displayName: "Claude 3 Opus",
				maxModelContext: 200000,
				maxTokens: 4096,
				reasoningEffort: "high",
				thinkingType: "enabled",
				capabilitiesJson: '{"tools":true,"vision":true}',
				inputUsdMicrosPer1m: 1500,
				cachedInputUsdMicrosPer1m: 375,
				cacheHitUsdMicrosPer1m: 200,
				cacheMissUsdMicrosPer1m: 400,
				outputUsdMicrosPer1m: 7500,
				enabled: true,
				sortOrder: 5,
			});

			expect(model.maxModelContext).toBe(200000);
			expect(model.compactionUiThreshold).toBe(160000);
			expect(model.targetConstructedContext).toBe(180000);
			expect(model.maxTokens).toBe(4096);
			expect(model.reasoningEffort).toBe("high");
			expect(model.thinkingType).toBe("enabled");
			expect(model.capabilitiesJson).toBe('{"tools":true,"vision":true}');
			expect(model.inputUsdMicrosPer1m).toBe(1500);
			expect(model.cachedInputUsdMicrosPer1m).toBe(375);
			expect(model.cacheHitUsdMicrosPer1m).toBe(200);
			expect(model.cacheMissUsdMicrosPer1m).toBe(400);
			expect(model.outputUsdMicrosPer1m).toBe(7500);
			expect(model.enabled).toBe(true);
			expect(model.sortOrder).toBe(5);
		});

		it("keeps explicit context defaults authoritative when creating a model", async () => {
			const { createProviderModel } = await import("./provider-models");
			const provider = await seedProvider();

			const model = await createProviderModel({
				providerId: provider.id,
				name: "explicit-context",
				maxModelContext: 200000,
				compactionUiThreshold: 120000,
				targetConstructedContext: 150000,
			});

			expect(model.maxModelContext).toBe(200000);
			expect(model.compactionUiThreshold).toBe(120000);
			expect(model.targetConstructedContext).toBe(150000);
		});

		it("rejects creation when provider_id does not exist", async () => {
			const { createProviderModel } = await import("./provider-models");

			await expect(
				createProviderModel({
					providerId: "nonexistent-provider-id",
					name: "test-model",
					displayName: "Test Model",
				}),
			).rejects.toThrow();
		});

		it("rejects duplicate model name within the same provider", async () => {
			const { createProviderModel } = await import("./provider-models");
			const provider = await seedProvider();

			await createProviderModel({
				providerId: provider.id,
				name: "gpt-4",
				displayName: "GPT-4",
			});

			await expect(
				createProviderModel({
					providerId: provider.id,
					name: "gpt-4",
					displayName: "GPT-4 Again",
				}),
			).rejects.toThrow();
		});

		it("allows same model name across different providers", async () => {
			const { createProviderModel } = await import("./provider-models");
			const provider1 = await seedProvider("provider-a", "Provider A");
			const provider2 = await seedProvider("provider-b", "Provider B");

			const model1 = await createProviderModel({
				providerId: provider1.id,
				name: "gpt-4",
				displayName: "GPT-4 A",
			});

			const model2 = await createProviderModel({
				providerId: provider2.id,
				name: "gpt-4",
				displayName: "GPT-4 B",
			});

			expect(model1.id).toBeTruthy();
			expect(model2.id).toBeTruthy();
			expect(model1.id).not.toBe(model2.id);
		});

		it("defaults displayName to name when not provided", async () => {
			const { createProviderModel } = await import("./provider-models");
			const provider = await seedProvider();

			const model = await createProviderModel({
				providerId: provider.id,
				name: "gemini-pro",
			});

			expect(model.displayName).toBe("gemini-pro");
		});
	});

	describe("getProviderModel", () => {
		it("returns a model by id", async () => {
			const { createProviderModel, getProviderModel } = await import(
				"./provider-models"
			);
			const provider = await seedProvider();

			const created = await createProviderModel({
				providerId: provider.id,
				name: "gpt-3.5-turbo",
				displayName: "GPT-3.5 Turbo",
			});

			const fetched = assertDefined(
				await getProviderModel(created.id),
				"fetched model",
			);
			expect(fetched.name).toBe("gpt-3.5-turbo");
			expect(fetched.providerId).toBe(provider.id);
		});

		it("returns null for unknown id", async () => {
			const { getProviderModel } = await import("./provider-models");
			expect(await getProviderModel("nonexistent")).toBeNull();
		});
	});

	describe("getProviderModelByName", () => {
		it("finds a model by provider + name", async () => {
			const { createProviderModel, getProviderModelByName } = await import(
				"./provider-models"
			);
			const provider = await seedProvider();

			await createProviderModel({
				providerId: provider.id,
				name: "mixtral-8x7b",
				displayName: "Mixtral",
			});

			const found = assertDefined(
				await getProviderModelByName(provider.id, "mixtral-8x7b"),
				"model by name",
			);
			expect(found.displayName).toBe("Mixtral");
		});

		it("returns null when provider has no such model", async () => {
			const { getProviderModelByName } = await import("./provider-models");
			const provider = await seedProvider();

			expect(
				await getProviderModelByName(provider.id, "nonexistent-model"),
			).toBeNull();
		});

		it("returns null when the model exists under a different provider", async () => {
			const { createProviderModel, getProviderModelByName } = await import(
				"./provider-models"
			);
			const provider1 = await seedProvider("p1", "P1");
			const provider2 = await seedProvider("p2", "P2");

			await createProviderModel({
				providerId: provider1.id,
				name: "shared-name",
				displayName: "Shared",
			});

			// Lookup from provider2 should return null
			expect(
				await getProviderModelByName(provider2.id, "shared-name"),
			).toBeNull();
		});
	});

	describe("listProviderModels", () => {
		it("lists all models across all providers ordered by sort_order", async () => {
			const { createProviderModel, listProviderModels } = await import(
				"./provider-models"
			);
			const provider = await seedProvider();

			await createProviderModel({
				providerId: provider.id,
				name: "model-b",
				displayName: "Model B",
				sortOrder: 2,
			});
			await createProviderModel({
				providerId: provider.id,
				name: "model-a",
				displayName: "Model A",
				sortOrder: 1,
			});

			const all = await listProviderModels();
			expect(all.length).toBeGreaterThanOrEqual(2);
			const own = all.filter((m) => m.providerId === provider.id);
			expect(own).toHaveLength(2);
			expect(own[0].name).toBe("model-a");
			expect(own[1].name).toBe("model-b");
		});

		it("filters models by provider when providerId is provided", async () => {
			const { createProviderModel, listProviderModels } = await import(
				"./provider-models"
			);
			const provider1 = await seedProvider("p1", "P1");
			const provider2 = await seedProvider("p2", "P2");

			await createProviderModel({
				providerId: provider1.id,
				name: "p1-model",
				displayName: "P1 Model",
			});
			await createProviderModel({
				providerId: provider2.id,
				name: "p2-model",
				displayName: "P2 Model",
			});

			const p1Models = await listProviderModels(provider1.id);
			expect(p1Models).toHaveLength(1);
			expect(p1Models[0].name).toBe("p1-model");

			const emptyResult = await listProviderModels("nonexistent-provider");
			expect(emptyResult).toHaveLength(0);
		});

		it("returns empty array when no models exist", async () => {
			const { listProviderModels } = await import("./provider-models");
			expect(await listProviderModels()).toEqual([]);
		});
	});

	describe("listEnabledProviderModels", () => {
		it("returns only enabled models", async () => {
			const { createProviderModel, listEnabledProviderModels } = await import(
				"./provider-models"
			);
			const provider = await seedProvider();

			await createProviderModel({
				providerId: provider.id,
				name: "enabled-model",
				displayName: "Enabled",
				enabled: true,
			});
			await createProviderModel({
				providerId: provider.id,
				name: "disabled-model",
				displayName: "Disabled",
				enabled: false,
			});

			const enabled = await listEnabledProviderModels();
			const filtered = enabled.filter((m) => m.providerId === provider.id);
			expect(filtered).toHaveLength(1);
			expect(filtered[0].name).toBe("enabled-model");
		});

		it("filters by provider when providerId is provided", async () => {
			const { createProviderModel, listEnabledProviderModels } = await import(
				"./provider-models"
			);
			const provider1 = await seedProvider("p1-e", "P1 Enabled");
			const provider2 = await seedProvider("p2-e", "P2 Enabled");

			await createProviderModel({
				providerId: provider1.id,
				name: "p1-enabled",
				displayName: "P1E",
				enabled: true,
			});
			await createProviderModel({
				providerId: provider2.id,
				name: "p2-enabled",
				displayName: "P2E",
				enabled: true,
			});

			const p1Enabled = await listEnabledProviderModels(provider1.id);
			expect(p1Enabled).toHaveLength(1);
			expect(p1Enabled[0].name).toBe("p1-enabled");
		});
	});

	describe("updateProviderModel", () => {
		it("updates a model from an admin payload with nullable fields", async () => {
			const { createProviderModel, updateProviderModelFromPayload } =
				await import("./provider-models");
			const provider = await seedProvider();

			const created = await createProviderModel({
				providerId: provider.id,
				name: "payload-update",
				displayName: "Payload Update",
				maxModelContext: 32_000,
				maxTokens: 2048,
			});

			const updated = assertDefined(
				await updateProviderModelFromPayload(created.id, {
					displayName: "  Payload Updated  ",
					maxModelContext: 128_000,
					maxTokens: null,
					reasoningEffort: "",
				}),
				"updated model from payload",
			);

			expect(updated.displayName).toBe("Payload Updated");
			expect(updated.maxModelContext).toBe(128_000);
			expect(updated.compactionUiThreshold).toBe(102_400);
			expect(updated.targetConstructedContext).toBe(115_200);
			expect(updated.maxTokens).toBeNull();
			expect(updated.reasoningEffort).toBeNull();
		});

		it("updates display name and context limits", async () => {
			const { createProviderModel, updateProviderModel } = await import(
				"./provider-models"
			);
			const provider = await seedProvider();

			const created = await createProviderModel({
				providerId: provider.id,
				name: "update-test",
				displayName: "Old Name",
				maxModelContext: 4096,
			});

			const updated = assertDefined(
				await updateProviderModel(created.id, {
					displayName: "New Name",
					maxModelContext: 128000,
					maxTokens: 8000,
				}),
				"updated model",
			);

			expect(updated.displayName).toBe("New Name");
			expect(updated.maxModelContext).toBe(128000);
			expect(updated.compactionUiThreshold).toBe(102400);
			expect(updated.targetConstructedContext).toBe(115200);
			expect(updated.maxTokens).toBe(8000);
		});

		it("updates pricing fields", async () => {
			const { createProviderModel, updateProviderModel, getProviderModel } =
				await import("./provider-models");
			const provider = await seedProvider();

			const created = await createProviderModel({
				providerId: provider.id,
				name: "pricing-test",
				displayName: "Pricing Test",
			});

			await updateProviderModel(created.id, {
				inputUsdMicrosPer1m: 3000,
				cachedInputUsdMicrosPer1m: 750,
				cacheHitUsdMicrosPer1m: 300,
				cacheMissUsdMicrosPer1m: 500,
				outputUsdMicrosPer1m: 15000,
			});

			const fetched = assertDefined(
				await getProviderModel(created.id),
				"model after pricing update",
			);
			expect(fetched.inputUsdMicrosPer1m).toBe(3000);
			expect(fetched.cachedInputUsdMicrosPer1m).toBe(750);
			expect(fetched.cacheHitUsdMicrosPer1m).toBe(300);
			expect(fetched.cacheMissUsdMicrosPer1m).toBe(500);
			expect(fetched.outputUsdMicrosPer1m).toBe(15000);
		});

		it("updates capabilities", async () => {
			const { createProviderModel, updateProviderModel, getProviderModel } =
				await import("./provider-models");
			const provider = await seedProvider();

			const created = await createProviderModel({
				providerId: provider.id,
				name: "cap-test",
				displayName: "Cap Test",
			});

			await updateProviderModel(created.id, {
				capabilitiesJson: '{"tools":true,"vision":true,"streaming":true}',
				reasoningEffort: "medium",
				thinkingType: "enabled",
			});

			const fetched = assertDefined(
				await getProviderModel(created.id),
				"model after cap update",
			);
			expect(fetched.capabilitiesJson).toBe(
				'{"tools":true,"vision":true,"streaming":true}',
			);
			expect(fetched.reasoningEffort).toBe("medium");
			expect(fetched.thinkingType).toBe("enabled");
		});

		it("clears reasoning, thinking, and capabilities from a nullable admin payload", async () => {
			const { createProviderModel, updateProviderModelFromPayload } =
				await import("./provider-models");
			const provider = await seedProvider();

			const created = await createProviderModel({
				providerId: provider.id,
				name: "nullable-runtime-update",
				displayName: "Nullable Runtime Update",
				reasoningEffort: "high",
				thinkingType: "enabled",
				capabilitiesJson: '{"vision":true}',
			});

			const updated = assertDefined(
				await updateProviderModelFromPayload(created.id, {
					reasoningEffort: null,
					thinkingType: null,
					capabilitiesJson: null,
				}),
				"updated model with cleared runtime fields",
			);

			expect(updated.reasoningEffort).toBeNull();
			expect(updated.thinkingType).toBeNull();
			expect(updated.capabilitiesJson).toBe("{}");
		});

		it("disables a model", async () => {
			const {
				createProviderModel,
				updateProviderModel,
				listEnabledProviderModels,
			} = await import("./provider-models");
			const provider = await seedProvider();

			const created = await createProviderModel({
				providerId: provider.id,
				name: "disable-test",
				displayName: "Disable Test",
				enabled: true,
			});

			await updateProviderModel(created.id, { enabled: false });
			const enabled = await listEnabledProviderModels(provider.id);
			expect(enabled.find((m) => m.id === created.id)).toBeUndefined();
		});

		it("returns null for non-existent model", async () => {
			const { updateProviderModel } = await import("./provider-models");
			expect(
				await updateProviderModel("nonexistent", { displayName: "Nope" }),
			).toBeNull();
		});

		it("partial update preserves other fields", async () => {
			const { createProviderModel, updateProviderModel, getProviderModel } =
				await import("./provider-models");
			const provider = await seedProvider();

			const created = await createProviderModel({
				providerId: provider.id,
				name: "partial",
				displayName: "Original Name",
				maxModelContext: 32000,
				inputUsdMicrosPer1m: 500,
			});

			await updateProviderModel(created.id, {
				displayName: "Updated Name",
			});

			const fetched = assertDefined(
				await getProviderModel(created.id),
				"model after partial update",
			);
			expect(fetched.displayName).toBe("Updated Name");
			expect(fetched.maxModelContext).toBe(32000);
			expect(fetched.inputUsdMicrosPer1m).toBe(500);
		});
	});

	describe("deleteProviderModel", () => {
		it("deletes an existing model", async () => {
			const { createProviderModel, deleteProviderModel, getProviderModel } =
				await import("./provider-models");
			const provider = await seedProvider();

			const created = await createProviderModel({
				providerId: provider.id,
				name: "delete-me",
				displayName: "Delete Me",
			});

			const result = await deleteProviderModel(created.id);
			expect(result).toBe(true);
			expect(await getProviderModel(created.id)).toBeNull();
		});

		it("returns false for non-existent model", async () => {
			const { deleteProviderModel } = await import("./provider-models");
			expect(await deleteProviderModel("nonexistent")).toBe(false);
		});
	});

	describe("batchCreateProviderModels", () => {
		it("batch creates models from an admin discovery payload", async () => {
			const { batchCreateProviderModelsFromPayload } = await import(
				"./provider-models"
			);
			const provider = await seedProvider();

			const models = await batchCreateProviderModelsFromPayload(provider.id, {
				models: [
					{
						name: "  discovered-a  ",
						displayName: "  Discovered A  ",
						contextLength: 64_000,
						supportsChat: true,
						supportsTools: true,
					},
					{ name: "discovered-b" },
				],
			});

			expect(models.map((model) => model.name)).toEqual([
				"discovered-a",
				"discovered-b",
			]);
			expect(models[0].displayName).toBe("Discovered A");
			expect(models[0].maxModelContext).toBe(64_000);
			expect(models[0].compactionUiThreshold).toBe(51_200);
			expect(models[0].targetConstructedContext).toBe(57_600);
			expect(models[0].capabilitiesJson).toBe(
				JSON.stringify({ chat: "detected", tools: "detected" }),
			);
		});

		it("creates multiple models at once from a name list", async () => {
			const { batchCreateProviderModels, listProviderModels } = await import(
				"./provider-models"
			);
			const provider = await seedProvider();

			const models = await batchCreateProviderModels(provider.id, [
				{ name: "model-a", displayName: "Model A", contextLength: 64000 },
				{ name: "model-b", displayName: "Model B" },
				{ name: "model-c" },
			]);

			expect(models).toHaveLength(3);
			expect(models.map((m) => m.name)).toEqual([
				"model-a",
				"model-b",
				"model-c",
			]);
			expect(models[0].maxModelContext).toBe(64000);
			expect(models[0].compactionUiThreshold).toBe(51200);
			expect(models[0].targetConstructedContext).toBe(57600);
			expect(models[2].displayName).toBe("model-c"); // defaults to name

			const all = await listProviderModels(provider.id);
			expect(all).toHaveLength(3);
		});

		it("skips models that already exist by name (idempotent discovery)", async () => {
			const {
				createProviderModel,
				batchCreateProviderModels,
				listProviderModels,
			} = await import("./provider-models");
			const provider = await seedProvider();

			await createProviderModel({
				providerId: provider.id,
				name: "existing-model",
				displayName: "Already Exists",
			});

			const models = await batchCreateProviderModels(provider.id, [
				{ name: "existing-model", displayName: "Should Not Overwrite" },
				{ name: "new-model", displayName: "New One" },
			]);

			expect(models).toHaveLength(2); // both returned (existing + new)
			expect(models.find((m) => m.name === "existing-model")?.displayName).toBe(
				"Already Exists",
			);

			const all = await listProviderModels(provider.id);
			expect(all).toHaveLength(2);
		});

		it("returns empty result for empty input", async () => {
			const { batchCreateProviderModels } = await import("./provider-models");
			const provider = await seedProvider();

			const models = await batchCreateProviderModels(provider.id, []);
			expect(models).toEqual([]);
		});

		it("throws when provider does not exist", async () => {
			const { batchCreateProviderModels } = await import("./provider-models");

			await expect(
				batchCreateProviderModels("nonexistent-provider", [
					{ name: "model", displayName: "Model" },
				]),
			).rejects.toThrow();
		});
	});
});
