import {
	createCipheriv,
	createDecipheriv,
	pbkdf2Sync,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { eq } from "drizzle-orm";
import {
	createModelCapabilitySet,
	MODEL_CAPABILITY_KEYS,
	type ModelCapabilityKey,
	type ModelCapabilitySource,
	type ModelCapabilityState,
	type ModelCapabilityStatus,
	type ModelCapabilitySet,
} from "$lib/model-capabilities";
import {
	deriveMaxMessageLengthFromContextTokens,
	getKnownModelLimitPreset,
} from "$lib/model-limit-presets";
import { db } from "../db";
import { inferenceProviders } from "../db/schema";
import { config } from "../env";
import { buildOpenAICompatibleUrl } from "./openai-compatible-url";

export type ProviderReasoningEffort =
	| "low"
	| "medium"
	| "high"
	| "max"
	| "xhigh";
export type ProviderThinkingType = "enabled" | "disabled";
const FIRE_PASS_KEY_PREFIX = "fpk_";
const FIRE_PASS_MODEL_NAME = "accounts/fireworks/routers/kimi-k2p6-turbo";
const DEFAULT_RATE_LIMIT_FALLBACK_TIMEOUT_MS = 10000;

export interface InferenceProvider {
	id: string;
	name: string;
	displayName: string;
	baseUrl: string;
	modelName: string;
	reasoningEffort: ProviderReasoningEffort | null;
	thinkingType: ProviderThinkingType | null;
	enabled: boolean;
	sortOrder: number;
	maxModelContext: number | null;
	compactionUiThreshold: number | null;
	targetConstructedContext: number | null;
	maxMessageLength: number | null;
	maxTokens: number | null;
	iconAssetId: string | null;
	rateLimitFallbackEnabled: boolean;
	rateLimitFallbackBaseUrl: string | null;
	rateLimitFallbackModelName: string | null;
	rateLimitFallbackTimeoutMs: number;
	capabilities: ModelCapabilitySet;
	createdAt: Date;
	updatedAt: Date;
}

export interface InferenceProviderWithSecrets extends InferenceProvider {
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
	modelName: string;
	reasoningEffort?: ProviderReasoningEffort | null;
	thinkingType?: ProviderThinkingType | null;
	enabled?: boolean;
	sortOrder?: number;
	maxModelContext?: number | null;
	compactionUiThreshold?: number | null;
	targetConstructedContext?: number | null;
	maxMessageLength?: number | null;
	maxTokens?: number | null;
	iconAssetId?: string | null;
	rateLimitFallbackEnabled?: boolean;
	rateLimitFallbackBaseUrl?: string | null;
	rateLimitFallbackApiKey?: string | null;
	rateLimitFallbackModelName?: string | null;
	rateLimitFallbackTimeoutMs?: number | null;
	capabilities?: ModelCapabilitySet | null;
}

export interface UpdateProviderInput {
	displayName?: string;
	baseUrl?: string;
	apiKey?: string;
	modelName?: string;
	reasoningEffort?: ProviderReasoningEffort | null;
	thinkingType?: ProviderThinkingType | null;
	enabled?: boolean;
	sortOrder?: number;
	maxModelContext?: number | null;
	compactionUiThreshold?: number | null;
	targetConstructedContext?: number | null;
	maxMessageLength?: number | null;
	maxTokens?: number | null;
	iconAssetId?: string | null;
	rateLimitFallbackEnabled?: boolean;
	rateLimitFallbackBaseUrl?: string | null;
	rateLimitFallbackApiKey?: string | null;
	rateLimitFallbackModelName?: string | null;
	rateLimitFallbackTimeoutMs?: number | null;
	capabilities?: ModelCapabilitySet | null;
}

export type ProviderLimitInput = {
	maxModelContext?: unknown;
	compactionUiThreshold?: unknown;
	targetConstructedContext?: unknown;
	maxMessageLength?: unknown;
	maxTokens?: unknown;
};

export type NormalizedProviderLimits = {
	maxModelContext?: number | null;
	compactionUiThreshold?: number | null;
	targetConstructedContext?: number | null;
	maxMessageLength?: number | null;
	maxTokens?: number | null;
};

export type ProviderRateLimitFallbackInput = {
	rateLimitFallbackEnabled?: unknown;
	rateLimitFallbackBaseUrl?: unknown;
	rateLimitFallbackApiKey?: unknown;
	rateLimitFallbackModelName?: unknown;
	rateLimitFallbackTimeoutMs?: unknown;
};

export type NormalizedProviderRateLimitFallback = {
	rateLimitFallbackEnabled?: boolean;
	rateLimitFallbackBaseUrl?: string | null;
	rateLimitFallbackApiKey?: string | null;
	rateLimitFallbackModelName?: string | null;
	rateLimitFallbackTimeoutMs?: number | null;
};

export interface ProviderCapabilityProbeResult {
	valid: boolean;
	error?: string;
	modelFound: boolean | null;
	capabilities: ModelCapabilitySet;
}

export interface ProviderConnectionValidationResult {
	valid: boolean;
	error?: string;
	capabilities?: ModelCapabilitySet;
}

type ProviderCapabilityHintInput = {
	baseUrl: string;
	modelName: string;
	reasoningEffort?: ProviderReasoningEffort | null;
	thinkingType?: ProviderThinkingType | null;
};

export function parseProviderLimitOverrides(input: ProviderLimitInput):
	| {
			ok: true;
			value: NormalizedProviderLimits;
	  }
	| {
			ok: false;
			error: string;
	  } {
	const normalized: NormalizedProviderLimits = {};

	const parseOptionalNumber = (
		key: keyof ProviderLimitInput,
		min: number,
		label: string,
	):
		| { ok: true; value: number | null | undefined }
		| { ok: false; error: string } => {
		const value = input[key];
		if (value === undefined) return { ok: true, value: undefined };
		if (value === null || value === "") return { ok: true, value: null };
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			!Number.isInteger(value)
		) {
			return { ok: false, error: `${label} must be an integer` };
		}
		if (value < min) {
			return { ok: false, error: `${label} must be at least ${min}` };
		}
		return { ok: true, value };
	};

	const maxModelContext = parseOptionalNumber(
		"maxModelContext",
		1000,
		"Max model context",
	);
	if (!maxModelContext.ok) return maxModelContext;
	if (maxModelContext.value !== undefined)
		normalized.maxModelContext = maxModelContext.value;

	const compactionUiThreshold = parseOptionalNumber(
		"compactionUiThreshold",
		1000,
		"Compaction UI threshold",
	);
	if (!compactionUiThreshold.ok) return compactionUiThreshold;
	if (compactionUiThreshold.value !== undefined) {
		normalized.compactionUiThreshold = compactionUiThreshold.value;
	}

	const targetConstructedContext = parseOptionalNumber(
		"targetConstructedContext",
		1000,
		"Target constructed context",
	);
	if (!targetConstructedContext.ok) return targetConstructedContext;
	if (targetConstructedContext.value !== undefined) {
		normalized.targetConstructedContext = targetConstructedContext.value;
	}

	const maxMessageLength = parseOptionalNumber(
		"maxMessageLength",
		1,
		"Max message length",
	);
	if (!maxMessageLength.ok) return maxMessageLength;
	if (maxMessageLength.value !== undefined)
		normalized.maxMessageLength = maxMessageLength.value;

	const maxTokens = parseOptionalNumber("maxTokens", 1, "Max tokens");
	if (!maxTokens.ok) return maxTokens;
	if (maxTokens.value !== undefined) normalized.maxTokens = maxTokens.value;

	return { ok: true, value: normalized };
}

