import { createHash } from "node:crypto";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { asSchema } from "@ai-sdk/provider-utils";
import type { ToolExecutionOptions } from "ai";
import { jsonSchema } from "ai";
import { z } from "zod";

import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { deriveToolResultDigest } from "./tool-result-digest";

// ── Record helper ──────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ── Text helpers ───────────────────────────────────────────────

export function truncateText(
	value: string | null | undefined,
	maxLength: number,
): string {
	const text = value ?? "";
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength).trimEnd()}...`;
}

// ── Stable serialization ───────────────────────────────────────

export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

export function shortHash(value: unknown): string {
	return createHash("sha256")
		.update(stableStringify(value))
		.digest("hex")
		.slice(0, 12);
}

// ── Multi-connection selection (disambiguation) ───────────────
//
// Shared by every capability tool (calendar/files/photos/contacts/tasks/
// email/media/location) so an `account` selector that matches none of the
// user's connections for that capability degrades gracefully — never a hard
// error, and never a silent wrong-connection pick — by listing the accounts
// the user actually has and asking which one they meant. Mirrors the
// "degrade gracefully" posture every tool already uses for a missing/broken
// connection.
export function noMatchingConnectionMessage(
	capabilityLabel: string,
	selector: string,
	connections: { label: string; provider: string }[],
): string {
	const listed = connections
		.map((conn) => `${conn.label} (${conn.provider})`)
		.join(", ");
	return `You have these ${capabilityLabel} accounts: ${listed}. I couldn't match "${selector}" — which one did you mean?`;
}

// ── Model payload compaction ────────────────────────────────────
//
// Every successful tool `modelPayload` is run through this before it reaches
// the model (see `executeToolWithEnvelope` below): drop keys whose value
// carries no information (undefined/null, empty arrays, empty objects, empty
// strings) so the model isn't billed tokens for placeholders like
// `omittedSiblingCount: []` or `snippet: ""`. A short allow-list of envelope
// keys is kept even when empty/falsy, because their ABSENCE (not their value)
// is what a caller or the model keys off of — e.g. `success: false` must
// never be dropped for being falsy, and `name`/`sourceType`/`mode` identify
// the payload's shape. Recurses exactly one level into plain-object values
// (e.g. `answerBrief: { sourceCount, evidenceCount }`) so a nested empty key
// is also dropped; array items are left untouched — an array is a list of
// records the model should see whole, not a bag of optional fields.
const NEVER_DROP_MODEL_PAYLOAD_KEYS = new Set([
	"success",
	"name",
	"action",
	"message",
	"mode",
	"sourceType",
]);

function isEmptyModelPayloadValue(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value === "string") return value.length === 0;
	if (Array.isArray(value)) return value.length === 0;
	if (isRecord(value)) return Object.keys(value).length === 0;
	return false;
}

function compactModelPayloadShallow(
	record: Record<string, unknown>,
): Record<string, unknown> {
	const compacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (
			!NEVER_DROP_MODEL_PAYLOAD_KEYS.has(key) &&
			isEmptyModelPayloadValue(value)
		) {
			continue;
		}
		compacted[key] = value;
	}
	return compacted;
}

export function compactModelPayload<T>(payload: T): T {
	if (!isRecord(payload)) return payload;
	const compacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		// One level of recursion: a nested plain object gets its own empty keys
		// stripped, but we don't descend further (a grandchild object is left
		// as-is once its parent has been compacted once).
		const compactedValue = isRecord(value)
			? compactModelPayloadShallow(value)
			: value;
		if (
			!NEVER_DROP_MODEL_PAYLOAD_KEYS.has(key) &&
			isEmptyModelPayloadValue(compactedValue)
		) {
			continue;
		}
		compacted[key] = compactedValue;
	}
	return compacted as T;
}

// ── Metadata ───────────────────────────────────────────────────

export function sanitizeMetadata(
	metadata: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
	return Object.fromEntries(
		Object.entries(metadata).filter(
			([, value]) =>
				["string", "number", "boolean"].includes(typeof value) ||
				value === null,
		),
	);
}

export function optionalScalarMetadata(
	value: string | number | boolean | null | undefined,
): string | number | boolean | null | undefined {
	return value === undefined ? undefined : value;
}

// ── Tool call recorder ─────────────────────────────────────────

export interface ToolCallRecorder {
	record(entry: ToolCallEntry): ToolCallEntry;
	getEntries(): ToolCallEntry[];
}

export function recordToolCallEntry(
	entries: ToolCallEntry[],
	entry: ToolCallEntry,
): ToolCallEntry {
	const normalized: ToolCallEntry = {
		...entry,
		input: { ...entry.input },
		outputSummary: entry.outputSummary ?? null,
		metadata: entry.metadata ? { ...entry.metadata } : undefined,
	};
	entries.push(normalized);
	return normalized;
}

export function createToolCallRecorder(
	initialEntries: ToolCallEntry[] = [],
): ToolCallRecorder {
	const entries = initialEntries;
	return {
		record(entry) {
			return recordToolCallEntry(entries, entry);
		},
		getEntries() {
			return [...entries];
		},
	};
}

// ── Timeout ────────────────────────────────────────────────────

export const TOOL_TIMEOUTS_MS: Record<string, number> = {
	research_web: 60_000,
	// fetch_url defaults to CACHED Extract (max_age 86400, ~735ms), so slow
	// fetches are rare; but an UNCACHED live Extract can spike to ~42s (see
	// parallel-search/fetch-url.ts), which the old 30s cap surfaced as a spurious
	// tool timeout. 45s clears that worst-case tail while staying under
	// research_web's 60s.
	fetch_url: 45_000,
	memory_context: 15_000,
	image_search: 30_000,
	produce_file: 30_000,
	read_generated_file: 10_000,
	files: 20_000,
	calendar: 20_000,
	email: 20_000,
	photos: 20_000,
	media: 20_000,
	location: 20_000,
	contacts: 20_000,
	repos: 20_000,
	tasks: 20_000,
	map_route: 20_000,
};

