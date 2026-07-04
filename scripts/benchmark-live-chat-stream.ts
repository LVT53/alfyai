import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	consumeAiSdkUiStreamFrames,
	extractAiSdkUiStreamMetadataData,
	type UiMessageStreamPart,
} from "../src/lib/services/ai-sdk-ui-stream-contract";
import {
	BROWSER_STREAM_TIMING_MARKS,
	normalizeStreamTimelineTimings,
	parseServerTimingHeader,
	type StreamTimelineTimingRecord,
} from "../src/lib/services/stream-timeline";

const DEFAULT_BASE_URL = "https://ai.alfydesign.com";
const DEFAULT_RUN_COUNT = 5;
const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_ANSWER_TEXT_LENGTH = 12_000;

const CLIENT_TIMING_KEYS = [
	BROWSER_STREAM_TIMING_MARKS.RESPONSE_HEADERS,
	BROWSER_STREAM_TIMING_MARKS.FIRST_BYTE,
	BROWSER_STREAM_TIMING_MARKS.FIRST_RESPONSE_ACTIVITY,
	BROWSER_STREAM_TIMING_MARKS.FIRST_THINKING,
	BROWSER_STREAM_TIMING_MARKS.FIRST_TOOL_CALL,
	BROWSER_STREAM_TIMING_MARKS.FIRST_TOKEN,
	"finishPartMs",
	BROWSER_STREAM_TIMING_MARKS.END,
] as const;

type ClientTimingKey = (typeof CLIENT_TIMING_KEYS)[number];
export type BenchmarkReasoningDepth = "off" | "auto" | "max";

const BENCHMARK_PROMPTS = [
	"Reply in one short sentence that this live stream benchmark is harmless. Do not use external tools, web search, or files.",
	"Reply with exactly one concise sentence about stable latency measurement. Do not use external tools, web search, or files.",
	"Reply in one short sentence about keeping production checks repeatable. Do not use external tools, web search, or files.",
	"Reply with one plain sentence about measuring first token latency. Do not use external tools, web search, or files.",
	"Reply in one short sentence about comparing old and new deployments. Do not use external tools, web search, or files.",
	"Reply with one concise sentence about stream timing visibility. Do not use external tools, web search, or files.",
	"Reply in one short sentence about safe benchmark prompts. Do not use external tools, web search, or files.",
] as const;

export type BenchmarkOutcome = "ok" | "error";

export type BenchmarkStats = {
	count: number;
	min: number;
	p50: number;
	p95: number;
	mean: number;
};

export type BenchmarkRunResult = Partial<Record<ClientTimingKey, number>> & {
	runIndex: number;
	prompt: string;
	modelId: string;
	streamId?: string;
	conversationId?: string;
	startedAt: string;
	endedAt: string;
	chunkCount: number;
	textLength: number;
	answerText?: string;
	answerTextTruncated?: boolean;
	toolCallCount?: number;
	toolCallNames?: string[];
	finishReason?: string;
	serverTimingHeader?: string | null;
	serverTiming?: StreamTimelineTimingRecord;
	serverTimeline?: StreamTimelineTimingRecord;
	depthMetadata?: Record<string, unknown>;
	tokenCounts?: {
		thinking?: number;
		response?: number;
		total?: number;
	};
	generationDurationMs?: number;
	outcome: BenchmarkOutcome;
	error?: string;
};

export type BenchmarkSummary = {
	generatedAt: string;
	baseUrl?: string;
	modelId?: string;
	runCount: number;
	okCount: number;
	errorCount: number;
	clientTimings: Partial<Record<ClientTimingKey, BenchmarkStats>>;
	serverTiming: Record<string, BenchmarkStats>;
	serverTimeline: Record<string, BenchmarkStats>;
};

export type BenchmarkComparisonRow = {
	metric: string;
	oldP50: number;
	newP50: number;
	deltaP50: number;
	percentChange: number | null;
};

export type BenchmarkComparison = {
	oldGeneratedAt?: string;
	newGeneratedAt?: string;
	oldRunCount?: number;
	newRunCount?: number;
	rows: BenchmarkComparisonRow[];
};

export type BenchmarkStreamChunk = {
	text: string;
	elapsedMs: number;
	byteLength?: number;
};

