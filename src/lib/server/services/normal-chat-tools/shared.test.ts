import { asSchema } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { ToolCallRefusedError } from "$lib/server/utils/tool-refusal";
import { TurnDeadlineReason } from "$lib/server/utils/turn-deadline-reason";
import { estimateTokenCount } from "$lib/utils/tokens";
import { bindReadResultGrant } from "./model-payload-budget";
import {
	compactModelPayload,
	compactToolInputSchema,
	createToolCallRecorder,
	executeToolWithEnvelope,
	isInsideToolCall,
	markCallLocallyDistilled,
	reasonCodeOf,
	type ToolCallRecorder,
	withReasonCode,
	withToolExecutionFact,
} from "./shared";
import { stableStringify } from "./stable-stringify";

describe("compactModelPayload", () => {
	it("drops undefined, null, empty string, empty array and empty object values", () => {
		expect(
			compactModelPayload({
				a: undefined,
				b: null,
				c: "",
				d: [],
				e: {},
				f: "kept",
				g: 0,
				h: false,
			}),
		).toEqual({ f: "kept", g: 0, h: false });
	});

	it("never drops the protected envelope keys even when empty/falsy", () => {
		expect(
			compactModelPayload({
				success: false,
				name: "",
				action: "",
				message: "",
				mode: "",
				sourceType: "",
			}),
		).toEqual({
			success: false,
			name: "",
			action: "",
			message: "",
			mode: "",
			sourceType: "",
		});
	});

	it("recurses exactly one level into a nested plain object", () => {
		expect(
			compactModelPayload({
				answerBrief: { sourceCount: 2, evidenceCount: 0, note: "" },
			}),
		).toEqual({ answerBrief: { sourceCount: 2, evidenceCount: 0 } });
	});

	it("drops a nested object entirely once compaction leaves it empty", () => {
		expect(
			compactModelPayload({
				answerBrief: { note: "", other: null },
				kept: "value",
			}),
		).toEqual({ kept: "value" });
	});

	it("does not descend a second level (a grandchild object is left as-is)", () => {
		const payload = compactModelPayload({
			outer: { inner: { note: "", value: 1 } },
		});
		expect(payload).toEqual({ outer: { inner: { note: "", value: 1 } } });
	});

	it("leaves array items untouched (arrays are not recursed into)", () => {
		const payload = compactModelPayload({
			items: [{ note: "", value: 1 }, { value: 2 }],
		});
		expect(payload).toEqual({
			items: [{ note: "", value: 1 }, { value: 2 }],
		});
	});

	it("passes non-record payloads through unchanged", () => {
		expect(compactModelPayload("a string" as unknown)).toBe("a string");
		expect(compactModelPayload(null as unknown)).toBe(null);
		expect(compactModelPayload([1, 2, 3] as unknown)).toEqual([1, 2, 3]);
	});

	it("is idempotent — compacting an already-compacted payload changes nothing", () => {
		const once = compactModelPayload({
			success: true,
			name: "research_web",
			answerBrief: { sourceCount: 1, note: "" },
			empty: [],
		});
		const twice = compactModelPayload(once);
		expect(twice).toEqual(once);
	});
});

// The compact-schema change shows the model a trimmed JSON schema while
// keeping the full zod schema as the validator. Both halves of that claim
// need holding: the trimmed schema must not drop anything the model needs in
// order to call the tool correctly, and validation must still reject exactly
// what zod rejected before it was trimmed.
describe("withReasonCode", () => {
	it("serializes a tagged payload exactly as before and gives its code back", () => {
		const payload = { success: false, message: "Calendar is not connected." };
		const before = JSON.stringify(payload);
		const tagged = withReasonCode(payload, "not_connected");
		expect(tagged).toBe(payload);
		expect(JSON.stringify(tagged)).toBe(before);
		expect(stableStringify(tagged)).toBe(stableStringify({ ...payload }));
		expect(Object.keys(tagged)).toEqual(["success", "message"]);
		expect(reasonCodeOf(payload)).toBe("not_connected");
		expect(reasonCodeOf({})).toBeUndefined();
	});

	it("tags the one object it was given, not an equal copy", () => {
		const payload = { ok: false };
		withReasonCode(payload, "item_not_found");
		expect(reasonCodeOf({ ok: false })).toBeUndefined();
		expect(reasonCodeOf({ ...payload })).toBeUndefined();
	});

	it("reads nothing from a value that is not an object", () => {
		expect(reasonCodeOf(undefined)).toBeUndefined();
		expect(reasonCodeOf(null)).toBeUndefined();
		expect(reasonCodeOf("not_connected")).toBeUndefined();
		expect(reasonCodeOf(7)).toBeUndefined();
	});
});