export function parseProviderRateLimitFallback(
	input: ProviderRateLimitFallbackInput,
):
	| {
			ok: true;
			value: NormalizedProviderRateLimitFallback;
	  }
	| {
			ok: false;
			error: string;
	  } {
	const normalized: NormalizedProviderRateLimitFallback = {};

	if (input.rateLimitFallbackEnabled !== undefined) {
		if (typeof input.rateLimitFallbackEnabled !== "boolean") {
			return {
				ok: false,
				error: "Rate-limit fallback enabled must be a boolean",
			};
		}
		normalized.rateLimitFallbackEnabled = input.rateLimitFallbackEnabled;
	}

	const parseOptionalString = (
		value: unknown,
		label: string,
	):
		| { ok: true; value: string | null | undefined }
		| { ok: false; error: string } => {
		if (value === undefined) return { ok: true, value: undefined };
		if (value === null || value === "") return { ok: true, value: null };
		if (typeof value !== "string")
			return { ok: false, error: `${label} must be a string` };
		return { ok: true, value: value.trim() || null };
	};

	const baseUrl = parseOptionalString(
		input.rateLimitFallbackBaseUrl,
		"Rate-limit fallback base URL",
	);
	if (!baseUrl.ok) return baseUrl;
	if (baseUrl.value !== undefined)
		normalized.rateLimitFallbackBaseUrl = baseUrl.value;

	const apiKey = parseOptionalString(
		input.rateLimitFallbackApiKey,
		"Rate-limit fallback API key",
	);
	if (!apiKey.ok) return apiKey;
	if (apiKey.value !== undefined)
		normalized.rateLimitFallbackApiKey = apiKey.value;

	const modelName = parseOptionalString(
		input.rateLimitFallbackModelName,
		"Rate-limit fallback model name",
	);
	if (!modelName.ok) return modelName;
	if (modelName.value !== undefined)
		normalized.rateLimitFallbackModelName = modelName.value;

	const timeout = input.rateLimitFallbackTimeoutMs;
	if (timeout !== undefined) {
		if (timeout === null || timeout === "") {
			normalized.rateLimitFallbackTimeoutMs = null;
		} else if (
			typeof timeout !== "number" ||
			!Number.isFinite(timeout) ||
			!Number.isInteger(timeout)
		) {
			return {
				ok: false,
				error: "Rate-limit fallback timeout must be an integer",
			};
		} else if (timeout < 1000) {
			return {
				ok: false,
				error: "Rate-limit fallback timeout must be at least 1000",
			};
		} else {
			normalized.rateLimitFallbackTimeoutMs = timeout;
		}
	}

	return { ok: true, value: normalized };
}

