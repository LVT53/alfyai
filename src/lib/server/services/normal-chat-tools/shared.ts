import { createHash } from "node:crypto";
import type { ToolExecutionOptions } from "ai";

import type { ToolCallEntry } from "$lib/types";

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
	memory_context: 15_000,
	image_search: 30_000,
	produce_file: 30_000,
	read_generated_file: 10_000,
	files: 20_000,
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
		params.recorder.record(result.entry);
		return result.modelPayload;
	} catch (error) {
		const failure = params.onError(error);
		params.recorder.record(failure.entry);
		return failure.modelPayload;
	}
}