describe("compactToolInputSchema", () => {
	const schema = z.object({
		query: z.string().min(1),
		readPages: z.number().int().min(0).max(2).optional(),
		mode: z.enum(["fast", "deep"]).optional(),
	});

	type ShownSchema = {
		type?: string;
		required?: string[];
		properties?: Record<string, Record<string, unknown>>;
		additionalProperties?: unknown;
		$schema?: unknown;
	};

	function shownSchemaOf(
		compact: ReturnType<typeof compactToolInputSchema>,
	): ShownSchema {
		return asSchema(compact).jsonSchema as ShownSchema;
	}

	it("keeps the model-facing shape: every property, the required list, and enums", () => {
		const shown = shownSchemaOf(compactToolInputSchema(schema));

		expect(shown.type).toBe("object");
		expect(Object.keys(shown.properties ?? {}).sort()).toEqual([
			"mode",
			"query",
			"readPages",
		]);
		expect(shown.required).toEqual(["query"]);
		expect(shown.properties?.mode.enum).toEqual(["fast", "deep"]);
		// Real bounds a model has to respect survive the trim; only zod's
		// boilerplate (the 2^53 integer ceiling, minLength:1) is dropped.
		expect(shown.properties?.readPages.minimum).toBe(0);
		expect(shown.properties?.readPages.maximum).toBe(2);
	});

	it("strips only the token-wasting boilerplate", () => {
		const shown = shownSchemaOf(compactToolInputSchema(schema));

		expect(shown.$schema).toBeUndefined();
		expect(shown.additionalProperties).toBeUndefined();
		expect(shown.properties?.query.minLength).toBeUndefined();
	});

	it("still validates through the full zod schema, accepting what zod accepts", () => {
		const { validate } = asSchema(compactToolInputSchema(schema));
		expect(validate).toBeDefined();

		expect(validate?.({ query: "prices", readPages: 2 })).toMatchObject({
			success: true,
			value: { query: "prices", readPages: 2 },
		});
	});

	it("still rejects exactly what zod rejects, including bounds the shown schema no longer spells out", () => {
		const { validate } = asSchema(compactToolInputSchema(schema));

		const invalidInputs = [
			{ query: "" }, // minLength:1 is trimmed from the SHOWN schema only
			{ readPages: 1 }, // required `query` missing
			{ query: "x", readPages: 3 }, // above max
			{ query: "x", readPages: 1.5 }, // not an integer
			{ query: "x", mode: "sideways" }, // outside the enum
		];
		for (const invalid of invalidInputs) {
			expect(validate?.(invalid)).toMatchObject({ success: false });
		}
	});

	it("validates against the zod schema even when a different schema is shown", () => {
		// map_route shows a hand-written JSON schema in place of zod's
		// five-times-repeated place union; the validator must stay the zod one.
		const compact = compactToolInputSchema(schema, {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		});
		const shown = shownSchemaOf(compact);
		const { validate } = asSchema(compact);

		expect(Object.keys(shown.properties ?? {})).toEqual(["query"]);
		// Never described to the model here, but still enforced.
		expect(validate?.({ query: "x", readPages: 9 })).toMatchObject({
			success: false,
		});
	});
});