type BenchmarkStreamParseOptions = {
	responseHeadersMs?: number;
	serverTimingHeader?: string | null;
	endMs?: number;
	maxAnswerTextLength?: number;
};

type BenchmarkConfig = {
	baseUrl: string;
	email: string;
	password: string;
	modelId: string;
	runCount: number;
	outputDir: string;
	timeoutMs: number;
	promptOverride?: string;
};

type LiveAiModelRef = {
	id: string;
	displayName?: string;
};

type ConversationCreateResponse = {
	id?: unknown;
};

type RunsFilePayload = {
	generatedAt: string;
	baseUrl: string;
	modelId: string;
	requestedRuns: number;
	runs: BenchmarkRunResult[];
};

export function parseBenchmarkStreamChunks(
	chunks: readonly BenchmarkStreamChunk[],
	options: BenchmarkStreamParseOptions = {},
): BenchmarkRunResult {
	const parser = createBenchmarkStreamParser(options);
	for (const chunk of chunks) {
		parser.push(chunk.text, chunk.elapsedMs, chunk.byteLength);
	}
	const endMs =
		options.endMs ?? chunks.at(-1)?.elapsedMs ?? options.responseHeadersMs ?? 0;
	return parser.finish(endMs);
}

export function summarizeBenchmarkRuns(
	runs: readonly BenchmarkRunResult[],
	options: {
		baseUrl?: string;
		modelId?: string;
		generatedAt?: string;
	} = {},
): BenchmarkSummary {
	const okCount = runs.filter((run) => run.outcome === "ok").length;
	const errorCount = runs.length - okCount;
	const clientTimings: Partial<Record<ClientTimingKey, BenchmarkStats>> = {};

	for (const key of CLIENT_TIMING_KEYS) {
		const values = runs
			.map((run) => run[key])
			.filter((value): value is number => Number.isFinite(value));
		const stats = createStats(values);
		if (stats) {
			clientTimings[key] = stats;
		}
	}

	return {
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		baseUrl: options.baseUrl,
		modelId: options.modelId,
		runCount: runs.length,
		okCount,
		errorCount,
		clientTimings,
		serverTiming: summarizeTimingRecordGroup(runs, "serverTiming"),
		serverTimeline: summarizeTimingRecordGroup(runs, "serverTimeline"),
	};
}

export function compareBenchmarkSummaries(
	oldSummary: BenchmarkSummary,
	newSummary: BenchmarkSummary,
): BenchmarkComparison {
	const rows: BenchmarkComparisonRow[] = [];

	for (const key of CLIENT_TIMING_KEYS) {
		addComparisonRow(
			rows,
			`client.${key}`,
			oldSummary.clientTimings[key],
			newSummary.clientTimings[key],
		);
	}

	addTimingGroupComparisonRows(
		rows,
		"serverTiming",
		oldSummary.serverTiming,
		newSummary.serverTiming,
	);
	addTimingGroupComparisonRows(
		rows,
		"serverTimeline",
		oldSummary.serverTimeline,
		newSummary.serverTimeline,
	);

	return {
		oldGeneratedAt: oldSummary.generatedAt,
		newGeneratedAt: newSummary.generatedAt,
		oldRunCount: oldSummary.runCount,
		newRunCount: newSummary.runCount,
		rows,
	};
}

export function formatBenchmarkComparison(
	comparison: BenchmarkComparison,
): string {
	if (comparison.rows.length === 0) {
		return "No shared p50 metrics found to compare.";
	}

	const header = [
		`Old: ${comparison.oldGeneratedAt ?? "unknown"} (${comparison.oldRunCount ?? "?"} runs)`,
		`New: ${comparison.newGeneratedAt ?? "unknown"} (${comparison.newRunCount ?? "?"} runs)`,
		"",
		`${"metric".padEnd(34)} ${"old p50".padStart(10)} ${"new p50".padStart(10)} ${"delta".padStart(10)} ${"change".padStart(9)}`,
		"-".repeat(78),
	];
	const body = comparison.rows.map((row) => {
		const change =
			row.percentChange === null ? "n/a" : `${row.percentChange.toFixed(1)}%`;
		return [
			row.metric.padEnd(34),
			row.oldP50.toFixed(1).padStart(10),
			row.newP50.toFixed(1).padStart(10),
			row.deltaP50.toFixed(1).padStart(10),
			change.padStart(9),
		].join(" ");
	});
	return [...header, ...body].join("\n");
}