export function validateProviderRateLimitFallbackConfiguration(input: {
	enabled: boolean;
	baseUrl: string | null | undefined;
	modelName: string | null | undefined;
	apiKeyAvailable: boolean;
	timeoutMs?: number | null;
}): string | null {
	if (!input.enabled) return null;
	if (!input.baseUrl) return "Rate-limit fallback base URL is required";
	if (!input.apiKeyAvailable) return "Rate-limit fallback API key is required";
	if (!input.modelName) return "Rate-limit fallback model name is required";
	if (
		input.timeoutMs !== undefined &&
		input.timeoutMs !== null &&
		(!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000)
	) {
		return "Rate-limit fallback timeout must be at least 1000";
	}
	return null;
}

export function validateProviderLimitOrdering(input: {
	maxModelContext: number | null;
	compactionUiThreshold: number | null;
	targetConstructedContext: number | null;
	maxTokens?: number | null;
}): string | null {
	const {
		maxModelContext,
		compactionUiThreshold,
		targetConstructedContext,
		maxTokens = null,
	} = input;
	if (
		maxModelContext !== null &&
		compactionUiThreshold !== null &&
		compactionUiThreshold >= maxModelContext
	) {
		return "Compaction UI threshold must be less than max model context";
	}
	if (
		maxModelContext !== null &&
		targetConstructedContext !== null &&
		targetConstructedContext >= maxModelContext
	) {
		return "Target constructed context must be less than max model context";
	}
	if (
		maxModelContext !== null &&
		maxTokens !== null &&
		maxTokens >= maxModelContext
	) {
		return "Max tokens must be less than max model context";
	}
	return null;
}

export function validateProviderLimitConfiguration(input: {
	enabled?: boolean;
	maxModelContext: number | null;
	compactionUiThreshold: number | null;
	targetConstructedContext: number | null;
	maxTokens?: number | null;
}): string | null {
	if (input.enabled !== false && input.maxModelContext === null) {
		return "Max model context is required";
	}

	return validateProviderLimitOrdering(input);
}