// Gap 1: activity_events.duration_ms is always NULL in production because
// nothing threads the envelope's own start→settle timing into the
// ToolCallEntry it records. executeToolWithEnvelope already wraps every call
// in a single Promise.race for timeout/abort; it should stamp
// entry.metadata.durationMs from that same wrapper instead of a second,
// independent timer living elsewhere.
describe("executeToolWithEnvelope duration recording", () => {
	function baseEntry(status: ToolCallEntry["status"]): ToolCallEntry {
		return { name: "test_tool", input: {}, status };
	}

	it("records elapsed wall-clock time on success", async () => {
		const recorder = createToolCallRecorder();
		const DELAY_MS = 40;

		await executeToolWithEnvelope({
			toolName: "test_tool",
			timeoutMs: 5_000,
			options: { toolCallId: "1", abortSignal: undefined },
			recorder,
			run: async () => {
				await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
				return {
					modelPayload: { success: true },
					entry: baseEntry("done"),
				};
			},
			onError: () => ({
				modelPayload: { success: false },
				entry: baseEntry("failed"),
			}),
		});

		const [entry] = recorder.getEntries();
		expect(typeof entry.metadata?.durationMs).toBe("number");
		// Real wall-clock timing under test-runner load can run a little fast
		// or slow; assert it's in the right ballpark rather than exact.
		expect(entry.metadata?.durationMs as number).toBeGreaterThanOrEqual(
			DELAY_MS - 15,
		);
	});

	it("records a duration for a failing tool call", async () => {
		const recorder = createToolCallRecorder();

		await executeToolWithEnvelope({
			toolName: "test_tool",
			timeoutMs: 5_000,
			options: { toolCallId: "1", abortSignal: undefined },
			recorder,
			run: async () => {
				throw new Error("boom");
			},
			onError: () => ({
				modelPayload: { success: false, message: "boom" },
				entry: baseEntry("failed"),
			}),
		});

		const [entry] = recorder.getEntries();
		expect(typeof entry.metadata?.durationMs).toBe("number");
		expect(entry.metadata?.durationMs as number).toBeGreaterThanOrEqual(0);
	});

	it("records a duration for a timed-out tool call", async () => {
		const recorder = createToolCallRecorder();

		await executeToolWithEnvelope({
			toolName: "test_tool",
			timeoutMs: 20,
			options: { toolCallId: "1", abortSignal: undefined },
			recorder,
			run: async () => {
				await new Promise((resolve) => setTimeout(resolve, 5_000));
				return { modelPayload: { success: true }, entry: baseEntry("done") };
			},
			onError: () => ({
				modelPayload: { success: false, message: "timed out" },
				entry: baseEntry("failed"),
			}),
		});

		const [entry] = recorder.getEntries();
		expect(typeof entry.metadata?.durationMs).toBe("number");
		expect(entry.metadata?.durationMs as number).toBeGreaterThanOrEqual(0);
		expect(entry.metadata?.durationMs as number).toBeLessThan(1_000);
	});

	it("records a small (not skipped) duration for a cache-hit result that resolves instantly", async () => {
		const recorder = createToolCallRecorder();

		await executeToolWithEnvelope({
			toolName: "test_tool",
			timeoutMs: 5_000,
			options: { toolCallId: "1", abortSignal: undefined },
			recorder,
			run: async () => {
				const entry = baseEntry("done");
				entry.metadata = { cached: true };
				return { modelPayload: { success: true }, entry };
			},
			onError: () => ({
				modelPayload: { success: false },
				entry: baseEntry("failed"),
			}),
		});

		const [entry] = recorder.getEntries();
		expect(entry.metadata?.cached).toBe(true);
		expect(typeof entry.metadata?.durationMs).toBe("number");
		expect(entry.metadata?.durationMs as number).toBeGreaterThanOrEqual(0);
	});

	it("does not overwrite a duration the tool already measured itself", async () => {
		const recorder = createToolCallRecorder();

		await executeToolWithEnvelope({
			toolName: "test_tool",
			timeoutMs: 5_000,
			options: { toolCallId: "1", abortSignal: undefined },
			recorder,
			run: async () => {
				const entry = baseEntry("done");
				entry.metadata = { durationMs: 999 };
				return { modelPayload: { success: true }, entry };
			},
			onError: () => ({
				modelPayload: { success: false },
				entry: baseEntry("failed"),
			}),
		});

		const [entry] = recorder.getEntries();
		expect(entry.metadata?.durationMs).toBe(999);
	});
});

