import { describe, expect, it } from "vitest";

import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	capModelPayload,
	TOOL_RESULT_MAX_TOKENS,
} from "./model-payload-budget";
import {
	createToolCallRecorder,
	executeToolWithEnvelope,
	stableStringify,
	type ToolCallRecorder,
} from "./shared";

// Slice 2 of docs/plans/context-budget-guards-spec.md: the envelope owns a hard
// ceiling. These tests drive the ceiling from the model-facing payload the way
// `executeToolWithEnvelope` does — `compactModelPayload` first, then the cap —
// and measure the result the same way the estimate does: deterministic stable
// serialization plus `estimateTokenCount`.

interface FileResult {
	name: string;
	size: number;
}

interface BudgetedPayload {
	success: boolean;
	name: string;
	action?: string;
	message: string;
	results?: FileResult[];
	citations?: Array<{ title: string; url: string }>;
	// Added by the cap only when a payload is over budget.
	truncated?: boolean;
	hint?: string;
	omitted?: Record<string, number>;
}

function estimate(payload: unknown): number {
	return estimateTokenCount(stableStringify(payload));
}

function fileResults(count: number): FileResult[] {
	return Array.from({ length: count }, (_, index) => ({
		name: `file-${index}.txt`,
		size: index,
	}));
}

function baseEntry(status: ToolCallEntry["status"]): ToolCallEntry {
	return { name: "files", input: { action: "list" }, status };
}

describe("capModelPayload", () => {
	it("returns a payload that already fits by identity", () => {
		const payload: BudgetedPayload = {
			success: true,
			name: "files",
			action: "list",
			message: "Listed 20 files.",
			results: fileResults(20),
		};

		expect(estimate(payload)).toBeLessThanOrEqual(TOOL_RESULT_MAX_TOKENS);
		expect(capModelPayload(payload)).toBe(payload);
	});

	it("honours an explicit maxTokens ceiling", () => {
		const payload: BudgetedPayload = {
			success: true,
			name: "files",
			action: "list",
			message: "Listed 3 files.",
			results: fileResults(3),
		};
		expect(capModelPayload(payload)).toBe(payload);

		const capped = capModelPayload(payload, 5);

		expect(capped).not.toBe(payload);
		expect(capped.truncated).toBe(true);
		expect(capped.results).toHaveLength(0);
		expect(capped.omitted).toEqual({ results: 3 });
		// Even at an impossible ceiling the envelope keys survive.
		expect(capped.success).toBe(true);
		expect(capped.name).toBe("files");
		expect(capped.action).toBe("list");
		expect(capped.message).toBe("Listed 3 files.");
	});

	it("returns non-object payloads by identity", () => {
		const text = "a string";
		expect(capModelPayload(text)).toBe(text);
		expect(capModelPayload(null)).toBe(null);
		expect(capModelPayload(42)).toBe(42);
	});

	it("caps a 3,000-item array under the ceiling and records the drop count", () => {
		const payload: BudgetedPayload = {
			success: true,
			name: "files",
			action: "list",
			message: "Listed 3,000 files.",
			results: fileResults(3_000),
		};
		expect(estimate(payload)).toBeGreaterThan(TOOL_RESULT_MAX_TOKENS);

		const capped = capModelPayload(payload);

		expect(capped).not.toBe(payload);
		expect(capped.truncated).toBe(true);
		expect(capped.hint).toBe(
			"files returned more than one step can carry; narrow the request to see the rest.",
		);
		// The envelope keys are never dropped, however full the payload was.
		expect(capped.success).toBe(true);
		expect(capped.name).toBe("files");
		expect(capped.action).toBe("list");
		expect(capped.message).toBe("Listed 3,000 files.");

		const kept = capped.results?.length ?? 0;
		expect(kept).toBeGreaterThan(0);
		expect(kept).toBeLessThan(3_000);
		expect(capped.omitted).toEqual({ results: 3_000 - kept });
		// Items keep their existing order: no size sorting, no sampling.
		expect(capped.results?.[0]).toEqual({ name: "file-0.txt", size: 0 });
		expect(capped.results?.[kept - 1]).toEqual({
			name: `file-${kept - 1}.txt`,
			size: kept - 1,
		});
		expect(estimate(capped)).toBeLessThanOrEqual(TOOL_RESULT_MAX_TOKENS);
	});

	it("truncates a 1 MB top-level string to 4,000 characters plus an ellipsis", () => {
		const payload: BudgetedPayload = {
			success: true,
			name: "read_generated_file",
			action: "read",
			message: "x".repeat(1024 * 1024),
		};

		const capped = capModelPayload(payload);

		expect(capped).not.toBe(payload);
		expect(capped.message).toHaveLength(4_001);
		expect(capped.message.startsWith("x".repeat(4_000))).toBe(true);
		expect(capped.message.endsWith("…")).toBe(true);
		expect(capped.truncated).toBe(true);
		expect(estimate(capped)).toBeLessThanOrEqual(TOOL_RESULT_MAX_TOKENS);
	});

	it("splits the remaining budget across arrays in key order and records each drop", () => {
		const payload: BudgetedPayload = {
			success: true,
			name: "files",
			message: "Listed files.",
			results: fileResults(2_000),
			citations: Array.from({ length: 2_000 }, (_, index) => ({
				title: `file-${index}.txt`,
				url: `https://example.test/file-${index}.txt`,
			})),
		};
		expect(estimate(payload)).toBeGreaterThan(TOOL_RESULT_MAX_TOKENS);

		const capped = capModelPayload(payload);
		const keptResults = capped.results?.length ?? 0;
		const keptCitations = capped.citations?.length ?? 0;

		expect(keptResults).toBeGreaterThan(0);
		expect(keptResults).toBeLessThan(2_000);
		expect(keptCitations).toBeGreaterThan(0);
		expect(keptCitations).toBeLessThan(2_000);
		expect(capped.omitted).toEqual({
			results: 2_000 - keptResults,
			citations: 2_000 - keptCitations,
		});
		expect(estimate(capped)).toBeLessThanOrEqual(TOOL_RESULT_MAX_TOKENS);
	});

	it("is deterministic: the same payload caps to a deep-equal result", () => {
		const build = (): BudgetedPayload => ({
			success: true,
			name: "files",
			action: "list",
			message: "Listed 3,000 files.",
			results: fileResults(3_000),
		});

		const first = capModelPayload(build());
		const second = capModelPayload(build());

		expect(second).toEqual(first);
		expect(stableStringify(second)).toBe(stableStringify(first));
	});
});

