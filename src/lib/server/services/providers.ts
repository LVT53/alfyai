import {
	createCipheriv,
	createDecipheriv,
	pbkdf2Sync,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { providerModels, providers } from "../db/schema";
import { config } from "../env";
import { buildOpenAICompatibleUrl } from "./openai-compatible-url";

type ProviderRow = typeof providers.$inferSelect;

export interface Provider {
	id: string;
	name: string;
	displayName: string;
	baseUrl: string;
	iconAssetId: string | null;
	processingRegionCode: string | null;
	privacyPolicyUrl: string | null;
	rateLimitFallbackEnabled: boolean;
	rateLimitFallbackBaseUrl: string | null;
	rateLimitFallbackModelName: string | null;
	rateLimitFallbackTimeoutMs: number;
	sortOrder: number;
	enabled: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export interface ProviderWithSecrets extends Provider {
	apiKeyEncrypted: string;
	apiKeyIv: string;
	rateLimitFallbackApiKeyEncrypted: string | null;
	rateLimitFallbackApiKeyIv: string | null;
}

export interface CreateProviderInput {
	name: string;
	displayName: string;
	baseUrl: string;
	apiKey: string;
	iconAssetId?: string | null;
	processingRegionCode?: string | null;
	privacyPolicyUrl?: string | null;
	rateLimitFallbackEnabled?: boolean;
	rateLimitFallbackBaseUrl?: string | null;
	rateLimitFallbackApiKey?: string | null;
	rateLimitFallbackModelName?: string | null;
	rateLimitFallbackTimeoutMs?: number | null;
	sortOrder?: number;
	enabled?: boolean;
}

export interface UpdateProviderInput {
	displayName?: string;
	baseUrl?: string;
	apiKey?: string;
	iconAssetId?: string | null;
	processingRegionCode?: string | null;
	privacyPolicyUrl?: string | null;
	rateLimitFallbackEnabled?: boolean;
	rateLimitFallbackBaseUrl?: string | null;
	rateLimitFallbackApiKey?: string | null;
	rateLimitFallbackModelName?: string | null;
	rateLimitFallbackTimeoutMs?: number | null;
	sortOrder?: number;
	enabled?: boolean;
}

function deriveEncryptionKey(secret: string): Buffer {
	return pbkdf2Sync(secret, "alfyai-providers", 100000, 32, "sha256");
}

export function encryptApiKey(plaintext: string): {
	encrypted: string;
	iv: string;
} {
	const sessionSecret = config.sessionSecret;
	const key = deriveEncryptionKey(sessionSecret);
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const authTag = cipher.getAuthTag();
	return {
		encrypted: Buffer.concat([encrypted, authTag]).toString("base64"),
		iv: iv.toString("base64"),
	};
}

export function decryptApiKey(encrypted: string, iv: string): string {
	if (!iv) {
		// Older/manual provider rows may store an unauthenticated local endpoint token
		// directly in api_key_encrypted with an empty IV. Keep those rows runnable.
		return encrypted;
	}
	const sessionSecret = config.sessionSecret;
	const key = deriveEncryptionKey(sessionSecret);
	const ivBuffer = Buffer.from(iv, "base64");
	const encryptedBuffer = Buffer.from(encrypted, "base64");
	const authTag = encryptedBuffer.slice(-16);
	const ciphertext = encryptedBuffer.slice(0, -16);
	const decipher = createDecipheriv("aes-256-gcm", key, ivBuffer);
	decipher.setAuthTag(authTag);
	return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

export function validateProviderName(name: string): boolean {
	return /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0;
}

export function normalizeProcessingRegionCode(
	code: string | null | undefined,
): string | null {
	const trimmed = code?.trim().toUpperCase() ?? "";
	if (!trimmed) return null;
	if (!/^[A-Z]{2}$/.test(trimmed)) {
		throw new Error("Processing region must be a two-letter country code");
	}
	return trimmed;
}

export function normalizePrivacyPolicyUrl(
	url: string | null | undefined,
): string | null {
	const trimmed = url?.trim() ?? "";
	if (!trimmed) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("Privacy policy URL must be a valid URL");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("Privacy policy URL must use HTTP or HTTPS protocol");
	}
	return trimmed;
}

function validateBaseUrlProtocol(url: string): void {
	const parsed = new URL(url);
	if (!parsed.protocol.startsWith("http")) {
		throw new Error("Base URL must use HTTP or HTTPS protocol");
	}
}

function mapRowToProvider(row: ProviderRow): Provider {
	return {
		id: row.id,
		name: row.name,
		displayName: row.displayName,
		baseUrl: row.baseUrl,
		iconAssetId: row.iconAssetId ?? null,
		processingRegionCode: row.processingRegionCode ?? null,
		privacyPolicyUrl: row.privacyPolicyUrl ?? null,
		rateLimitFallbackEnabled: row.rateLimitFallbackEnabled === 1,
		rateLimitFallbackBaseUrl: row.rateLimitFallbackBaseUrl ?? null,
		rateLimitFallbackModelName: row.rateLimitFallbackModelName ?? null,
		rateLimitFallbackTimeoutMs: row.rateLimitFallbackTimeoutMs ?? 10000,
		sortOrder: row.sortOrder ?? 0,
		enabled: row.enabled === 1,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function mapRowToProviderWithSecrets(row: ProviderRow): ProviderWithSecrets {
	return {
		...mapRowToProvider(row),
		apiKeyEncrypted: row.apiKeyEncrypted,
		apiKeyIv: row.apiKeyIv,
		rateLimitFallbackApiKeyEncrypted:
			row.rateLimitFallbackApiKeyEncrypted ?? null,
		rateLimitFallbackApiKeyIv: row.rateLimitFallbackApiKeyIv ?? null,
	};
}

export async function createProvider(
	input: CreateProviderInput,
): Promise<Provider> {
	if (!validateProviderName(input.name)) {
		throw new Error(
			"Provider name must contain only letters, numbers, underscores, and hyphens",
		);
	}
	validateBaseUrlProtocol(input.baseUrl);
	const processingRegionCode = normalizeProcessingRegionCode(
		input.processingRegionCode,
	);
	const privacyPolicyUrl = normalizePrivacyPolicyUrl(input.privacyPolicyUrl);

	const { encrypted, iv } = encryptApiKey(input.apiKey);
	const fallbackApiKey = input.rateLimitFallbackApiKey?.trim()
		? encryptApiKey(input.rateLimitFallbackApiKey)
		: null;
	const now = new Date();

	const [provider] = await db
		.insert(providers)
		.values({
			id: randomUUID(),
			name: input.name,
			displayName: input.displayName,
			baseUrl: input.baseUrl,
			apiKeyEncrypted: encrypted,
			apiKeyIv: iv,
			iconAssetId: input.iconAssetId ?? null,
			processingRegionCode,
			privacyPolicyUrl,
			rateLimitFallbackEnabled: input.rateLimitFallbackEnabled ? 1 : 0,
			rateLimitFallbackBaseUrl: input.rateLimitFallbackBaseUrl ?? null,
			rateLimitFallbackApiKeyEncrypted: fallbackApiKey?.encrypted ?? null,
			rateLimitFallbackApiKeyIv: fallbackApiKey?.iv ?? null,
			rateLimitFallbackModelName: input.rateLimitFallbackModelName ?? null,
			rateLimitFallbackTimeoutMs: input.rateLimitFallbackTimeoutMs ?? 10000,
			sortOrder: input.sortOrder ?? 0,
			enabled: input.enabled === false ? 0 : 1,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return mapRowToProvider(provider);
}

export async function getProvider(id: string): Promise<Provider | null> {
	const [row] = await db.select().from(providers).where(eq(providers.id, id));

	return row ? mapRowToProvider(row) : null;
}

export async function getProviderWithSecrets(
	id: string,
): Promise<ProviderWithSecrets | null> {
	const [row] = await db.select().from(providers).where(eq(providers.id, id));

	return row ? mapRowToProviderWithSecrets(row) : null;
}

export async function getProviderByName(
	name: string,
): Promise<Provider | null> {
	const [row] = await db
		.select()
		.from(providers)
		.where(eq(providers.name, name));

	return row ? mapRowToProvider(row) : null;
}

export async function listProviders(): Promise<Provider[]> {
	const rows = await db.select().from(providers).orderBy(providers.sortOrder);

	return rows.map(mapRowToProvider);
}

export async function listEnabledProviders(): Promise<Provider[]> {
	const rows = await db
		.select()
		.from(providers)
		.where(eq(providers.enabled, 1))
		.orderBy(providers.sortOrder);

	return rows.map(mapRowToProvider);
}

export async function updateProvider(
	id: string,
	input: UpdateProviderInput,
): Promise<Provider | null> {
	const [existing] = await db
		.select()
		.from(providers)
		.where(eq(providers.id, id));

	if (!existing) return null;

	if (input.baseUrl !== undefined) {
		validateBaseUrlProtocol(input.baseUrl);
	}

	const updates: Partial<typeof providers.$inferInsert> = {
		updatedAt: new Date(),
	};

	if (input.displayName !== undefined) updates.displayName = input.displayName;
	if (input.baseUrl !== undefined) updates.baseUrl = input.baseUrl;
	if (input.iconAssetId !== undefined) updates.iconAssetId = input.iconAssetId;
	if (input.processingRegionCode !== undefined) {
		updates.processingRegionCode = normalizeProcessingRegionCode(
			input.processingRegionCode,
		);
	}
	if (input.privacyPolicyUrl !== undefined) {
		updates.privacyPolicyUrl = normalizePrivacyPolicyUrl(
			input.privacyPolicyUrl,
		);
	}
	if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;
	if (input.enabled !== undefined) updates.enabled = input.enabled ? 1 : 0;

	if (input.apiKey !== undefined) {
		const { encrypted, iv } = encryptApiKey(input.apiKey);
		updates.apiKeyEncrypted = encrypted;
		updates.apiKeyIv = iv;
	}

	if (input.rateLimitFallbackEnabled !== undefined) {
		updates.rateLimitFallbackEnabled = input.rateLimitFallbackEnabled ? 1 : 0;
	}
	if (input.rateLimitFallbackBaseUrl !== undefined) {
		updates.rateLimitFallbackBaseUrl = input.rateLimitFallbackBaseUrl;
	}
	if (input.rateLimitFallbackApiKey !== undefined) {
		const trimmed = input.rateLimitFallbackApiKey?.trim();
		if (trimmed) {
			const { encrypted, iv } = encryptApiKey(trimmed);
			updates.rateLimitFallbackApiKeyEncrypted = encrypted;
			updates.rateLimitFallbackApiKeyIv = iv;
		} else {
			updates.rateLimitFallbackApiKeyEncrypted = null;
			updates.rateLimitFallbackApiKeyIv = null;
		}
	}
	if (input.rateLimitFallbackModelName !== undefined) {
		updates.rateLimitFallbackModelName = input.rateLimitFallbackModelName;
	}
	if (input.rateLimitFallbackTimeoutMs !== undefined) {
		updates.rateLimitFallbackTimeoutMs =
			input.rateLimitFallbackTimeoutMs ?? 10000;
	}

	const [updated] = await db
		.update(providers)
		.set(updates)
		.where(eq(providers.id, id))
		.returning();

	return updated ? mapRowToProvider(updated) : null;
}

export async function deleteProvider(id: string): Promise<boolean> {
	const result = await db.delete(providers).where(eq(providers.id, id));

	return result.changes > 0;
}

const FIRE_PASS_KEY_PREFIX = "fpk_";
const FIRE_PASS_MODEL_NAME = "accounts/fireworks/routers/kimi-k2p6-turbo";

export async function validateProviderConnection(
	baseUrl: string,
	apiKey: string,
): Promise<{ valid: boolean; error?: string }> {
	try {
		const url = new URL(baseUrl);
		if (!url.protocol.startsWith("http")) {
			return {
				valid: false,
				error: "Base URL must use HTTP or HTTPS protocol",
			};
		}

		if (
			apiKey.trim().startsWith(FIRE_PASS_KEY_PREFIX) &&
			isFireworksHost(url.hostname)
		) {
			return { valid: true };
		}

		const modelsUrl = buildOpenAICompatibleUrl(baseUrl, "/v1/models");
		const response = await fetch(modelsUrl, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(10000),
		});

		if (response.ok) return { valid: true };

		if (response.status === 401 || response.status === 403) {
			const chatUrl = buildOpenAICompatibleUrl(baseUrl, "/v1/chat/completions");
			const chatResponse = await fetch(chatUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: ".",
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
				}),
				signal: AbortSignal.timeout(10000),
			});

			if (chatResponse.ok) return { valid: true };
			if (chatResponse.status === 401 || chatResponse.status === 403) {
				return { valid: false, error: "Invalid API key" };
			}
		}

		return {
			valid: false,
			error: `Server returned ${response.status}`,
		};
	} catch (error) {
		if (error instanceof Error) {
			if (error.name === "TimeoutError") {
				return { valid: false, error: "Connection timeout" };
			}
			return { valid: false, error: error.message };
		}
		return { valid: false, error: "Unknown error" };
	}
}

function isDeepseekHost(hostname: string): boolean {
	return hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com");
}

function isFireworksHost(hostname: string): boolean {
	return hostname === "api.fireworks.ai" || hostname.endsWith(".fireworks.ai");
}

export async function modelDiscovery(
	baseUrl: string,
	apiKey: string,
): Promise<DiscoveredModel[]> {
	let modelsUrl: string;

	try {
		const url = new URL(baseUrl);

		if (
			apiKey.trim().startsWith(FIRE_PASS_KEY_PREFIX) &&
			isFireworksHost(url.hostname)
		) {
			return [{ id: FIRE_PASS_MODEL_NAME }];
		}

		if (isDeepseekHost(url.hostname)) {
			modelsUrl = `${baseUrl.replace(/\/+$/, "")}/models`;
		} else if (isFireworksHost(url.hostname)) {
			modelsUrl = `${baseUrl.replace(/\/+$/, "")}/inference/v1/models`;
		} else {
			modelsUrl = buildOpenAICompatibleUrl(baseUrl, "/v1/models");
		}

		const response = await fetch(modelsUrl, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(10000),
		});

		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new Error("Invalid API key");
			}
			if (response.status === 404 || response.status === 405) {
				throw new Error(
					"Model discovery endpoint not supported by this provider",
				);
			}
			throw new Error(`Server returned ${response.status}`);
		}

		const payload: unknown = await response.json().catch(() => null);
		const models: unknown[] =
			isRecord(payload) && Array.isArray(payload.data)
				? payload.data
				: isRecord(payload) && Array.isArray(payload.models)
					? payload.models
					: [];

		return models
			.filter(
				(model): model is Record<string, unknown> =>
					isRecord(model) && typeof model.id === "string",
			)
			.map((model): DiscoveredModel => {
				const result: DiscoveredModel = { id: model.id as string };

				const contextLength =
					typeof model.context_length === "number"
						? model.context_length
						: typeof model.max_model_len === "number"
							? model.max_model_len
							: undefined;
				if (contextLength !== undefined) {
					result.contextLength = contextLength;
				}

				if (typeof model.supports_chat === "boolean") {
					result.supportsChat = model.supports_chat;
				}

				if (typeof model.supports_tools === "boolean") {
					result.supportsTools = model.supports_tools;
				}

				return result;
			});
	} catch (error) {
		if (error instanceof Error) {
			if (error.name === "TimeoutError") {
				throw new Error("Model discovery timeout");
			}
			if (
				error.message === "Invalid API key" ||
				error.message.startsWith("Model discovery endpoint") ||
				error.message.startsWith("Server returned")
			) {
				throw error;
			}
			throw new Error(`Model discovery failed: ${error.message}`);
		}
		throw new Error("Model discovery failed: Unknown error");
	}
}