// A recorder may ask to see what the model was handed, not only what was
// recorded: the address check of docs/plans/exfil-channels needs every address in
// every result the model reads, and the envelope is the one place all of them
// pass. The observation is of SUCCESS only (an error's text can echo the model's
// own input), sees the payload as the model receives it, and happens before the
// call is recorded, so whatever it writes is in place before any event about the
// call reaches the browser.
describe("executeToolWithEnvelope result observation", () => {
	function baseEntry(status: ToolCallEntry["status"]): ToolCallEntry {
		return { name: "test_tool", input: { q: "asked" }, status };
	}

	function observingRecorder(order: string[]) {
		const seen: Array<{
			toolName: string;
			payload: unknown;
			entry: ToolCallEntry;
		}> = [];
		const base = createToolCallRecorder();
		const recorder: ToolCallRecorder = {
			record(entry) {
				order.push("record");
				return base.record(entry);
			},
			getEntries: () => base.getEntries(),
			observeResult(result) {
				order.push("observe");
				seen.push(result);
			},
		};
		return { recorder, seen };
	}

	it("hands the recorder the compacted payload and the entry, before the entry is recorded", async () => {
		const order: string[] = [];
		const { recorder, seen } = observingRecorder(order);

		const returned = await executeToolWithEnvelope({
			toolName: "test_tool",
			timeoutMs: 5_000,
			options: { toolCallId: "1", abortSignal: undefined },
			recorder,
			run: async () => ({
				modelPayload: {
					success: true,
					note: "",
					links: ["https://a.example/"],
				},
				entry: baseEntry("done"),
			}),
			onError: () => ({
				modelPayload: { success: false },
				entry: baseEntry("failed"),
			}),
		});

		expect(order).toEqual(["observe", "record"]);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.toolName).toBe("test_tool");
		// The payload as the model receives it: compacted, empty keys gone.
		expect(seen[0]?.payload).toEqual({
			success: true,
			links: ["https://a.example/"],
		});
		expect(seen[0]?.payload).toEqual(returned);
		expect(seen[0]?.entry.input).toEqual({ q: "asked" });
	});

	it("does not hand it the payload of a call that failed", async () => {
		const order: string[] = [];
		const { recorder, seen } = observingRecorder(order);

		await executeToolWithEnvelope({
			toolName: "test_tool",
			timeoutMs: 5_000,
			options: { toolCallId: "1", abortSignal: undefined },
			recorder,
			run: async () => {
				throw new Error("could not open https://echoed.example/?d=secret");
			},
			onError: (error) => ({
				modelPayload: { success: false, error: String(error) },
				entry: baseEntry("failed"),
			}),
		});

		expect(seen).toEqual([]);
		expect(order).toEqual(["record"]);
	});

	it("is not required of a recorder", async () => {
		const recorder = createToolCallRecorder();

		await expect(
			executeToolWithEnvelope({
				toolName: "test_tool",
				timeoutMs: 5_000,
				options: { toolCallId: "1", abortSignal: undefined },
				recorder,
				run: async () => ({
					modelPayload: { success: true },
					entry: baseEntry("done"),
				}),
				onError: () => ({
					modelPayload: { success: false },
					entry: baseEntry("failed"),
				}),
			}),
		).resolves.toEqual({ success: true });
		expect(recorder.getEntries()).toHaveLength(1);
	});
});

// A connector result a local model summarised for a cloud chat model is that
// model's words, so the turn's address check must not take an address from it
// (ADR-0068). The summary is asked for deep inside a tool, so the call it runs in
// is marked there and the envelope writes the mark on the call's entry, in time
// for the observer that reads it.
describe("executeToolWithEnvelope and a local model's summary", () => {
	const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

	it("marks the call that had a local model summarise its result, and no call beside it", async () => {
		const observed = new Map<string, unknown>();
		const base = createToolCallRecorder();
		const recorder: ToolCallRecorder = {
			record: (entry) => base.record(entry),
			getEntries: () => base.getEntries(),
			observeResult({ entry }) {
				observed.set(entry.callId ?? "", entry.metadata?.localDistilled);
			},
		};
		const call = (callId: string, summarise: boolean) =>
			executeToolWithEnvelope({
				toolName: "test_tool",
				timeoutMs: 5_000,
				options: { toolCallId: callId, abortSignal: undefined },
				recorder,
				run: async () => {
					await pause();
					if (summarise) markCallLocallyDistilled();
					await pause();
					return {
						modelPayload: { success: true },
						entry: {
							callId,
							name: "test_tool",
							input: {},
							status: "done" as const,
							metadata: { ok: true },
						},
					};
				},
				onError: () => ({
					modelPayload: { success: false },
					entry: { callId, name: "test_tool", input: {}, status: "failed" },
				}),
			});

		await Promise.all([call("summarised", true), call("read-whole", false)]);

		const metadata = new Map(
			base.getEntries().map((entry) => [entry.callId, entry.metadata]),
		);
		expect(metadata.get("summarised")).toMatchObject({
			ok: true,
			localDistilled: true,
		});
		expect(metadata.get("read-whole")).not.toHaveProperty("localDistilled");
		expect(observed).toEqual(
			new Map([
				["summarised", true],
				["read-whole", undefined],
			]),
		);
	});

	// ADR-0068: it used to do nothing here, silently, so a connector path added
	// outside the envelope lost the mark without any test failing.
	it("refuses when it is asked outside a tool call: there is no call to carry the mark", () => {
		expect(() => markCallLocallyDistilled()).toThrow(/outside a tool call/);
	});

	it("knows whether a tool call is running", async () => {
		expect(isInsideToolCall()).toBe(false);
		let inside: boolean | undefined;

		await executeToolWithEnvelope({
			toolName: "test_tool",
			timeoutMs: 5_000,
			options: { toolCallId: "1", abortSignal: undefined },
			recorder: createToolCallRecorder(),
			run: async () => {
				inside = isInsideToolCall();
				return {
					modelPayload: { success: true },
					entry: { name: "test_tool", input: {}, status: "done" },
				};
			},
			onError: () => ({
				modelPayload: { success: false },
				entry: { name: "test_tool", input: {}, status: "failed" },
			}),
		});

		expect(inside).toBe(true);
		expect(isInsideToolCall()).toBe(false);
	});
});