describe("executeToolWithEnvelope's ceiling", () => {
	it("returns and observes the capped payload of a successful call", async () => {
		const base = createToolCallRecorder();
		const observed: Array<{ toolName: string; payload: unknown }> = [];
		const recorder: ToolCallRecorder = {
			record: (entry) => base.record(entry),
			getEntries: () => base.getEntries(),
			observeResult: ({ toolName, payload }) => {
				observed.push({ toolName, payload });
			},
		};

		const returned = await executeToolWithEnvelope<
			BudgetedPayload,
			BudgetedPayload
		>({
			toolName: "files",
			timeoutMs: 5_000,
			options: { toolCallId: "1", abortSignal: undefined },
			recorder,
			run: async () => ({
				modelPayload: {
					success: true,
					name: "files",
					action: "list",
					message: "Listed 3,000 files.",
					results: fileResults(3_000),
				},
				entry: baseEntry("done"),
			}),
			onError: () => ({
				modelPayload: {
					success: false,
					name: "files",
					message: "unused",
				},
				entry: baseEntry("failed"),
			}),
		});

		expect(returned.truncated).toBe(true);
		expect(returned.omitted).toEqual({
			results: 3_000 - (returned.results?.length ?? 0),
		});
		expect(observed).toHaveLength(1);
		expect(observed[0]?.toolName).toBe("files");
		expect(observed[0]?.payload).toBe(returned);
		expect(base.getEntries()[0]?.resultDigest).toContain("Listed 3,000 files.");
	});

	it("leaves a small successful payload free of cap fields", async () => {
		const returned = await executeToolWithEnvelope<
			BudgetedPayload,
			BudgetedPayload
		>({
			toolName: "files",
			timeoutMs: 5_000,
			options: { toolCallId: "1", abortSignal: undefined },
			recorder: createToolCallRecorder(),
			run: async () => ({
				modelPayload: {
					success: true,
					name: "files",
					action: "list",
					message: "Listed 3 files.",
					results: fileResults(3),
				},
				entry: baseEntry("done"),
			}),
			onError: () => ({
				modelPayload: {
					success: false,
					name: "files",
					message: "unused",
				},
				entry: baseEntry("failed"),
			}),
		});

		expect(returned.truncated).toBeUndefined();
		expect(returned.omitted).toBeUndefined();
		expect(returned.results).toHaveLength(3);
	});

	it("leaves the error path alone", async () => {
		const hugeFailure = "x".repeat(1024 * 1024);
		const returned = await executeToolWithEnvelope<
			BudgetedPayload,
			BudgetedPayload
		>({
			toolName: "files",
			timeoutMs: 5_000,
			options: { toolCallId: "1", abortSignal: undefined },
			recorder: createToolCallRecorder(),
			run: async () => {
				throw new Error("boom");
			},
			onError: () => ({
				modelPayload: {
					success: false,
					name: "files",
					message: hugeFailure,
				},
				entry: baseEntry("failed"),
			}),
		});

		expect(returned.message).toBe(hugeFailure);
		expect(returned.truncated).toBeUndefined();
	});
});
