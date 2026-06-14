import { APICallError, generateText, Output } from "ai";
import { getConfig } from "$lib/server/config-store";
import { createOpenAICompatibleProviderForNormalChatModelRun } from "$lib/server/services/normal-chat-model/openai-compatible-provider";

/**
 * System prompt for batch classification of persona memory facts.
 * Distinguishes PERSONAL facts (user preferences, projects, life) from
 * FOREIGN facts (textbook definitions, generic reference docs, code examples).
 */
const MEMORY_BATCH_CLASSIFIER_SYSTEM_PROMPT =
	"You are a classifier that distinguishes PERSONAL facts about the user from FOREIGN/generic reference material.\n\n" +
	"PERSONAL facts describe the user's preferences, projects, life, or identity. Examples:\n" +
	'- "I love React" (personal preference)\n' +
	'- "My project uses Vite" (user\'s project context)\n' +
	'- "I prefer TypeScript over JavaScript" (personal preference)\n' +
	'- "I live in Budapest" (personal fact)\n' +
	'- "I need this done by Friday" (personal constraint)\n\n' +
	"FOREIGN facts are generic knowledge, textbook definitions, API docs, or code examples that don't reveal anything specific about the user. Examples:\n" +
	'- "React is a JavaScript library for building UIs" (generic definition)\n' +
	'- "Vite is a build tool created by Evan You" (generic fact)\n' +
	'- "TypeScript adds static types to JavaScript" (language feature description)\n' +
	'- "PDF file contains API documentation for the payment gateway" (reference doc)\n' +
	'- "function calculateTotal() { return a + b; }" (code example without user context)\n\n' +
	"Edge cases:\n" +
	'- Facts mentioning "I" or "my" are usually PERSONAL, but if they\'re just quoting generic text (e.g., "The docs say I should use..."), classify as FOREIGN.\n' +
	"- Code snippets without user-specific context are FOREIGN.\n" +
	"- API documentation descriptions are FOREIGN.\n\n" +
	'Return strict JSON only: an array of objects with fields: id (string), status ("PERSONAL" or "FOREIGN"), confidence (number 0-100). ' +
	"Confidence reflects how certain you are: 90-100 for clear cases, 60-80 for ambiguous cases, below 60 for very uncertain.";

/** Input type for a single memory fact to classify */
export type MemoryFactInput = {
	/** Unique identifier for this fact */
	id: string;
	/** The memory content to classify */
	content: string;
};

/** Output type for a single classification result */
export type MemoryClassificationResult = {
	/** Same id as the input fact */
	id: string;
	/** Classification status: PERSONAL or FOREIGN */
	status: "PERSONAL" | "FOREIGN";
	/** Confidence score 0-100 */
	confidence: number;
};

/**
 * Batch classifier for persona memory facts.
 * Classifies up to 20 facts at once as PERSONAL (user-specific) or FOREIGN (generic reference).
 *
 * @param facts - Array of memory facts with id and content (max 20 items)
 * @returns Array of classification results, or null if the classifier is unavailable
 * @throws Error if the model request fails (caller should handle and default to PERSONAL)
 */
export async function classifyMemoryBatch(
	facts: MemoryFactInput[],
): Promise<MemoryClassificationResult[] | null> {
	if (!canUseContextSummarizer()) {
		return null;
	}

	// Enforce batch size limit
	const batch = facts.slice(0, 20);
	if (batch.length === 0) {
		return [];
	}

	type ClassifierResponse = {
		classifications?: Array<{
			id?: string;
			status?: string;
			confidence?: number;
		}>;
	};

	const response = await requestStructuredControlModel<ClassifierResponse>({
		system: MEMORY_BATCH_CLASSIFIER_SYSTEM_PROMPT,
		user: JSON.stringify({ facts: batch }, null, 2),
		maxTokens: 800,
		temperature: 0.0,
	});

	if (!response?.classifications || !Array.isArray(response.classifications)) {
		// Fallback: treat all as PERSONAL (safer than losing real memories)
		return batch.map((fact) => ({
			id: fact.id,
			status: "PERSONAL",
			confidence: 50,
		}));
	}

	// Map results back to input ids, ensuring all inputs have an output
	const resultMap = new Map<string, MemoryClassificationResult>();

	for (const item of response.classifications) {
		if (typeof item.id === "string" && typeof item.status === "string") {
			const status =
				item.status.toUpperCase() === "FOREIGN" ? "FOREIGN" : "PERSONAL";
			const confidence =
				typeof item.confidence === "number"
					? Math.max(0, Math.min(100, Math.round(item.confidence)))
					: 70;
			resultMap.set(item.id, { id: item.id, status, confidence });
		}
	}

	// Ensure every input has a result (default to PERSONAL if missing)
	return batch.map((fact) => {
		const result = resultMap.get(fact.id);
		if (result) return result;
		// Missing classification - default to PERSONAL
		return {
			id: fact.id,
			status: "PERSONAL",
			confidence: 50,
		};
	});
}

export function canUseContextSummarizer(): boolean {
	const config = getConfig();
	return Boolean(
		config.contextSummarizerUrl?.includes("://") &&
			config.contextSummarizerModel,
	);
}