it.each([
	"returned",
	"unproven",
	"thrown",
	"aborted",
	"timeout",
] as const)("distinguishes a returned failure from uncertain envelope exits: %s", async (mode) => {
	const recorder = createToolCallRecorder();
	const controller = new AbortController();
	if (mode === "aborted") controller.abort();
	const failure = () => ({
		modelPayload: { ok: false, status: "failed" },
		entry: {
			name: "produce_file",
			callId: "same",
			input: {},
			status: "failed" as const,
		},
	});
	const output = await executeToolWithEnvelope({
		toolName: "produce_file",
		timeoutMs: mode === "timeout" ? 1 : 1000,
		options: { toolCallId: "same", abortSignal: controller.signal },
		recorder,
		run: async () => {
			if (mode === "thrown") throw new Error("unknown outcome");
			if (mode === "timeout") await new Promise(() => {});
			const result = failure();
			if (mode === "returned") withToolExecutionFact(result.entry, "failed");
			return result;
		},
		onError: failure,
	});
	expect(recorder.getExecutionCertainty?.(output)).toBe(
		mode === "returned"
			? "failed"
			: mode === "unproven"
				? undefined
				: "uncertain",
	);
	expect(recorder.getExecutionCertainty?.({ ...output })).toBeUndefined();
	expect(
		createToolCallRecorder().getExecutionCertainty?.(output),
	).toBeUndefined();
});

it("treats an error a tool threw to refuse a call before dispatching anything as a proven non-execution", async () => {
	// A refusal subclass, as FetchUrlRefusedError is: the envelope asks the class.
	class AddressRefusedError extends ToolCallRefusedError {}
	const recorder = createToolCallRecorder();
	const output = await executeToolWithEnvelope<{
		success: boolean;
		error: string;
	}>({
		toolName: "fetch_url",
		timeoutMs: 1000,
		options: { toolCallId: "refused", abortSignal: undefined },
		recorder,
		run: async () => {
			throw new AddressRefusedError("Nothing was fetched.");
		},
		onError: () => ({
			modelPayload: { success: false, error: "Nothing was fetched." },
			entry: {
				name: "fetch_url",
				callId: "refused",
				input: {},
				status: "done" as const,
			},
		}),
	});

	expect(recorder.getExecutionCertainty?.(output)).toBe(
		"definitely_not_executed",
	);
	// The fact is bound to this exact result, as for produce_file's own refusal.
	expect(recorder.getExecutionCertainty?.({ ...output })).toBeUndefined();
	// It is not a field of the recorded row either.
	expect(JSON.stringify(recorder.getEntries())).not.toContain(
		"definitely_not_executed",
	);
});