export interface DiscoveredModel {
	id: string;
	contextLength?: number;
	supportsChat?: boolean;
	supportsTools?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export async function seedDefaultProviders(): Promise<void> {
	try {
		const existing = await db
			.select({ id: providers.id })
			.from(providers)
			.limit(1);
		if (existing.length > 0) return;

		const now = new Date();
		const model1Config = config.model1;
		const model2Config = config.model2;

		if (model1Config.baseUrl && model1Config.modelName) {
			const { encrypted, iv } = encryptApiKey(model1Config.apiKey);
			const [provider1] = await db
				.insert(providers)
				.values({
					id: randomUUID(),
					name: "model1",
					displayName: model1Config.displayName,
					baseUrl: model1Config.baseUrl,
					apiKeyEncrypted: encrypted,
					apiKeyIv: iv,
					sortOrder: 0,
					enabled: 1,
					createdAt: now,
					updatedAt: now,
				})
				.returning();

			await db.insert(providerModels).values({
				id: randomUUID(),
				providerId: provider1.id,
				name: model1Config.modelName,
				displayName: model1Config.displayName,
				maxTokens: model1Config.maxTokens ?? null,
				reasoningEffort: model1Config.reasoningEffort ?? null,
				thinkingType: model1Config.thinkingType ?? null,
				enabled: 1,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			});
		}

		const model2Enabled = process.env.MODEL_2_ENABLED !== "false";
		if (model2Enabled && model2Config.baseUrl && model2Config.modelName) {
			const { encrypted: enc2, iv: iv2 } = encryptApiKey(model2Config.apiKey);
			const [provider2] = await db
				.insert(providers)
				.values({
					id: randomUUID(),
					name: "model2",
					displayName: model2Config.displayName,
					baseUrl: model2Config.baseUrl,
					apiKeyEncrypted: enc2,
					apiKeyIv: iv2,
					sortOrder: 1,
					enabled: 1,
					createdAt: now,
					updatedAt: now,
				})
				.returning();

			await db.insert(providerModels).values({
				id: randomUUID(),
				providerId: provider2.id,
				name: model2Config.modelName,
				displayName: model2Config.displayName,
				maxTokens: model2Config.maxTokens ?? null,
				reasoningEffort: model2Config.reasoningEffort ?? null,
				thinkingType: model2Config.thinkingType ?? null,
				enabled: 1,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			});
		}

		console.log("[providers] Seeded default providers from env configuration.");
	} catch (error) {
		console.error("[providers] Failed to seed default providers:", error);
	}
}