function createBenchmarkStreamParser(
	options: BenchmarkStreamParseOptions = {},
) {
	let buffer = "";
	const errors: string[] = [];
	const result: BenchmarkRunResult = {
		runIndex: 0,
		prompt: "",
		modelId: "",
		startedAt: "",
		endedAt: "",
		responseHeadersMs: options.responseHeadersMs,
		chunkCount: 0,
		textLength: 0,
		answerText: "",
		toolCallCount: 0,
		toolCallNames: [],
		serverTimingHeader: options.serverTimingHeader ?? null,
		serverTiming: parseServerTimingHeader(options.serverTimingHeader),
		serverTimeline: {},
		outcome: "ok",
	};

	function recordTiming(key: ClientTimingKey, elapsedMs: number) {
		if (result[key] === undefined && Number.isFinite(elapsedMs)) {
			result[key] = roundMs(elapsedMs);
		}
	}

	function collectStreamError(part: UiMessageStreamPart) {
		const data = part.data;
		const parsed = data && typeof data === "object" ? data : {};
		const message =
			(typeof data === "string" && data) ||
			(typeof (parsed as Record<string, unknown>).message === "string" &&
				((parsed as Record<string, unknown>).message as string)) ||
			(typeof (parsed as Record<string, unknown>).error === "string" &&
				((parsed as Record<string, unknown>).error as string)) ||
			(typeof part.errorText === "string" && part.errorText) ||
			(typeof part.error === "string" && part.error) ||
			"Stream error";
		errors.push(redactSensitiveText(message));
	}

	function processMetadata(part: UiMessageStreamPart) {
		const metadata = extractAiSdkUiStreamMetadataData(part);
		if (!metadata) return;

		const streamId = metadata.streamId;
		const conversationId = metadata.conversationId;
		if (typeof streamId === "string" && streamId.trim()) {
			result.streamId = streamId.trim();
		}
		if (typeof conversationId === "string" && conversationId.trim()) {
			result.conversationId = conversationId.trim();
		}

		const serverTimeline = extractServerTimeline(metadata.serverTimeline);
		if (serverTimeline) {
			result.serverTimeline = serverTimeline;
		}

		const depthMetadata = cloneRecord(metadata.depthMetadata);
		if (depthMetadata) {
			result.depthMetadata = depthMetadata;
		}

		const thinkingTokenCount = readFiniteNumber(metadata.thinkingTokenCount);
		const responseTokenCount = readFiniteNumber(metadata.responseTokenCount);
		const totalTokenCount = readFiniteNumber(metadata.totalTokenCount);
		if (
			thinkingTokenCount !== undefined ||
			responseTokenCount !== undefined ||
			totalTokenCount !== undefined
		) {
			result.tokenCounts = {
				...(thinkingTokenCount !== undefined
					? { thinking: thinkingTokenCount }
					: {}),
				...(responseTokenCount !== undefined
					? { response: responseTokenCount }
					: {}),
				...(totalTokenCount !== undefined ? { total: totalTokenCount } : {}),
			};
		}

		const generationDurationMs = readFiniteNumber(
			metadata.generationDurationMs,
		);
		if (generationDurationMs !== undefined) {
			result.generationDurationMs = generationDurationMs;
		}
	}

	function appendAnswerText(chunk: string) {
		const maxLength =
			options.maxAnswerTextLength ?? DEFAULT_MAX_ANSWER_TEXT_LENGTH;
		if (maxLength <= 0) {
			result.answerTextTruncated = true;
			return;
		}

		const current = result.answerText ?? "";
		const remaining = maxLength - current.length;
		if (remaining <= 0) {
			result.answerTextTruncated = true;
			return;
		}

		result.answerText = `${current}${chunk.slice(0, remaining)}`;
		if (chunk.length > remaining) {
			result.answerTextTruncated = true;
		}
	}

	function recordToolCall(part: UiMessageStreamPart) {
		result.toolCallCount = (result.toolCallCount ?? 0) + 1;
		const name = extractToolCallName(part.data);
		if (name) {
			result.toolCallNames = [...(result.toolCallNames ?? []), name];
		}
	}

	function processPart(part: UiMessageStreamPart, elapsedMs: number) {
		switch (part.type) {
			case "data-response-activity":
				recordTiming(
					BROWSER_STREAM_TIMING_MARKS.FIRST_RESPONSE_ACTIVITY,
					elapsedMs,
				);
				break;

			case "reasoning-delta": {
				const chunk =
					typeof part.delta === "string"
						? part.delta
						: typeof part.text === "string"
							? part.text
							: "";
				if (chunk) {
					recordTiming(BROWSER_STREAM_TIMING_MARKS.FIRST_THINKING, elapsedMs);
				}
				break;
			}

			case "data-tool-call":
				recordToolCall(part);
				recordTiming(BROWSER_STREAM_TIMING_MARKS.FIRST_TOOL_CALL, elapsedMs);
				break;

			case "text-delta": {
				const chunk =
					typeof part.delta === "string"
						? part.delta
						: typeof part.text === "string"
							? part.text
							: "";
				if (chunk) {
					recordTiming(BROWSER_STREAM_TIMING_MARKS.FIRST_TOKEN, elapsedMs);
					result.textLength += chunk.length;
					appendAnswerText(chunk);
				}
				break;
			}

			case "data-stream-metadata":
				processMetadata(part);
				break;

			case "data-stream-error":
			case "error":
				collectStreamError(part);
				break;

			case "finish":
				recordTiming("finishPartMs", elapsedMs);
				if (typeof part.finishReason === "string") {
					result.finishReason = part.finishReason;
				}
				if (part.finishReason === "error") {
					collectStreamError(part);
				}
				break;
		}
	}

	function drain(elapsedMs: number, isFinalChunk = false) {
		const consumed = consumeAiSdkUiStreamFrames(buffer);
		buffer = consumed.remaining;
		for (const frame of consumed.frames) {
			if (frame.kind === "part") {
				processPart(frame.part, elapsedMs);
			}
		}

		if (isFinalChunk && buffer.trim()) {
			const finalConsumed = consumeAiSdkUiStreamFrames(`${buffer}\n\n`);
			buffer = "";
			for (const frame of finalConsumed.frames) {
				if (frame.kind === "part") {
					processPart(frame.part, elapsedMs);
				}
			}
		}
	}

	return {
		push(chunk: string, elapsedMs: number, byteLength?: number) {
			const observedByteLength = byteLength ?? Buffer.byteLength(chunk);
			if (observedByteLength > 0) {
				result.chunkCount += 1;
				recordTiming(BROWSER_STREAM_TIMING_MARKS.FIRST_BYTE, elapsedMs);
			}
			buffer += chunk;
			drain(elapsedMs);
		},
		finish(endMs: number): BenchmarkRunResult {
			drain(endMs, true);
			recordTiming(BROWSER_STREAM_TIMING_MARKS.END, endMs);
			result.outcome = errors.length > 0 ? "error" : "ok";
			if (errors.length > 0) {
				result.error = errors.join("; ");
			}
			return result;
		},
	};
}