export function resolveProviderLimitDefaults(input: {
	modelName: string;
	maxModelContext: number | null;
	maxMessageLength: number | null;
}): {
	maxModelContext: number | null;
	maxMessageLength: number | null;
} {
	const preset = getKnownModelLimitPreset(input.modelName);
	const maxModelContext =
		input.maxModelContext ?? preset?.maxModelContext ?? null;
	const maxMessageLength =
		input.maxMessageLength ??
		preset?.maxMessageLength ??
		(maxModelContext != null
			? deriveMaxMessageLengthFromContextTokens(maxModelContext)
			: null);

	return { maxModelContext, maxMessageLength };
}

export function normalizeReasoningEffort(
	value: unknown,
): ProviderReasoningEffort | null {
	return value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "max" ||
		value === "xhigh"
		? value
		: null;
}

export function normalizeThinkingType(
	value: unknown,
): ProviderThinkingType | null {
	return value === "enabled" || value === "disabled" ? value : null;
}

function deriveEncryptionKey(secret: string): Buffer {
	return pbkdf2Sync(secret, "alfaai-inference-providers", 100000, 32, "sha256");
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

export async function createProvider(
	input: CreateProviderInput,
): Promise<InferenceProvider> {
	const { encrypted, iv } = encryptApiKey(input.apiKey);
	const fallbackApiKey =
		input.rateLimitFallbackApiKey?.trim()
			? encryptApiKey(input.rateLimitFallbackApiKey)
			: null;
	const now = new Date();

	const [provider] = await db
		.insert(inferenceProviders)
		.values({
			id: randomUUID(),
			name: input.name,
			displayName: input.displayName,
			baseUrl: input.baseUrl,
			apiKeyEncrypted: encrypted,
			apiKeyIv: iv,
			modelName: input.modelName,
			reasoningEffort: input.reasoningEffort ?? null,
			thinkingType: input.thinkingType ?? null,
			enabled: input.enabled ?? true,
			sortOrder: input.sortOrder ?? 0,
			maxModelContext: input.maxModelContext ?? null,
			compactionUiThreshold: input.compactionUiThreshold ?? null,
			targetConstructedContext: input.targetConstructedContext ?? null,
			maxMessageLength: input.maxMessageLength ?? null,
			maxTokens: input.maxTokens ?? null,
			iconAssetId: input.iconAssetId ?? null,
			rateLimitFallbackEnabled: input.rateLimitFallbackEnabled ?? false,
			rateLimitFallbackBaseUrl: input.rateLimitFallbackBaseUrl ?? null,
			rateLimitFallbackApiKeyEncrypted: fallbackApiKey?.encrypted ?? null,
			rateLimitFallbackApiKeyIv: fallbackApiKey?.iv ?? null,
			rateLimitFallbackModelName: input.rateLimitFallbackModelName ?? null,
			rateLimitFallbackTimeoutMs:
				input.rateLimitFallbackTimeoutMs ??
				DEFAULT_RATE_LIMIT_FALLBACK_TIMEOUT_MS,
			capabilitiesJson: serializeModelCapabilities(input.capabilities),
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return mapRowToProvider(provider);
}

export async function getProvider(
	id: string,
): Promise<InferenceProvider | null> {
	const [provider] = await db
		.select()
		.from(inferenceProviders)
		.where(eq(inferenceProviders.id, id));

	return provider ? mapRowToProvider(provider) : null;
}

export async function getProviderWithSecrets(
	id: string,
): Promise<InferenceProviderWithSecrets | null> {
	const [provider] = await db
		.select()
		.from(inferenceProviders)
		.where(eq(inferenceProviders.id, id));

	return provider ? mapRowToProviderWithSecrets(provider) : null;
}

export async function getProviderByName(
	name: string,
): Promise<InferenceProvider | null> {
	const [provider] = await db
		.select()
		.from(inferenceProviders)
		.where(eq(inferenceProviders.name, name));

	return provider ? mapRowToProvider(provider) : null;
}

export async function listProviders(): Promise<InferenceProvider[]> {
	const providers = await db
		.select()
		.from(inferenceProviders)
		.orderBy(inferenceProviders.sortOrder);

	return providers.map(mapRowToProvider);
}

export async function listEnabledProviders(): Promise<InferenceProvider[]> {
	const providers = await db
		.select()
		.from(inferenceProviders)
		.where(eq(inferenceProviders.enabled, true))
		.orderBy(inferenceProviders.sortOrder);

	return providers.map(mapRowToProvider);
}

export async function updateProvider(
	id: string,
	input: UpdateProviderInput,
): Promise<InferenceProvider | null> {
	const existing = await db
		.select()
		.from(inferenceProviders)
		.where(eq(inferenceProviders.id, id));

	if (!existing[0]) {
		return null;
	}

	const updates: Partial<typeof inferenceProviders.$inferInsert> = {
		updatedAt: new Date(),
	};

	if (input.displayName !== undefined) {
		updates.displayName = input.displayName;
	}
	if (input.baseUrl !== undefined) {
		updates.baseUrl = input.baseUrl;
	}
	if (input.modelName !== undefined) {
		updates.modelName = input.modelName;
	}
	if (input.reasoningEffort !== undefined) {
		updates.reasoningEffort = input.reasoningEffort;
	}
	if (input.thinkingType !== undefined) {
		updates.thinkingType = input.thinkingType;
	}
	if (input.enabled !== undefined) {
		updates.enabled = input.enabled;
	}
	if (input.sortOrder !== undefined) {
		updates.sortOrder = input.sortOrder;
	}
	if (input.apiKey !== undefined) {
		const { encrypted, iv } = encryptApiKey(input.apiKey);
		updates.apiKeyEncrypted = encrypted;
		updates.apiKeyIv = iv;
	}
	if (input.maxModelContext !== undefined) {
		updates.maxModelContext = input.maxModelContext;
	}
	if (input.compactionUiThreshold !== undefined) {
		updates.compactionUiThreshold = input.compactionUiThreshold;
	}
	if (input.targetConstructedContext !== undefined) {
		updates.targetConstructedContext = input.targetConstructedContext;
	}
	if (input.maxMessageLength !== undefined) {
		updates.maxMessageLength = input.maxMessageLength;
	}
	if (input.maxTokens !== undefined) {
		updates.maxTokens = input.maxTokens;
	}
	if (input.iconAssetId !== undefined) {
		updates.iconAssetId = input.iconAssetId;
	}
	if (input.rateLimitFallbackEnabled !== undefined) {
		updates.rateLimitFallbackEnabled = input.rateLimitFallbackEnabled;
	}
	if (input.rateLimitFallbackBaseUrl !== undefined) {
		updates.rateLimitFallbackBaseUrl = input.rateLimitFallbackBaseUrl;
	}
	if (input.rateLimitFallbackApiKey !== undefined) {
		if (input.rateLimitFallbackApiKey?.trim()) {
			const { encrypted, iv } = encryptApiKey(input.rateLimitFallbackApiKey);
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
			input.rateLimitFallbackTimeoutMs ??
			DEFAULT_RATE_LIMIT_FALLBACK_TIMEOUT_MS;
	}
	if (input.capabilities !== undefined) {
		updates.capabilitiesJson = serializeModelCapabilities(input.capabilities);
	}

	const [updated] = await db
		.update(inferenceProviders)
		.set(updates)
		.where(eq(inferenceProviders.id, id))
		.returning();

	return updated ? mapRowToProvider(updated) : null;
}

export async function deleteProvider(id: string): Promise<boolean> {
	const result = await db
		.delete(inferenceProviders)
		.where(eq(inferenceProviders.id, id));

	return result.changes > 0;
}

export async function validateProviderConnection(
	baseUrl: string,
	apiKey: string,
	options: {
		modelName?: string | null;
		reasoningEffort?: ProviderReasoningEffort | null;
		thinkingType?: ProviderThinkingType | null;
	} = {},
): Promise<ProviderConnectionValidationResult> {
	try {
		const url = new URL(baseUrl);
		if (!url.protocol.startsWith("http")) {
			return {
				valid: false,
				error: "Base URL must use HTTP or HTTPS protocol",
			};
		}

		const isFirePassKey = apiKey.trim().startsWith(FIRE_PASS_KEY_PREFIX);
		if (isFirePassKey && isFireworksHost(url)) {
			const modelName = options.modelName?.trim().toLowerCase() ?? "";
			if (modelName !== FIRE_PASS_MODEL_NAME) {
				return {
					valid: false,
					error: `Fire Pass keys only work with ${FIRE_PASS_MODEL_NAME}`,
				};
			}

			return {
				valid: true,
				capabilities: knownFirePassKimiCapabilities(options),
			};
		}

		const probe = await probeProviderModelCapabilities(
			baseUrl,
			apiKey,
			options,
		);
		const capabilities = mergeKnownModelCapabilities(
			probe.capabilities,
			knownProviderCapabilities({
				baseUrl,
				modelName: options.modelName ?? "",
				reasoningEffort: options.reasoningEffort ?? null,
				thinkingType: options.thinkingType ?? null,
			}),
		);
		return probe.valid
			? { valid: true, capabilities }
			: { valid: false, error: probe.error, capabilities };
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

export async function probeProviderModelCapabilities(
	baseUrl: string,
	apiKey: string,
	options: { modelName?: string | null } = {},
): Promise<ProviderCapabilityProbeResult> {
	try {
		const url = new URL(baseUrl);
		if (!url.protocol.startsWith("http")) {
			return {
				valid: false,
				error: "Base URL must use HTTP or HTTPS protocol",
				modelFound: null,
				capabilities: createModelCapabilitySet({
					modelsEndpoint: {
						state: "unknown",
						source: "models_endpoint",
						detail: "Base URL could not be probed",
					},
				}),
			};
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

		if (!response.ok) {
			const unsupported = response.status === 404 || response.status === 405;
			return {
				valid: false,
				error:
					response.status === 401 || response.status === 403
						? "Invalid API key"
						: `Server returned ${response.status}`,
				modelFound: null,
				capabilities: createModelCapabilitySet({
					modelsEndpoint: {
						state: unsupported ? "not_detected" : "unknown",
						source: "models_endpoint",
						detail: unsupported
							? "/models validation endpoint is unavailable"
							: `Server returned ${response.status}`,
					},
				}),
			};
		}

		const payload: unknown = await response.json().catch(() => null);
		const modelName = options.modelName?.trim();
		const models: unknown[] =
			isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
		const modelFound = modelName
			? models.some(
					(model) =>
						isRecord(model) &&
						typeof model.id === "string" &&
						model.id === modelName,
				)
			: null;

		return {
			valid: true,
			modelFound,
			capabilities: createModelCapabilitySet({
				modelsEndpoint: {
					state: "detected",
					source: "models_endpoint",
					detail:
						modelFound === false
							? "The configured model was not present in the /models response"
							: "/models validation endpoint responded successfully",
				},
			}),
		};
	} catch (error) {
		const message =
			error instanceof Error
				? error.name === "TimeoutError"
					? "Connection timeout"
					: error.message
				: "Unknown error";

		return {
			valid: false,
			error: message,
			modelFound: null,
			capabilities: createModelCapabilitySet({
				modelsEndpoint: {
					state: "unknown",
					source: "models_endpoint",
					detail: message,
				},
			}),
		};
	}
}

function isFireworksHost(url: URL): boolean {
	return (
		url.hostname === "fireworks.ai" || url.hostname.endsWith(".fireworks.ai")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function mapRowToProvider(
	row: typeof inferenceProviders.$inferSelect,
): InferenceProvider {
	const storedCapabilities = parseStoredModelCapabilities(row.capabilitiesJson);
	return {
		id: row.id,
		name: row.name,
		displayName: row.displayName,
		baseUrl: row.baseUrl,
		modelName: row.modelName,
		reasoningEffort: normalizeReasoningEffort(row.reasoningEffort),
		thinkingType: normalizeThinkingType(row.thinkingType),
		enabled: row.enabled ?? true,
		sortOrder: row.sortOrder ?? 0,
		maxModelContext: row.maxModelContext ?? null,
		compactionUiThreshold: row.compactionUiThreshold ?? null,
		targetConstructedContext: row.targetConstructedContext ?? null,
		maxMessageLength: row.maxMessageLength ?? null,
		maxTokens: row.maxTokens ?? null,
		iconAssetId: row.iconAssetId ?? null,
		rateLimitFallbackEnabled: row.rateLimitFallbackEnabled ?? false,
		rateLimitFallbackBaseUrl: row.rateLimitFallbackBaseUrl ?? null,
		rateLimitFallbackModelName: row.rateLimitFallbackModelName ?? null,
		rateLimitFallbackTimeoutMs:
			row.rateLimitFallbackTimeoutMs ?? DEFAULT_RATE_LIMIT_FALLBACK_TIMEOUT_MS,
		capabilities: mergeKnownModelCapabilities(
			storedCapabilities,
			knownProviderCapabilities(row),
		),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function mapRowToProviderWithSecrets(
	row: typeof inferenceProviders.$inferSelect,
): InferenceProviderWithSecrets {
	return {
		...mapRowToProvider(row),
		apiKeyEncrypted: row.apiKeyEncrypted,
		apiKeyIv: row.apiKeyIv,
		rateLimitFallbackApiKeyEncrypted:
			row.rateLimitFallbackApiKeyEncrypted ?? null,
		rateLimitFallbackApiKeyIv: row.rateLimitFallbackApiKeyIv ?? null,
	};
}

function serializeModelCapabilities(
	capabilities: ModelCapabilitySet | null | undefined,
): string {
	return JSON.stringify(capabilities ?? createModelCapabilitySet());
}

function parseStoredModelCapabilities(value: string | null): ModelCapabilitySet {
	if (!value) return createModelCapabilitySet();
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed)) return createModelCapabilitySet();

		return createModelCapabilitySet(
			Object.fromEntries(
				MODEL_CAPABILITY_KEYS.map((key) => [
					key,
					sanitizeStoredCapability(key, parsed[key]),
				]),
			),
		);
	} catch {
		return createModelCapabilitySet();
	}
}

function sanitizeStoredCapability(
	key: ModelCapabilityKey,
	value: unknown,
): Partial<ModelCapabilityStatus> {
	if (!isRecord(value)) return {};
	const state = isModelCapabilityState(value.state) ? value.state : undefined;
	const source = isModelCapabilitySource(value.source)
		? value.source
		: undefined;
	const supported =
		typeof value.supported === "boolean" || value.supported === null
			? value.supported
			: undefined;
	const detail = typeof value.detail === "string" ? value.detail : undefined;
	const checkedAt =
		typeof value.checkedAt === "string" ? value.checkedAt : undefined;

	return {
		key,
		...(state ? { state } : {}),
		...(source ? { source } : {}),
		...(supported !== undefined ? { supported } : {}),
		...(detail ? { detail } : {}),
		...(checkedAt ? { checkedAt } : {}),
	};
}

function isModelCapabilityState(
	value: unknown,
): value is ModelCapabilityState {
	return (
		value === "detected" ||
		value === "not_detected" ||
		value === "unknown" ||
		value === "manual_override"
	);
}

function isModelCapabilitySource(
	value: unknown,
): value is ModelCapabilitySource {
	return (
		value === "models_endpoint" ||
		value === "probe" ||
		value === "manual_override"
	);
}

function knownProviderCapabilities(
	row: ProviderCapabilityHintInput,
): ModelCapabilitySet | null {
	try {
		const url = new URL(row.baseUrl);
		if (
			isFireworksHost(url) &&
			row.modelName.trim().toLowerCase() === FIRE_PASS_MODEL_NAME
		) {
			return knownFirePassKimiCapabilities(row);
		}
		if (isFireworksHost(url)) {
			return knownFireworksOpenAICompatibleCapabilities(row);
		}
		return null;
	} catch {
		return null;
	}
}

function mergeKnownModelCapabilities(
	base: ModelCapabilitySet,
	known: ModelCapabilitySet | null,
): ModelCapabilitySet {
	if (!known) return base;
	return createModelCapabilitySet(
		Object.fromEntries(
			MODEL_CAPABILITY_KEYS.map((key) => [
				key,
				base[key].state === "unknown" ? known[key] : base[key],
			]),
		),
	);
}

function configuredReasoningCapability(
	input: Pick<
		ProviderCapabilityHintInput,
		"reasoningEffort" | "thinkingType"
	> = {},
): Partial<ModelCapabilityStatus> {
	if (input.reasoningEffort || input.thinkingType) {
		const controls = [
			input.reasoningEffort ? `reasoning_effort=${input.reasoningEffort}` : "",
			input.thinkingType
				? `extra_body.thinking.type=${input.thinkingType}`
				: "",
		].filter(Boolean);
		return {
			state: "detected",
			source: "manual_override",
			detail: `Admin configured ${controls.join(" and ")}; AlfyAI will send reasoning controls for this provider.`,
		};
	}

	return {
		state: "unknown",
		source: "probe",
		detail:
			"Reasoning control support is unverified. Configure reasoning_effort or extra_body.thinking.type only for providers/models known to accept those options.",
	};
}

function unknownFileMessagePartsCapability(): Partial<ModelCapabilityStatus> {
	return {
		state: "unknown",
		source: "probe",
		detail:
			"Unverified model message input file-part support; this is not generated file production, which is handled by AlfyAI's produce_file tool.",
	};
}

function unknownImageMessagePartsCapability(): Partial<ModelCapabilityStatus> {
	return {
		state: "unknown",
		source: "probe",
		detail:
			"Unverified model message input image-part support; this is not image search, which is handled by AlfyAI's research/image tools.",
	};
}

function knownFireworksOpenAICompatibleCapabilities(
	input: Pick<
		ProviderCapabilityHintInput,
		"reasoningEffort" | "thinkingType"
	> = {},
): ModelCapabilitySet {
	return createModelCapabilitySet({
		chat: {
			state: "detected",
			source: "probe",
			detail: "Fireworks documents OpenAI-compatible chat completions for text models.",
		},
		streaming: {
			state: "detected",
			source: "probe",
			detail: "Fireworks documents streaming chat/completion responses.",
		},
		tools: {
			state: "detected",
			source: "probe",
			detail: "Fireworks documents OpenAI-compatible tool calling on chat completions.",
		},
		structuredOutput: {
			state: "detected",
			source: "probe",
			detail: "Fireworks documents response_format JSON schema structured outputs.",
		},
		usageReporting: {
			state: "detected",
			source: "probe",
			detail: "Fireworks documents token usage metrics for non-streaming and streaming responses.",
		},
		reasoningControls: configuredReasoningCapability(input),
		fileMessageParts: unknownFileMessagePartsCapability(),
		imageMessageParts: unknownImageMessagePartsCapability(),
	});
}

function knownFirePassKimiCapabilities(
	input: Pick<
		ProviderCapabilityHintInput,
		"reasoningEffort" | "thinkingType"
	> = {},
): ModelCapabilitySet {
	return createModelCapabilitySet({
		...knownFireworksOpenAICompatibleCapabilities(input),
		chat: {
			state: "detected",
			source: "probe",
			detail: "Fire Pass Kimi chat completion compatibility is supported for this scoped model.",
		},
		streaming: {
			state: "detected",
			source: "probe",
			detail: "Fire Pass Kimi streaming compatibility is supported for this scoped model.",
		},
		tools: {
			state: "detected",
			source: "probe",
			detail: "Fire Pass Kimi tool-call compatibility is supported for this scoped model.",
		},
		structuredOutput: {
			state: "detected",
			source: "probe",
			detail: "Fire Pass Kimi structured JSON compatibility is supported for this scoped model.",
		},
		usageReporting: {
			state: "detected",
			source: "probe",
			detail: "Fire Pass Kimi usage reporting follows Fireworks streaming and non-streaming usage support.",
		},
		modelsEndpoint: {
			state: "not_detected",
			source: "models_endpoint",
			detail: "Fire Pass keys are scoped to the configured Kimi router and do not require /models discovery.",
		},
	});
}
