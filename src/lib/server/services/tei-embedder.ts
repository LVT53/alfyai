import { getConfig } from "$lib/server/config-store";
import { postToTei } from "./tei-client";

type TeiEmbedResponse =
	| number[]
	| number[][]
	| { embeddings?: number[] | number[][] };

function isNumberArray(value: unknown): value is number[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "number")
	);
}

function isEmbeddingMatrix(value: unknown): value is number[][] {
	return Array.isArray(value) && value.every((item) => isNumberArray(item));
}

function normalizeEmbeddingResponse(response: TeiEmbedResponse): number[][] {
	if (isEmbeddingMatrix(response)) {
		return response;
	}

	if (isNumberArray(response)) {
		return [response];
	}

	if (response && typeof response === "object" && "embeddings" in response) {
		const embeddings = response.embeddings;
		if (isEmbeddingMatrix(embeddings)) {
			return embeddings;
		}
		if (isNumberArray(embeddings)) {
			return [embeddings];
		}
	}

	throw new Error("Unexpected TEI embed response shape");
}

export function canUseTeiEmbedder(): boolean {
	const config = getConfig();
	return Boolean(config.teiEmbedderUrl);
}

// A TEI server refuses batches above its own `--max-client-batch-size`
// with a 422 naming the limit. When that happens the limit is remembered
// for the process lifetime so a misconfigured TEI_EMBEDDER_BATCH_SIZE
// (32 on staging against a server capped at 8) self-corrects instead of
// failing every backfill run.
const SERVER_BATCH_LIMIT_RE =
	/batch size \d+ > maximum allowed batch size (\d+)/i;
let learnedServerBatchLimit: number | null = null;

export function resetLearnedTeiBatchLimitForTests(): void {
	learnedServerBatchLimit = null;
}

function parseServerBatchLimit(error: unknown): number | null {
	const message = error instanceof Error ? error.message : String(error);
	const match = SERVER_BATCH_LIMIT_RE.exec(message);
	if (!match) return null;
	const limit = Number.parseInt(match[1], 10);
	return Number.isFinite(limit) && limit >= 1 ? limit : null;
}

export function getTeiEmbedderBatchSize(): number {
	const configured = Math.max(1, getConfig().teiEmbedderBatchSize);
	return learnedServerBatchLimit
		? Math.min(configured, learnedServerBatchLimit)
		: configured;
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

async function postEmbedBatch(
	texts: string[],
	options: { normalize?: boolean; truncate?: boolean; promptName?: string },
): Promise<number[][]> {
	const config = getConfig();
	const promptName = options.promptName?.trim();
	const body: Record<string, unknown> = {
		inputs: texts,
		normalize: options.normalize ?? true,
		truncate: options.truncate ?? true,
	};
	if (promptName) {
		body.prompt_name = promptName;
	}

	const response = await postToTei<TeiEmbedResponse>({
		baseUrl: config.teiEmbedderUrl,
		path: "/embed",
		apiKey: config.teiEmbedderApiKey,
		body,
	});

	return normalizeEmbeddingResponse(response);
}

/**
 * Embeds `texts` in order, never sending more than the effective batch size
 * per request (see getTeiEmbedderBatchSize). Callers may pass any number of
 * texts; the result has one vector per input.
 */
export async function embedTexts(
	texts: string[],
	options: {
		normalize?: boolean;
		truncate?: boolean;
		promptName?: string;
	} = {},
): Promise<number[][] | null> {
	if (texts.length === 0) return [];
	if (!canUseTeiEmbedder()) return null;

	const embeddings: number[][] = [];
	let pending = texts;
	while (pending.length > 0) {
		const batchSize = getTeiEmbedderBatchSize();
		const [batch, ...rest] = chunk(pending, batchSize);
		try {
			embeddings.push(...(await postEmbedBatch(batch, options)));
		} catch (error) {
			const serverLimit = parseServerBatchLimit(error);
			if (serverLimit === null || serverLimit >= batch.length) throw error;
			console.warn(
				"[TEI_EMBEDDER] Server batch limit is lower than configured; retrying with smaller batches",
				{
					configured: batchSize,
					serverLimit,
				},
			);
			learnedServerBatchLimit = serverLimit;
			continue;
		}
		pending = rest.flat();
	}

	return embeddings;
}

export async function embedText(
	text: string,
	options: {
		normalize?: boolean;
		truncate?: boolean;
		promptName?: string;
	} = {},
): Promise<number[] | null> {
	const embeddings = await embedTexts([text], options);
	return embeddings ? (embeddings[0] ?? null) : null;
}