function summarizeTimingRecordGroup(
	runs: readonly BenchmarkRunResult[],
	field: "serverTiming" | "serverTimeline",
): Record<string, BenchmarkStats> {
	const keys = new Set<string>();
	for (const run of runs) {
		for (const key of Object.keys(run[field] ?? {})) {
			keys.add(key);
		}
	}

	const summary: Record<string, BenchmarkStats> = {};
	for (const key of [...keys].sort()) {
		const values = runs
			.map((run) => run[field]?.[key])
			.filter((value): value is number => Number.isFinite(value));
		const stats = createStats(values);
		if (stats) {
			summary[key] = stats;
		}
	}
	return summary;
}

function createStats(values: readonly number[]): BenchmarkStats | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((total, value) => total + value, 0);
	return {
		count: sorted.length,
		min: roundMs(sorted[0]),
		p50: roundMs(nearestRankPercentile(sorted, 0.5)),
		p95: roundMs(nearestRankPercentile(sorted, 0.95)),
		mean: roundMs(sum / sorted.length),
	};
}

function nearestRankPercentile(
	sortedValues: readonly number[],
	percentile: number,
) {
	const index = Math.max(
		0,
		Math.min(
			sortedValues.length - 1,
			Math.ceil(sortedValues.length * percentile) - 1,
		),
	);
	return sortedValues[index];
}