export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	toolName: string,
	abortSignal?: AbortSignal,
): Promise<T> {
	if (abortSignal?.aborted) {
		throw toolAbortError(toolName, abortSignal.reason);
	}

	if ((!Number.isFinite(timeoutMs) || timeoutMs <= 0) && !abortSignal) {
		return promise;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let removeAbortListener: (() => void) | undefined;
	const timeoutOrAbort = new Promise<never>((_, reject) => {
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timer = setTimeout(() => {
				reject(new Error(`${toolName} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
		}
		if (abortSignal) {
			const onAbort = () => {
				reject(toolAbortError(toolName, abortSignal.reason));
			};
			abortSignal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () =>
				abortSignal.removeEventListener("abort", onAbort);
		}
	});

	try {
		return await Promise.race([promise, timeoutOrAbort]);
	} finally {
		if (timer) clearTimeout(timer);
		removeAbortListener?.();
	}
}

function toolAbortError(toolName: string, reason: unknown): Error {
	if (reason instanceof Error) {
		return new Error(`${toolName} aborted: ${reason.message}`);
	}
	if (typeof reason === "string" && reason.trim()) {
		return new Error(`${toolName} aborted: ${reason.trim()}`);
	}
	return new Error(`${toolName} aborted`);
}

function toolTimeoutError(toolName: string, timeoutMs: number): Error {
	return new Error(`${toolName} timed out after ${timeoutMs}ms`);
}

export function modelSafeToolError(error: unknown, fallback: string): string {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: fallback;
	const trimmed = message.trim();
	return truncateText(trimmed || fallback, 500);
}

export async function executeToolWithEnvelope<
	TModelPayload,
	TErrorPayload = TModelPayload,
>(params: {
	toolName: string;
	timeoutMs: number;
	options: Pick<ToolExecutionOptions, "toolCallId" | "abortSignal">;
	recorder: ToolCallRecorder;
	run: (abortSignal: AbortSignal) => Promise<{
		modelPayload: TModelPayload;
		entry: ToolCallEntry;
	}>;
	onError: (error: unknown) => {
		modelPayload: TErrorPayload;
		entry: ToolCallEntry;
	};
}): Promise<TModelPayload | TErrorPayload> {
	try {
		if (params.options.abortSignal?.aborted) {
			throw toolAbortError(params.toolName, params.options.abortSignal.reason);
		}
		const timeoutController = new AbortController();
		const runSignal = params.options.abortSignal
			? AbortSignal.any([params.options.abortSignal, timeoutController.signal])
			: timeoutController.signal;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let removeAbortListener: (() => void) | undefined;
		const timeoutOrAbort = new Promise<never>((_, reject) => {
			if (Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
				timer = setTimeout(() => {
					const error = toolTimeoutError(params.toolName, params.timeoutMs);
					timeoutController.abort(error);
					reject(error);
				}, params.timeoutMs);
				timer.unref?.();
			}
			if (params.options.abortSignal) {
				const onAbort = () => {
					reject(
						toolAbortError(params.toolName, params.options.abortSignal?.reason),
					);
				};
				params.options.abortSignal.addEventListener("abort", onAbort, {
					once: true,
				});
				removeAbortListener = () =>
					params.options.abortSignal?.removeEventListener("abort", onAbort);
			}
		});
		const result = await Promise.race([
			params.run(runSignal),
			timeoutOrAbort,
		]).finally(() => {
			if (timer) clearTimeout(timer);
			removeAbortListener?.();
		});
		// Strip empty/placeholder keys from the payload before it reaches the
		// model — see compactModelPayload above.
		const modelPayload = compactModelPayload(result.modelPayload);
		// Persist a compact digest of what the model received so later turns
		// can replay this call as a native tool result (conversation-history.ts).
		if (result.entry.resultDigest == null) {
			result.entry.resultDigest = deriveToolResultDigest(modelPayload);
		}
		params.recorder.record(result.entry);
		return modelPayload;
	} catch (error) {
		const failure = params.onError(error);
		params.recorder.record(failure.entry);
		return failure.modelPayload;
	}
}

// ── Compact model-facing schemas ─────────────────────────────────
//
// The chat template renders every tool's JSON schema verbatim into the
// prompt, so zod's boilerplate ("$schema", additionalProperties:false,
// minLength:1, the 2^53 integer ceiling) costs real tokens on every turn.
// The model is shown a trimmed copy; validation still runs the full zod
// schema, so nothing is accepted that was not accepted before.

const NOISE_KEYS = new Set(["$schema", "additionalProperties"]);

function compactJsonSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(compactJsonSchema);
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (NOISE_KEYS.has(key)) continue;
		if (key === "minLength" && entry === 1) continue;
		if (key === "maximum" && entry === 9007199254740991) continue;
		if (key === "minimum" && entry === -9007199254740991) continue;
		out[key] = compactJsonSchema(entry);
	}
	return out;
}

export function compactToolInputSchema<T>(
	schema: z.ZodType<T>,
	shown: z.ZodType | JSONSchema7 = schema,
): ReturnType<typeof jsonSchema<T>> {
	const full = shown instanceof z.ZodType ? asSchema(shown).jsonSchema : shown;
	return jsonSchema<T>(compactJsonSchema(full) as JSONSchema7, {
		validate: (value) => {
			const parsed = schema.safeParse(value);
			return parsed.success
				? { success: true, value: parsed.data }
				: { success: false, error: parsed.error };
		},
	});
}