describe("a tool that says it only reads", () => {
	const failure = () => ({
		modelPayload: { success: false, error: "research_web failed" },
		entry: {
			name: "research_web",
			callId: "reads",
			input: {},
			status: "done" as const,
		},
	});

	it.each([
		"thrown",
		"timeout",
	] as const)("records what it threw as a settled failure, not an uncertain one: %s", async (mode) => {
		const recorder = createToolCallRecorder();
		const output = await executeToolWithEnvelope<{
			success: boolean;
			error: string;
		}>({
			toolName: "research_web",
			timeoutMs: mode === "timeout" ? 1 : 1000,
			options: { toolCallId: "reads", abortSignal: undefined },
			recorder,
			readOnly: true,
			run: async () => {
				if (mode === "timeout") await new Promise(() => {});
				throw new Error("upstream 502");
			},
			onError: failure,
		});

		// Running it again changes nothing, so the call is settled: the engine goes
		// on and the model reads the error. It is not a refusal, the call did go out.
		expect(recorder.getExecutionCertainty?.(output)).toBe("failed");
		expect(recorder.getExecutionCertainty?.({ ...output })).toBeUndefined();
	});

	it("still records a refusal it threw before reading anything as a proven non-execution", async () => {
		const recorder = createToolCallRecorder();
		const output = await executeToolWithEnvelope<{
			success: boolean;
			error: string;
		}>({
			toolName: "fetch_url",
			timeoutMs: 1000,
			options: { toolCallId: "refused", abortSignal: undefined },
			recorder,
			readOnly: true,
			run: async () => {
				throw new ToolCallRefusedError("Nothing was fetched.");
			},
			onError: failure,
		});

		expect(recorder.getExecutionCertainty?.(output)).toBe(
			"definitely_not_executed",
		);
	});

	it("keeps what the turn's own stop cut off uncertain, as it always was", async () => {
		const controller = new AbortController();
		const recorder = createToolCallRecorder();
		const pending = executeToolWithEnvelope<{
			success: boolean;
			error: string;
		}>({
			toolName: "research_web",
			timeoutMs: 1000,
			options: { toolCallId: "stopped", abortSignal: controller.signal },
			recorder,
			readOnly: true,
			run: async () => {
				await new Promise(() => {});
				throw new Error("unreachable");
			},
			onError: failure,
		});
		controller.abort(new Error("user stop"));

		// The wrapper in normal-chat-model/completion-tools.ts marks a call a stop cut
		// off uncertain, and its settle step runs after that and writes whatever fact
		// the recorder holds over it: a stop must not turn into a settled failure.
		expect(recorder.getExecutionCertainty?.(await pending)).toBe("uncertain");
	});

	/** A call that never answers, aborted with `reason`, as the engine's signal aborts one. */
	async function certaintyWhenAbortedWith(
		reason: unknown,
		options: { readOnly?: boolean } = { readOnly: true },
	) {
		const controller = new AbortController();
		const recorder = createToolCallRecorder();
		const pending = executeToolWithEnvelope<{
			success: boolean;
			error: string;
		}>({
			toolName: "research_web",
			timeoutMs: 60_000,
			options: { toolCallId: "cut", abortSignal: controller.signal },
			recorder,
			readOnly: options.readOnly,
			run: async () => {
				await new Promise(() => {});
				throw new Error("unreachable");
			},
			onError: failure,
		});
		controller.abort(reason);
		return recorder.getExecutionCertainty?.(await pending);
	}

	it("records what the engine's working deadline cut off as a settled failure", async () => {
		// The engine's own clock ran out while the search was still running. The
		// search only reads, so running it again changes nothing a person could lose:
		// the call is settled, and the engine can close the turn with what it has.
		expect(await certaintyWhenAbortedWith(new TurnDeadlineReason())).toBe(
			"failed",
		);
	});

	it("keeps what the engine's deadline cut off uncertain for a tool that did not say it only reads", async () => {
		// It may have written before it was cut off, so nothing is known about it.
		expect(await certaintyWhenAbortedWith(new TurnDeadlineReason(), {})).toBe(
			"uncertain",
		);
		expect(
			await certaintyWhenAbortedWith(new TurnDeadlineReason(), {
				readOnly: false,
			}),
		).toBe("uncertain");
	});

	it.each([
		[
			"the person's Stop",
			Object.assign(new Error("The user stopped the turn"), {
				name: "UserStopReason",
			}),
		],
		[
			"the watchdog or a storage failure",
			new Error("The turn's lifetime ended"),
		],
		[
			"the first-output timer",
			new Error("Timed out waiting for first upstream output"),
		],
		["a signal aborted with no reason of its own", undefined],
		["a reason that is not an error", "deadline"],
	])("keeps what %s cut off uncertain: only the engine's own deadline settles it", async (_who, reason) => {
		expect(await certaintyWhenAbortedWith(reason)).toBe("uncertain");
	});

	it("keeps a call uncertain when something else aborted the signal before the deadline did", async () => {
		const stop = new AbortController();
		const deadline = new AbortController();
		const recorder = createToolCallRecorder();
		const pending = executeToolWithEnvelope<{
			success: boolean;
			error: string;
		}>({
			toolName: "research_web",
			timeoutMs: 60_000,
			options: {
				toolCallId: "cut",
				abortSignal: AbortSignal.any([stop.signal, deadline.signal]),
			},
			recorder,
			readOnly: true,
			run: async () => {
				await new Promise(() => {});
				throw new Error("unreachable");
			},
			onError: failure,
		});
		stop.abort(new Error("The user stopped the turn"));
		deadline.abort(new TurnDeadlineReason());

		// A combined signal carries the reason of the source that aborted first.
		expect(recorder.getExecutionCertainty?.(await pending)).toBe("uncertain");
	});

	it("does not mark what it returned: a call that went well has no fact of its own", async () => {
		const recorder = createToolCallRecorder();
		const output = await executeToolWithEnvelope<{ success: boolean }>({
			toolName: "research_web",
			timeoutMs: 1000,
			options: { toolCallId: "fine", abortSignal: undefined },
			recorder,
			readOnly: true,
			run: async () => ({
				modelPayload: { success: true },
				entry: {
					name: "research_web",
					callId: "fine",
					input: {},
					status: "done" as const,
				},
			}),
			onError: failure,
		});

		expect(recorder.getExecutionCertainty?.(output)).toBeUndefined();
	});
});