function addTimingGroupComparisonRows(
	rows: BenchmarkComparisonRow[],
	prefix: "serverTiming" | "serverTimeline",
	oldGroup: Record<string, BenchmarkStats>,
	newGroup: Record<string, BenchmarkStats>,
) {
	const keys = [
		...new Set([...Object.keys(oldGroup), ...Object.keys(newGroup)]),
	].sort();
	for (const key of keys) {
		addComparisonRow(rows, `${prefix}.${key}`, oldGroup[key], newGroup[key]);
	}
}

function addComparisonRow(
	rows: BenchmarkComparisonRow[],
	metric: string,
	oldStats: BenchmarkStats | undefined,
	newStats: BenchmarkStats | undefined,
) {
	if (!oldStats || !newStats) return;
	const deltaP50 = roundMs(newStats.p50 - oldStats.p50);
	rows.push({
		metric,
		oldP50: oldStats.p50,
		newP50: newStats.p50,
		deltaP50,
		percentChange:
			oldStats.p50 === 0 ? null : roundMs((deltaP50 / oldStats.p50) * 100),
	});
}

function extractServerTimeline(
	value: unknown,
): StreamTimelineTimingRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const server = (value as Record<string, unknown>).server;
	if (!server || typeof server !== "object") return undefined;
	return normalizeStreamTimelineTimings(server as Record<string, unknown>);
}

function cloneRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return { ...(value as Record<string, unknown>) };
}

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function extractToolCallName(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const name = record.name ?? record.toolName;
	return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

function roundMs(value: number): number {
	return Math.round(value * 10) / 10;
}

class CookieJar {
	#cookies = new Map<string, string>();

	store(headers: Headers) {
		for (const setCookie of readSetCookieHeaders(headers)) {
			const pair = setCookie.split(";")[0]?.trim();
			if (!pair) continue;
			const equalsIndex = pair.indexOf("=");
			if (equalsIndex <= 0) continue;
			this.#cookies.set(
				pair.slice(0, equalsIndex),
				pair.slice(equalsIndex + 1),
			);
		}
	}

	header(): string | undefined {
		const value = [...this.#cookies.entries()]
			.map(([name, cookieValue]) => `${name}=${cookieValue}`)
			.join("; ");
		return value || undefined;
	}
}

export class LiveAiClient {
	readonly #baseUrl: string;
	readonly #jar = new CookieJar();

	constructor(baseUrl: string) {
		this.#baseUrl = normalizeBaseUrl(baseUrl);
	}

	async login(email: string, password: string) {
		const response = await this.fetch("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password, rememberMe: false }),
		});
		if (!response.ok) {
			throw new Error(`Login failed with HTTP ${response.status}`);
		}
		await response.body?.cancel().catch(() => undefined);
	}

	async json<T>(urlPath: string, init: RequestInit = {}): Promise<T> {
		const response = await this.fetch(urlPath, init);
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`HTTP ${response.status} from ${urlPath}: ${redactSensitiveText(text).slice(0, 500)}`,
			);
		}
		return JSON.parse(text) as T;
	}

	async fetch(urlPath: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		const cookie = this.#jar.header();
		if (cookie) {
			headers.set("Cookie", cookie);
		}
		const response = await fetch(new URL(urlPath, this.#baseUrl), {
			...init,
			headers,
		});
		this.#jar.store(response.headers);
		return response;
	}
}

