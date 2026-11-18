import type { Tool, ToolExecutionOptions } from "ai";
import { describe, expect, it } from "vitest";

import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	bindReadResultGrant,
	capModelPayload,
	getReadResultGrant,
	markBudgetedReadTool,
	supportsReadResultBudget,
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

// Task 2 RED: a grant is a capability on one exact options object, not SDK
// context data or a tool-name permission that spreads can accidentally copy.
describe("Task 2 opaque read-result grants", () => {
	const grant = {
		kind: "admitted" as const,
		turnId: "t",
		segmentId: "s",
		attemptId: "a",
		stepId: "step",
		executionId: "e",
		proposalOrdinal: 0,
		maxPayloadTokens: 1_200,
		maxFailurePayloadTokens: 256,
	};

	it("binds only the fresh exact options object while preserving every SDK field by identity", () => {
		expect(bindReadResultGrant).toBeTypeOf("function");
		const options: ToolExecutionOptions & { extension: object } = {
			toolCallId: "call",
			messages: [],
			abortSignal: new AbortController().signal,
			experimental_context: Object.freeze({ unrelated: "preserved" }),
			extension: {},
		};
		const supplied = { ...grant };
		const bound = bindReadResultGrant(options, supplied);
		expect(bound).not.toBe(options);
		expect(Reflect.ownKeys(bound)).toEqual(Reflect.ownKeys(options));
		for (const key of Object.keys(options))
			expect(Reflect.get(bound, key)).toBe(Reflect.get(options, key));
		expect(getReadResultGrant(options)).toBeUndefined();
		expect(getReadResultGrant({ ...bound })).toBeUndefined();
		expect(getReadResultGrant(bound)).toMatchObject(grant);
		expect(Object.isFrozen(getReadResultGrant(bound))).toBe(true);
		supplied.maxPayloadTokens = 1;
		expect(getReadResultGrant(bound)?.maxPayloadTokens).toBe(1_200);
	});

	it("opts in the execute function across tool spreads without opting in another same-name tool", () => {
		expect(markBudgetedReadTool).toBeTypeOf("function");
		const original: Tool = { execute: async () => ({ success: true }) };
		expect(supportsReadResultBudget(original)).toBe(false);
		expect(markBudgetedReadTool(original)).toBe(original);
		expect(supportsReadResultBudget({ ...original })).toBe(true);
		expect(
			supportsReadResultBudget({
				...original,
				execute: async () => ({ success: true }),
			}),
		).toBe(false);
	});

	it("retains a denied grant's separate nonzero refusal allowance", () => {
		expect(bindReadResultGrant).toBeTypeOf("function");
		const options = bindReadResultGrant(
			{ toolCallId: "denied", messages: [] },
			{
				...grant,
				kind: "denied",
				maxPayloadTokens: 0,
				maxFailurePayloadTokens: 256,
			},
		);
		expect(getReadResultGrant(options)).toMatchObject({
			kind: "denied",
			maxPayloadTokens: 0,
			maxFailurePayloadTokens: 256,
		});
	});
});

describe("Task 2 engine proposal-order leases", () => {
	it("admits exactly U=h_i+f_i and denies one below without spending its failure reserve", async () => {
		const { createCompletionReadBudget, measureReadResultFraming } =
			await import("../normal-chat-model/completion-tools");
		const { boundedWebReadFailure } = await import("./model-payload-budget");
		const entry = {
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "step",
			executionId: "e",
			toolName: "research_web",
			callId: "c",
			input: {},
		};
		const h = measureReadResultFraming(entry);
		const f = estimate(boundedWebReadFailure("research_web"));
		const pool = createCompletionReadBudget();
		pool.freeze("step", h + f, h + f);
		expect(pool.allocate(entry)).toMatchObject({
			kind: "admitted",
			maxPayloadTokens: f,
			maxFailurePayloadTokens: f,
			proposalOrdinal: 0,
		});
		expect(pool.allocate({ ...entry, executionId: "e2" })).toMatchObject({
			kind: "denied",
			maxPayloadTokens: 0,
			maxFailurePayloadTokens: f,
			proposalOrdinal: 1,
		});
		expect(
			pool.allocate({ ...entry, executionId: "e3" }).maxFailurePayloadTokens,
		).toBe(0);
		const below = createCompletionReadBudget();
		below.freeze("step", h + f - 1, h + f);
		expect(below.allocate(entry)).toMatchObject({
			kind: "denied",
			maxFailurePayloadTokens: f,
		});
	});

	it("keeps leases scoped, frozen and independent of results, with unknown room denied", async () => {
		const { createCompletionReadBudget } = await import(
			"../normal-chat-model/completion-tools"
		);
		const entry = {
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "step",
			executionId: "e",
			toolName: "research_web",
			callId: "c",
			input: {},
		};
		const pool = createCompletionReadBudget();
		pool.freeze("step", 10_000, 1_000);
		const first = pool.allocate(entry);
		const second = pool.allocate({ ...entry, executionId: "e2" });
		expect(first.maxPayloadTokens).toBeGreaterThan(second.maxPayloadTokens);
		pool.freeze("step", 100_000, 100_000); // same step cannot refund/refreeze
		const third = pool.allocate({ ...entry, executionId: "e3" });
		expect(third.maxPayloadTokens).toBeLessThan(second.maxPayloadTokens);
		pool.freeze("next", Number.NaN, 1_000);
		expect(pool.allocate({ ...entry, stepId: "next" })).toMatchObject({
			kind: "denied",
			maxPayloadTokens: 0,
			proposalOrdinal: 0,
		});
	});
});

it("Task 2 total proposal leases plus measured wrappers never exceed the frozen pool", async () => {
	const { createCompletionReadBudget, measureReadResultFraming } = await import(
		"../normal-chat-model/completion-tools"
	);
	const pool = createCompletionReadBudget();
	pool.freeze("step", 10_000, 1_000);
	let charged = 0,
		refusal = 0;
	for (let i = 0; i < 30; i++) {
		const proposal = {
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "step",
			executionId: `e${i}`,
			toolName: "research_web",
			callId: `c${i}`,
			input: {},
		};
		const grant = pool.allocate(proposal);
		if (grant.kind === "admitted")
			charged += measureReadResultFraming(proposal) + grant.maxPayloadTokens;
		else if (grant.maxFailurePayloadTokens > 0)
			refusal +=
				measureReadResultFraming(proposal) + grant.maxFailurePayloadTokens;
		expect(grant.proposalOrdinal).toBe(i);
		expect(charged).toBeLessThanOrEqual(10_000);
		expect(refusal).toBeLessThanOrEqual(1_000);
	}
	expect(pool.exhausted).toBe(true);
});