it("keeps trusted non-execution certainty private and bound to the original result", () => {
	const recorder = createToolCallRecorder();
	const result = { status: "failed", code: "invalid_tool_input" };
	const entry = recorder.record(
		{
			name: "produce_file",
			callId: "reused",
			input: {},
			status: "failed",
			metadata: { intakeStatus: 422 },
		},
		{ state: "definitely_not_executed", result },
	);
	expect(recorder.getExecutionCertainty?.(result)).toBe(
		"definitely_not_executed",
	);
	expect(recorder.getEntries()[0]).toBe(entry);
	expect(recorder.getExecutionCertainty?.({ ...result })).toBeUndefined();
	expect(
		recorder.getExecutionCertainty?.({ state: "definitely_not_executed" }),
	).toBeUndefined();
	expect(
		createToolCallRecorder().getExecutionCertainty?.(result),
	).toBeUndefined();
	expect(JSON.stringify(entry)).not.toContain("definitely_not_executed");
	expect(JSON.stringify(result)).not.toContain("definitely_not_executed");
	const later = { ...result };
	recorder.record({
		...entry,
		metadata: {
			intakeStatus: 422,
			executionCertainty: "definitely_not_executed",
		},
	});
	expect(recorder.getExecutionCertainty?.(later)).toBeUndefined();
});

// Task 2 RED: capability-granted web reads commit one validated view on ALL
// paths. These local run/onError fixtures replace upstream work, not shaping,
// compaction, recording or certainty classification.
describe("Task 2 granted web envelope commit", () => {
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
	const stale = "UNSELECTED_SUCCESS_FACT";
	function entry(): ToolCallEntry {
		return {
			callId: "call",
			name: "research_web",
			input: {},
			status: "done",
			outputSummary: stale,
			candidates: [
				{
					id: "stale",
					title: stale,
					url: "https://omitted.example/",
					snippet: stale,
					sourceType: "web",
					material: true,
				},
			],
			metadata: {
				ok: true,
				evidenceReady: true,
				sourceCount: 1,
				evidenceCount: 1,
			},
			resultDigest: stale,
		};
	}
	function bound(kind: "admitted" | "denied" = "admitted") {
		expect(bindReadResultGrant).toBeTypeOf("function");
		return bindReadResultGrant(
			{ toolCallId: "call", messages: [] },
			kind === "admitted" ? grant : { ...grant, kind, maxPayloadTokens: 0 },
		);
	}

	it("commits the fitting selected view without losing coverage semantics during compaction", async () => {
		const options = bound();
		const base = createToolCallRecorder();
		const observed: unknown[] = [];
		const payload = {
			success: true,
			name: "research_web",
			bounded: true,
			coverage: "full",
			omitted: { sources: 0, evidence: 0, pages: 0 },
			pageRanges: [],
			hint: "Fetched candidate view.",
			sources: [{ id: "p0", url: "https://selected.example/" }],
			evidence: [
				{
					id: "p0e0",
					sourceId: "p0",
					quote: "Selected fact.",
					url: "https://selected.example/",
				},
			],
		};
		const selectedEntry: ToolCallEntry = {
			callId: "call",
			name: "research_web",
			input: {},
			status: "done",
			candidates: [],
			metadata: { ok: true, evidenceReady: true },
		};
		const recorder: ToolCallRecorder = {
			...base,
			observeResult: ({ payload: output, entry: observedEntry }) => {
				expect(observedEntry).toBe(selectedEntry);
				observed.push(output);
			},
		};
		const returned = await executeToolWithEnvelope({
			toolName: "research_web",
			timeoutMs: 5_000,
			readOnly: true,
			options,
			recorder,
			run: async () => ({ modelPayload: payload, entry: selectedEntry }),
			onError: () => {
				throw new Error("A fitting view must commit successfully");
			},
		});
		expect(returned).toEqual(payload);
		expect(observed).toEqual([returned]);
		expect(base.getEntries()).toHaveLength(1);
		expect(estimateTokenCount(stableStringify(returned))).toBeLessThanOrEqual(
			1_200,
		);
	});

	it("denies before run and commits a nonempty refusal using its independent failure allowance", async () => {
		const options = bound("denied");
		let reads = 0;
		const recorder = createToolCallRecorder();
		const returned = await executeToolWithEnvelope({
			toolName: "research_web",
			timeoutMs: 5_000,
			readOnly: true,
			options,
			recorder,
			run: async () => {
				reads++;
				return {
					modelPayload: {
						success: true,
						name: "research_web",
						message: "read",
					},
					entry: entry(),
				};
			},
			onError: () => ({
				modelPayload: {
					success: false,
					name: "research_web",
					message: "arbitrary refusal ".repeat(10_000),
				},
				entry: entry(),
			}),
		});
		expect(reads).toBe(0);
		expect(returned.success).toBe(false);
		expect(estimateTokenCount(stableStringify(returned))).toBeLessThanOrEqual(
			256,
		);
		expect(stableStringify(returned).length).toBeGreaterThan(2);
		expect(recorder.getExecutionCertainty?.(returned)).toBe(
			"definitely_not_executed",
		);
		expect(JSON.stringify(recorder.getEntries())).not.toContain(stale);
		expect(recorder.getEntries()).toHaveLength(1);
	});

	it.each([
		"invalid-success",
		"returned-failure",
		"onError",
	] as const)("replaces %s before observation/recording without stale citation support", async (path) => {
		const options = bound();
		let reads = 0;
		const base = createToolCallRecorder();
		const observed: unknown[] = [];
		const recorder: ToolCallRecorder = {
			...base,
			observeResult: ({ payload }) => {
				observed.push(payload);
			},
		};
		const payload = {
			success: path === "invalid-success",
			name: "research_web",
			bounded: true,
			coverage: "full",
			message: "uncommitted content ".repeat(10_000),
		};
		const returned = await executeToolWithEnvelope({
			toolName: "research_web",
			timeoutMs: 5_000,
			readOnly: true,
			options,
			recorder,
			run: async () => {
				reads++;
				if (path === "onError") throw new Error("upstream failed");
				return { modelPayload: payload, entry: entry() };
			},
			onError: () => ({
				modelPayload: { ...payload, success: false },
				entry: entry(),
			}),
		});
		expect(reads).toBe(1);
		expect(returned).toMatchObject({
			success: false,
			bounded: true,
			coverage: "none",
		});
		expect(estimateTokenCount(stableStringify(returned))).toBeLessThanOrEqual(
			256,
		);
		expect(base.getExecutionCertainty?.(returned)).toBe("failed");
		expect(observed).toEqual([returned]);
		expect(base.getEntries()).toHaveLength(1);
		const committed = base.getEntries()[0];
		expect(committed.callId).toBe("call");
		expect(committed.candidates ?? []).toEqual([]);
		expect(committed.metadata?.evidenceReady).toBe(false);
		expect(JSON.stringify(committed)).not.toContain(stale);
		// Real SDK/capture/wire equality follows after GO; this holds the actual
		// envelope result equal to its observation and JSON semantic view now.
		expect(JSON.parse(JSON.stringify(returned))).toEqual(observed[0]);
	});
});