async function runLiveBenchmark(config: BenchmarkConfig) {
	const client = new LiveAiClient(config.baseUrl);
	await client.login(config.email, config.password);
	await assertModelAvailable(client, config.modelId);

	const runs: BenchmarkRunResult[] = [];
	for (let index = 1; index <= config.runCount; index += 1) {
		const prompt = getBenchmarkPrompt(index, config.promptOverride);
		console.log(`run ${index}/${config.runCount}: starting`);
		const run = await runSingleStreamBenchmark(client, {
			runIndex: index,
			prompt,
			modelId: config.modelId,
			timeoutMs: config.timeoutMs,
		});
		runs.push(run);
		if (run.outcome === "ok") {
			console.log(
				`run ${index}/${config.runCount}: ok firstToken=${formatMaybeMs(
					run.firstTokenMs,
				)} end=${formatMaybeMs(run.endMs)} chunks=${run.chunkCount} text=${run.textLength}`,
			);
		} else {
			console.log(
				`run ${index}/${config.runCount}: error ${redactSensitiveText(
					run.error ?? "unknown error",
				)}`,
			);
		}
	}

	const generatedAt = new Date().toISOString();
	const runsPayload: RunsFilePayload = {
		generatedAt,
		baseUrl: config.baseUrl,
		modelId: config.modelId,
		requestedRuns: config.runCount,
		runs,
	};
	const summary = summarizeBenchmarkRuns(runs, {
		baseUrl: config.baseUrl,
		modelId: config.modelId,
		generatedAt,
	});

	await mkdir(config.outputDir, { recursive: true });
	await writeJsonFile(path.join(config.outputDir, "runs.json"), runsPayload);
	await writeJsonFile(path.join(config.outputDir, "summary.json"), summary);

	console.log(`wrote ${path.join(config.outputDir, "runs.json")}`);
	console.log(`wrote ${path.join(config.outputDir, "summary.json")}`);
}

export async function assertModelAvailable(
	client: LiveAiClient,
	modelId: string,
) {
	const payload = await client.json<Record<string, unknown>>("/api/models");
	const models = collectModelRefs(payload);
	const match = models.find((model) => model.id === modelId);
	if (!match) {
		throw new Error(
			`LIVE_AI_BENCH_MODEL_ID=${modelId} was not found in /api/models. Available model ids: ${models
				.map((model) => model.id)
				.sort()
				.join(", ")}`,
		);
	}
	console.log(
		`using model ${match.displayName ? `${match.displayName} (${match.id})` : match.id}`,
	);
}

function collectModelRefs(payload: Record<string, unknown>): LiveAiModelRef[] {
	const refs: LiveAiModelRef[] = [];
	const legacyModels = payload.models;
	if (Array.isArray(legacyModels)) {
		for (const model of legacyModels) {
			if (model && typeof model === "object") {
				const id = (model as Record<string, unknown>).id;
				const displayName = (model as Record<string, unknown>).displayName;
				if (typeof id === "string") {
					refs.push({
						id,
						displayName:
							typeof displayName === "string" ? displayName : undefined,
					});
				}
			}
		}
	}

	const providers = payload.providers;
	if (Array.isArray(providers)) {
		for (const provider of providers) {
			if (!provider || typeof provider !== "object") continue;
			const models = (provider as Record<string, unknown>).models;
			if (!Array.isArray(models)) continue;
			for (const model of models) {
				if (!model || typeof model !== "object") continue;
				const id = (model as Record<string, unknown>).id;
				const displayName = (model as Record<string, unknown>).displayName;
				if (typeof id === "string") {
					refs.push({
						id,
						displayName:
							typeof displayName === "string" ? displayName : undefined,
					});
				}
			}
		}
	}
	return refs;
}