export function parseJsonFromModel(
	content: string,
): Record<string, unknown> | null {
	const trimmed = content.trim();
	const withoutFence = trimmed
		.replace(/^```json\s*/i, "")
		.replace(/^```\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();

	try {
		const parsed = JSON.parse(withoutFence) as Record<string, unknown>;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function createContextSummarizerProvider(
	config: ReturnType<typeof getConfig>,
	resolvedModelName: string,
	overrideProvider?: { baseUrl: string; apiKey: string },
) {
	const apiKey =
		overrideProvider?.apiKey || config.contextSummarizerApiKey || undefined;
	return createOpenAICompatibleProviderForNormalChatModelRun({
		provider: {
			name: "context-summarizer",
			displayName: "Context Summarizer",
			baseUrl: overrideProvider?.baseUrl ?? config.contextSummarizerUrl,
			modelName: resolvedModelName,
			apiKey,
		},
		includeUsage: false,
		normalizeStreaming: false,
	});
}

/**
 * Resolves the actual model name and optional provider override
 * for the context summarizer. Handles `provider:` prefixed model IDs
 * by looking up provider credentials and model mappings.
 */
async function resolveContextSummarizerModelAndProvider(
	config: ReturnType<typeof getConfig>,
): Promise<{
	resolvedModelName: string;
	overrideProvider?: { baseUrl: string; apiKey: string };
}> {
	let resolvedModelName = config.contextSummarizerModel;
	let overrideProvider: { baseUrl: string; apiKey: string } | undefined;

	if (config.contextSummarizerModel.startsWith("provider:")) {
		const parts = config.contextSummarizerModel.split(":");
		if (parts.length >= 3) {
			const providerId = parts[1];
			const modelId = parts[2];
			try {
				const { getProviderWithSecrets, decryptApiKey } = await import(
					"../providers"
				);
				const { listEnabledProviderModels } = await import(
					"../provider-models"
				);
				const provider = await getProviderWithSecrets(providerId);
				if (provider?.enabled) {
					const models: Array<{ id: string; name: string }> =
						await listEnabledProviderModels(provider.id);
					const model = models.find((m) => m.id === modelId);
					if (model) {
						resolvedModelName = model.name;
						overrideProvider = {
							baseUrl: provider.baseUrl,
							apiKey: decryptApiKey(
								provider.apiKeyEncrypted,
								provider.apiKeyIv,
							),
						};
					}
				}
			} catch {
				/* fall back to raw model ID */
			}
		}
	}

	return { resolvedModelName, overrideProvider };
}

/** Shared error handler for context summarizer API call failures */
function handleContextSummarizerError(
	error: unknown,
	config: ReturnType<typeof getConfig>,
): void {
	if (APICallError.isInstance(error)) {
		console.warn(
			`[CONTEXT_SUMMARIZER] Request failed: ${error.statusCode} ${error.message} ` +
				`(url=${config.contextSummarizerUrl}, model=${config.contextSummarizerModel})`,
		);
	}
}

export async function requestContextSummarizer(params: {
	system: string;
	user: string;
	maxTokens: number;
	temperature?: number;
}): Promise<string | null> {
	if (!canUseContextSummarizer()) return null;

	const config = getConfig();
	const { resolvedModelName, overrideProvider } =
		await resolveContextSummarizerModelAndProvider(config);
	const provider = createContextSummarizerProvider(
		config,
		resolvedModelName,
		overrideProvider,
	);

	try {
		const result = await generateText({
			model: provider(resolvedModelName),
			system: params.system,
			messages: [{ role: "user", content: params.user }],
			maxOutputTokens: params.maxTokens,
			temperature: params.temperature ?? 0.1,
			maxRetries: 0,
		});
		return result.text.trim() || null;
	} catch (error) {
		handleContextSummarizerError(error, config);
		if (APICallError.isInstance(error)) {
			return null;
		}
		throw error;
	}
}

export async function requestStructuredControlModel<
	T extends Record<string, unknown>,
>(params: {
	system: string;
	user: string;
	maxTokens: number;
	temperature?: number;
}): Promise<T | null> {
	if (!canUseContextSummarizer()) return null;

	const config = getConfig();
	const { resolvedModelName, overrideProvider } =
		await resolveContextSummarizerModelAndProvider(config);
	const provider = createContextSummarizerProvider(
		config,
		resolvedModelName,
		overrideProvider,
	);

	try {
		const result = await generateText({
			model: provider(resolvedModelName),
			system: params.system,
			messages: [{ role: "user", content: params.user }],
			output: Output.json(),
			maxOutputTokens: params.maxTokens,
			temperature: params.temperature ?? 0.1,
			maxRetries: 0,
		});
		if (!result.output) return null;
		const output = result.output as Record<string, unknown>;
		return output && typeof output === "object" ? (output as T) : null;
	} catch (error) {
		console.error(
			"[TASK_STATE] Structured control model request failed:",
			error,
		);
		handleContextSummarizerError(error, config);
		if (APICallError.isInstance(error)) {
			return null;
		}
		return null;
	}
}