it("Task 2 replaces a throwing onError with a known failed exact result", async () => {
	const base = createToolCallRecorder();
	const observed: unknown[] = [];
	const options = bindReadResultGrant(
		{ toolCallId: "throwing-error", messages: [] },
		{
			kind: "admitted",
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "step",
			executionId: "e",
			proposalOrdinal: 0,
			maxPayloadTokens: 1200,
			maxFailurePayloadTokens: 256,
		},
	);
	const returned = await executeToolWithEnvelope({
		toolName: "research_web",
		timeoutMs: 5000,
		readOnly: true,
		options,
		recorder: {
			...base,
			observeResult: ({ payload }) => {
				observed.push(payload);
			},
		},
		run: async () => {
			throw new Error("read failed");
		},
		onError: () => {
			throw new Error("error shaping failed");
		},
	});
	expect(returned).toMatchObject({
		success: false,
		bounded: true,
		coverage: "none",
	});
	expect(base.getExecutionCertainty?.(returned)).toBe("failed");
	expect(observed).toEqual([returned]);
	expect(base.getEntries()).toHaveLength(1);
});

it("Task 2 commits no unchecked payload when its denial has no failure allowance", async () => {
	const base = createToolCallRecorder();
	let reads = 0;
	const options = bindReadResultGrant(
		{ toolCallId: "no-failure-room", messages: [] },
		{
			kind: "denied",
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "step",
			executionId: "e",
			proposalOrdinal: 0,
			maxPayloadTokens: 0,
			maxFailurePayloadTokens: 0,
		},
	);
	await expect(
		executeToolWithEnvelope({
			toolName: "research_web",
			timeoutMs: 5000,
			readOnly: true,
			options,
			recorder: base,
			run: async () => {
				reads++;
				return {
					modelPayload: { success: true },
					entry: { name: "research_web", input: {}, status: "done" as const },
				};
			},
			onError: () => ({
				modelPayload: { success: false },
				entry: { name: "research_web", input: {}, status: "failed" as const },
			}),
		}),
	).rejects.toThrow("Web read result capacity exhausted");
	expect(reads).toBe(0);
	expect(base.getEntries()).toEqual([]);
});