export async function runSingleStreamBenchmark(
	client: LiveAiClient,
	input: {
		runIndex: number;
		prompt: string;
		modelId: string;
		timeoutMs: number;
		reasoningDepth?: BenchmarkReasoningDepth;
	},
): Promise<BenchmarkRunResult> {
	const streamId = randomUUID();
	let conversationId: string | undefined;
	const startedAt = new Date().toISOString();
	let streamStartMs = performance.now();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

	try {
		conversationId = await createBenchmarkConversation(client, input.runIndex);
		streamStartMs = performance.now();
		const response = await client.fetch("/api/chat/stream", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: input.prompt,
				conversationId,
				streamId,
				model: input.modelId,
				reasoningDepth: input.reasoningDepth ?? "auto",
				thinkingMode: reasoningDepthToBenchmarkThinkingMode(
					input.reasoningDepth ?? "auto",
				),
				forceWebSearch: false,
			}),
			signal: controller.signal,
		});
		const responseHeadersMs = elapsedSince(streamStartMs);
		const serverTimingHeader = response.headers.get("Server-Timing");
		const parser = createBenchmarkStreamParser({
			responseHeadersMs,
			serverTimingHeader,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			return attachRunContext(parser.finish(elapsedSince(streamStartMs)), {
				...input,
				streamId,
				conversationId,
				startedAt,
				outcome: "error",
				error: `stream HTTP ${response.status}: ${redactSensitiveText(body).slice(0, 500)}`,
			});
		}
		if (!response.body) {
			return attachRunContext(parser.finish(elapsedSince(streamStartMs)), {
				...input,
				streamId,
				conversationId,
				startedAt,
				outcome: "error",
				error: "stream response had no body",
			});
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			const elapsedMs = elapsedSince(streamStartMs);
			if (done) {
				const finalChunk = decoder.decode();
				if (finalChunk) {
					parser.push(finalChunk, elapsedMs, 0);
				}
				break;
			}
			parser.push(
				decoder.decode(value, { stream: true }),
				elapsedMs,
				value.byteLength,
			);
		}

		const parsed = parser.finish(elapsedSince(streamStartMs));
		return attachRunContext(parsed, {
			...input,
			streamId,
			conversationId,
			startedAt,
			outcome: parsed.outcome,
			error: parsed.error,
		});
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: `Unknown error: ${String(error)}`;
		return {
			runIndex: input.runIndex,
			prompt: input.prompt,
			modelId: input.modelId,
			streamId,
			conversationId,
			startedAt,
			endedAt: new Date().toISOString(),
			chunkCount: 0,
			textLength: 0,
			endMs: elapsedSince(streamStartMs),
			outcome: "error",
			error: redactSensitiveText(message),
		};
	} finally {
		clearTimeout(timeout);
	}
}

function reasoningDepthToBenchmarkThinkingMode(
	reasoningDepth: BenchmarkReasoningDepth,
) {
	if (reasoningDepth === "off") return "off";
	if (reasoningDepth === "max") return "on";
	return "auto";
}

function attachRunContext(
	parsed: BenchmarkRunResult,
	context: {
		runIndex: number;
		prompt: string;
		modelId: string;
		streamId: string;
		conversationId?: string;
		startedAt: string;
		outcome: BenchmarkOutcome;
		error?: string;
	},
): BenchmarkRunResult {
	return {
		...parsed,
		runIndex: context.runIndex,
		prompt: context.prompt,
		modelId: context.modelId,
		streamId: parsed.streamId ?? context.streamId,
		conversationId: parsed.conversationId ?? context.conversationId,
		startedAt: context.startedAt,
		endedAt: new Date().toISOString(),
		outcome: context.outcome,
		error: context.error ?? parsed.error,
	};
}

async function createBenchmarkConversation(
	client: LiveAiClient,
	runIndex: number,
): Promise<string> {
	const response = await client.json<ConversationCreateResponse>(
		"/api/conversations",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: `Live chat stream benchmark ${new Date().toISOString()} run ${runIndex}`,
				projectId: null,
			}),
		},
	);
	if (typeof response.id !== "string" || response.id.trim().length === 0) {
		throw new Error("Conversation creation returned no id");
	}
	return response.id;
}

function getBenchmarkPrompt(
	runIndex: number,
	promptOverride: string | undefined,
) {
	if (promptOverride?.trim()) {
		return promptOverride.trim();
	}
	return BENCHMARK_PROMPTS[(runIndex - 1) % BENCHMARK_PROMPTS.length];
}

function elapsedSince(startMs: number): number {
	return roundMs(performance.now() - startMs);
}

function formatMaybeMs(value: number | undefined): string {
	return value === undefined ? "n/a" : `${value.toFixed(1)}ms`;
}

function readBenchmarkConfig(env: NodeJS.ProcessEnv): BenchmarkConfig {
	const baseUrl = normalizeBaseUrl(env.LIVE_AI_BASE_URL ?? DEFAULT_BASE_URL);
	const modelId = requireEnv(env, "LIVE_AI_BENCH_MODEL_ID");
	const runCount = readPositiveIntegerEnv(
		env.LIVE_AI_BENCH_RUNS,
		DEFAULT_RUN_COUNT,
		"LIVE_AI_BENCH_RUNS",
	);
	const timeoutMs = readPositiveIntegerEnv(
		env.LIVE_AI_BENCH_TIMEOUT_MS ?? env.LIVE_AI_TIMEOUT_MS,
		DEFAULT_TIMEOUT_MS,
		env.LIVE_AI_BENCH_TIMEOUT_MS
			? "LIVE_AI_BENCH_TIMEOUT_MS"
			: "LIVE_AI_TIMEOUT_MS",
	);
	const outputDir =
		env.LIVE_AI_OUTPUT_DIR ??
		path.join(
			process.cwd(),
			"test-results",
			`live-chat-stream-benchmark-${new Date().toISOString().replace(/[:.]/g, "-")}`,
		);

	return {
		baseUrl,
		email: requireEnv(env, "LIVE_AI_EMAIL"),
		password: requireEnv(env, "LIVE_AI_PASSWORD"),
		modelId,
		runCount,
		timeoutMs,
		outputDir,
		promptOverride: env.LIVE_AI_BENCH_PROMPT,
	};
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value?.trim()) {
		throw new Error(`${name} is required`);
	}
	return value.trim();
}

function readPositiveIntegerEnv(
	rawValue: string | undefined,
	fallback: number,
	name: string,
): number {
	if (rawValue === undefined || rawValue.trim() === "") {
		return fallback;
	}
	const value = Number(rawValue);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function normalizeBaseUrl(value: string): string {
	const url = new URL(value);
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	url.search = "";
	url.hash = "";
	return url.toString();
}

function readSetCookieHeaders(headers: Headers): string[] {
	const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
		.getSetCookie;
	const directValues =
		typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
	if (directValues.length > 0) {
		return directValues;
	}
	const combined = headers.get("set-cookie");
	return combined ? splitCombinedSetCookieHeader(combined) : [];
}

function splitCombinedSetCookieHeader(header: string): string[] {
	return header
		.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g)
		.map((part) => part.trim())
		.filter(Boolean);
}

function redactSensitiveText(value: string): string {
	return value
		.replace(/(password["']?\s*[:=]\s*)["']?[^"',\s]+/gi, "$1[redacted]")
		.replace(/(token["']?\s*[:=]\s*)["']?[^"',\s]+/gi, "$1[redacted]")
		.replace(/(session(?:id)?["']?\s*[:=]\s*)["']?[^"',\s;]+/gi, "$1[redacted]")
		.replace(/Cookie:\s*[^\n\r]+/gi, "Cookie: [redacted]")
		.replace(/Set-Cookie:\s*[^\n\r]+/gi, "Set-Cookie: [redacted]");
}

async function writeJsonFile(filePath: string, value: unknown) {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readSummaryFile(filePath: string): Promise<BenchmarkSummary> {
	return JSON.parse(await readFile(filePath, "utf8")) as BenchmarkSummary;
}

async function main(argv = process.argv.slice(2)) {
	if (argv[0] === "--compare") {
		const oldPath = argv[1];
		const newPath = argv[2];
		if (!oldPath || !newPath || argv.length !== 3) {
			throw new Error(
				"Usage: npx tsx scripts/benchmark-live-chat-stream.ts --compare old-summary.json new-summary.json",
			);
		}
		const comparison = compareBenchmarkSummaries(
			await readSummaryFile(oldPath),
			await readSummaryFile(newPath),
		);
		console.log(formatBenchmarkComparison(comparison));
		return;
	}

	if (argv.length > 0) {
		throw new Error(
			"Usage: npx tsx scripts/benchmark-live-chat-stream.ts [--compare old-summary.json new-summary.json]",
		);
	}

	await runLiveBenchmark(readBenchmarkConfig(process.env));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
	main().catch((error) => {
		const message =
			error instanceof Error
				? error.message
				: `Unknown error: ${String(error)}`;
		console.error(redactSensitiveText(message));
		process.exitCode = 1;
	});
}
