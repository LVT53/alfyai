// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import {
	MODEL_MATRIX,
	assertGuard,
	assertKnownAnswer,
	assertOrdinary,
	buildAuditSql,
	createClient,
	createStreamProbe,
	inspectAudit,
	main,
	runCase,
	runSerial,
	syntheticPlan,
	validateTarget,
} from "../../docs/plans/turn-completion/contract/verify-contract.mjs";

const completion = {
	version: 1,
	turnId: "turn-1",
	segmentId: "seg-1",
	phase: "working",
	outcome: "answered",
	stopCause: "natural_stop",
	workingStopCause: "natural_stop",
	closingAttempted: false,
};
const ordinary = () => ({
	status: 200,
	terminal: true,
	answer: "PRODUCT=391",
	completion,
	modelId: MODEL_MATRIX.deepseek,
	errors: [],
	tools: [{ callId: "call-1", name: "run_python", status: "done" }],
});

describe("staging acceptance oracles", () => {
	test("known math checks reject a fluent incorrect answer and conflicting values", () => {
		expect(() =>
			assertKnownAnswer("PRODUCT=391", { PRODUCT: "391" }),
		).not.toThrow();
		expect(() =>
			assertKnownAnswer(
				"The job is complete with a very detailed answer. PRODUCT=390",
				{ PRODUCT: "391" },
			),
		).toThrow(/PRODUCT/);
		expect(() =>
			assertKnownAnswer("PRODUCT=391\nPRODUCT=390", { PRODUCT: "391" }),
		).toThrow(/PRODUCT/);
	});
	test("full evidence oracle requires exact tail facts, not a key somewhere in a quote", () => {
		const wanted = { ARCHIVE: "ORCHID-73", DISPATCH: "Tuesday", TOTAL: "42" };
		expect(() =>
			assertKnownAnswer(
				"ARCHIVE=ORCHID-73\nDISPATCH=Tuesday\nTOTAL=42",
				wanted,
			),
		).not.toThrow();
		expect(() =>
			assertKnownAnswer(
				"The quote says ORCHID-73, but ARCHIVE=UNKNOWN\nDISPATCH=Tuesday\nTOTAL=42",
				wanted,
			),
		).toThrow(/ARCHIVE/);
		expect(() =>
			assertKnownAnswer("ARCHIVE=ORCHID-73\nDISPATCH=Monday\nTOTAL=42", wanted),
		).toThrow(/DISPATCH/);
	});
	test("ordinary success requires semantic, structural, tool and model agreement", () => {
		expect(() =>
			assertOrdinary(
				ordinary(),
				{ PRODUCT: "391" },
				MODEL_MATRIX.deepseek,
				"run_python",
			),
		).not.toThrow();
		for (const patch of [
			{ answer: "PRODUCT=390" },
			{ completion: { ...completion, outcome: "incomplete" } },
			{ modelId: MODEL_MATRIX.kimi },
			{ tools: [] },
			{
				tools: [
					{
						callId: "call-1",
						name: "run_python",
						status: "done",
						metadata: { ok: false },
					},
				],
			},
			{ terminal: false },
			{ errors: ["failure"] },
		]) {
			expect(() =>
				assertOrdinary(
					{ ...ordinary(), ...patch },
					{ PRODUCT: "391" },
					MODEL_MATRIX.deepseek,
					"run_python",
				),
			).toThrow();
		}
	});
	test("artifact-only success requires an independently verified durable output", () => {
		const delivered = {
			...ordinary(),
			answer: "",
			completion: { ...completion, outcome: "delivered" },
		};
		expect(() =>
			assertOrdinary(delivered, {}, MODEL_MATRIX.deepseek, "run_python"),
		).toThrow();
		expect(() =>
			assertOrdinary(delivered, {}, MODEL_MATRIX.deepseek, "run_python", true),
		).not.toThrow();
		expect(() =>
			assertOrdinary(
				{ ...delivered, completion },
				{},
				MODEL_MATRIX.deepseek,
				"run_python",
				true,
			),
		).toThrow();
	});
	test("an intentional blank is a guard outcome, never ordinary success", () => {
		const blank = {
			...ordinary(),
			answer: "",
			completion: { ...completion, outcome: "incomplete" },
		};
		expect(assertGuard(blank)).toBe("expected-explicit-failure");
		expect(() => assertGuard({ ...blank, completion })).toThrow();
		expect(() => assertOrdinary(blank, {}, MODEL_MATRIX.deepseek)).toThrow();
		expect(() => assertGuard({ ...blank, terminal: false })).toThrow();
	});
});

describe("structural SSE projection", () => {
	test("working commentary cannot corrupt a final heading; replay is idempotent", () => {
		const probe = createStreamProbe();
		const scope = {
			version: 1,
			turnId: "turn-1",
			segmentId: "seg-1",
			attemptId: "a1",
			stepId: "s1",
			phase: "working",
		};
		const event = (sequence: number, fields: Record<string, unknown>) => ({
			type: "data-normal-chat-output",
			data: { ...scope, sequence, ...fields },
		});
		const events = [
			event(1, {
				type: "block_start",
				blockId: "b1",
				nativeId: "0",
				kind: "text",
				role: "provisional",
			}),
			event(2, {
				type: "block_delta",
				blockId: "b1",
				text: "Hello. Let me check.",
			}),
			event(3, {
				type: "step_settled",
				role: "activity",
				finishReason: "tool-calls",
			}),
			event(4, {
				type: "block_start",
				stepId: "s2",
				blockId: "b2",
				nativeId: "0",
				kind: "text",
				role: "provisional",
			}),
			event(5, {
				type: "block_delta",
				stepId: "s2",
				blockId: "b2",
				text: "## Result\n\nPRODUCT=391",
			}),
			event(6, {
				type: "step_settled",
				stepId: "s2",
				role: "answer",
				finishReason: "stop",
			}),
			event(7, { type: "completion", completion }),
		];
		for (const part of [...events, ...events]) probe.part(part);
		probe.part({ type: "finish", finishReason: "stop" });
		expect(probe.result().answer).toBe("## Result\n\nPRODUCT=391");
		expect(probe.result().activity).toEqual(["Hello. Let me check."]);
		expect(probe.result().completion).toEqual(completion);
	});
	test("transport ending without role settlement never promotes provisional text", () => {
		const probe = createStreamProbe();
		const scope = {
			version: 1,
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "step",
			phase: "working",
		};
		probe.part({
			type: "data-normal-chat-output",
			data: {
				...scope,
				sequence: 1,
				type: "block_start",
				blockId: "b",
				nativeId: "0",
				kind: "text",
				role: "provisional",
			},
		});
		probe.part({
			type: "data-normal-chat-output",
			data: {
				...scope,
				sequence: 2,
				type: "block_delta",
				blockId: "b",
				text: "PRODUCT=391",
			},
		});
		expect(probe.result().answer).toBe("");
		expect(probe.result().terminal).toBe(false);
	});
});

describe("bounded audit and serial execution", () => {
	test("SQL is limited to generated conversation and exact turn/message IDs", () => {
		const sql = buildAuditSql([
			{
				conversationId: "conv'1",
				turnId: "turn-1",
				assistantMessageId: "msg-1",
			},
		]);
		expect(sql).toContain("normal_chat_turns");
		expect(sql).toContain("normal_chat_attempts");
		expect(sql).toContain("conv''1");
		expect(sql).toContain("turn-1");
		expect(() => buildAuditSql([{ conversationId: "conv" }])).toThrow(
			/identity/,
		);
		expect(() => buildAuditSql([])).toThrow();
	});
	test("audit requires unique terminal segments, exact attempt manifests and known costs", () => {
		const turns = [
			{
				segment_id: "seg-1",
				turn_id: "turn-1",
				conversation_id: "conv-1",
				message_id: "msg-1",
				outcome: "answered",
				accounting_status: "ready",
				attempt_ids_json: '["a1"]',
			},
		];
		const attempts = [
			{
				attempt_id: "a1",
				segment_id: "seg-1",
				usage_final: 1,
				input_tokens: 31,
				output_tokens: 13,
				total_tokens: 44,
				cost_usd_micros: 88,
				model_id: MODEL_MATRIX.deepseek,
			},
		];
		const ids = [
			{
				conversationId: "conv-1",
				turnId: "turn-1",
				assistantMessageId: "msg-1",
			},
		];
		expect(inspectAudit({ turns, attempts }, ids).costUsdMicros).toBe(88);
		expect(() => inspectAudit({ turns, attempts: [] }, ids)).toThrow();
		expect(() =>
			inspectAudit({ turns, attempts: [...attempts, ...attempts] }, ids),
		).toThrow();
		expect(() =>
			inspectAudit(
				{ turns, attempts: [{ ...attempts[0], cost_usd_micros: null }] },
				ids,
			),
		).toThrow();
		expect(() =>
			inspectAudit(
				{ turns: [{ ...turns[0], conversation_id: "owner-data" }], attempts },
				ids,
			),
		).toThrow();
	});
	test("first failure persists its partial record and prevents the next model call", async () => {
		const run = vi.fn(async (item: number) => {
			if (item === 2) throw new Error("known answer mismatch");
			return { id: item };
		});
		const persist = vi.fn();
		const report = await runSerial([1, 2, 3], run, persist);
		expect(run.mock.calls.map(([item]) => item)).toEqual([1, 2]);
		expect(report.status).toBe("failed");
		expect(report.results).toHaveLength(2);
		expect(persist.mock.calls.at(-1)?.[0]).toEqual(report);
	});
	test("targets require explicit staging execution; DeepSeek pro is not selectable", () => {
		expect(() =>
			validateTarget({ base: "https://ai.alfydesign.com", execute: true }),
		).toThrow();
		expect(() =>
			validateTarget({ base: "http://127.0.0.1:3002", execute: false }),
		).toThrow();
		expect(() =>
			validateTarget({ base: "https://ai.dev.alfydesign.com", execute: true }),
		).not.toThrow();
		expect(Object.keys(MODEL_MATRIX)).toEqual(["deepseek", "kimi", "qwen"]);
	});
});

describe("offline HTTP orchestration", () => {
	test("plain parity asserts direct completion and retains exact durable audit identity", async () => {
		let reads = 0;
		const client = {
			json: vi.fn(async (path: string) => {
				if (path === "/api/chat/send")
					return { response: { text: "PRODUCT=391" }, completion };
				if (path.endsWith("/usage"))
					return { status: "ready", costUsd: 0.000088 };
				return {
					messages: reads++
						? [
								{
									id: "m1",
									role: "assistant",
									content: "PRODUCT=391",
									modelId: MODEL_MATRIX.deepseek,
									thinkingSegments: [
										{ type: "tool_call", name: "run_python", status: "done" },
									],
								},
							]
						: [],
				};
			}),
		};
		const record = { conversationId: "synthetic-c1", streamId: "synthetic-s1" };
		const spec = syntheticPlan("unit").find(
			(s: { key: string }) => s.key === "plain-math",
		);
		const result = await runCase(client, spec, MODEL_MATRIX.deepseek, record);
		expect(result.answer).toBe("PRODUCT=391");
		expect(result.assistantMessageId).toBe("m1");
		expect(result.costUsdMicros).toBe(88);
		expect(result.allowedOutcomes).toEqual(["answered", "delivered"]);
		expect(result.completion).toEqual(completion);
		expect(result.turnId).toBe("turn-1");
		expect(result.segmentId).toBe("seg-1");
		expect(result.outcome).toBe("answered");
		expect(result.warning).toBeUndefined();
		expect(result.auditRequired).toBe(true);
	});
	function plainClient(receipt: unknown, warning?: unknown) {
		let reads = 0;
		return {
			json: vi.fn(async (path: string) => {
				if (path === "/api/chat/send")
					return {
						response: { text: "PRODUCT=391" },
						completion: receipt,
						warning,
					};
				if (path.endsWith("/usage"))
					return { status: "ready", costUsd: 0.000088 };
				return {
					messages: reads++
						? [
								{
									id: "m1",
									role: "assistant",
									content: "PRODUCT=391",
									modelId: MODEL_MATRIX.deepseek,
									thinkingSegments: [
										{ type: "tool_call", name: "run_python", status: "done" },
									],
								},
							]
						: [],
				};
			}),
		};
	}
	const plainSpec = () =>
		syntheticPlan("unit").find((s: { key: string }) => s.key === "plain-math");
	test.each([
		["missing", undefined],
		["wrong version", { ...completion, version: 2 }],
		["missing identity", { ...completion, segmentId: "" }],
	])("plain known text cannot replace %s completion", async (_name, receipt) => {
		await expect(
			runCase(plainClient(receipt), plainSpec(), MODEL_MATRIX.deepseek, {
				conversationId: "synthetic-c1",
				streamId: "synthetic-s1",
			}),
		).rejects.toThrow(/Plain completion/);
	});
	test.each([
		"incomplete",
		"failed",
		"stopped",
	])("plain %s with a matching warning never passes ordinary known-answer acceptance", async (outcome) => {
		const receipt = { ...completion, outcome, stopCause: "length" };
		const warning = {
			code: "normal_chat_completion",
			outcome,
			stopCause: "length",
		};
		const record: Record<string, unknown> = {
			conversationId: "synthetic-c1",
			streamId: "synthetic-s1",
		};
		await expect(
			runCase(
				plainClient(receipt, warning),
				plainSpec(),
				MODEL_MATRIX.deepseek,
				record,
			),
		).rejects.toThrow(/not answered/);
		expect(record.completion).toEqual(receipt);
		expect(record.warning).toEqual(warning);
		expect(record.segmentId).toBe("seg-1");
		expect(record.auditRequired).toBe(true);
	});
	test.each([
		undefined,
		{ code: "other", outcome: "incomplete", stopCause: "length" },
		{ code: "normal_chat_completion", outcome: "failed", stopCause: "length" },
		{
			code: "normal_chat_completion",
			outcome: "incomplete",
			stopCause: "natural_stop",
		},
	])("plain incomplete receipt requires its exact additive warning (%j)", async (warning) => {
		await expect(
			runCase(
				plainClient(
					{ ...completion, outcome: "incomplete", stopCause: "length" },
					warning,
				),
				plainSpec(),
				MODEL_MATRIX.deepseek,
				{ conversationId: "synthetic-c1", streamId: "synthetic-s1" },
			),
		).rejects.toThrow(/Plain warning/);
	});
	test("plain successful completion rejects a contradictory warning", async () => {
		await expect(
			runCase(
				plainClient(completion, {
					code: "normal_chat_completion",
					outcome: "incomplete",
					stopCause: "length",
				}),
				plainSpec(),
				MODEL_MATRIX.deepseek,
				{ conversationId: "synthetic-c1", streamId: "synthetic-s1" },
			),
		).rejects.toThrow(/Plain warning/);
	});
	test("real stream-consumer path rejects legacy text-only success without published roles", async () => {
		const payload = [
			{ type: "text-delta", id: "answer", delta: "PRODUCT=391" },
			{
				type: "data-stream-metadata",
				data: { modelId: MODEL_MATRIX.deepseek },
			},
			{ type: "finish", finishReason: "stop" },
		];
		const client = {
			json: vi.fn(async () => ({ messages: [] })),
			request: vi.fn(
				async () =>
					new Response(
						payload.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("") +
							"data: [DONE]\n\n",
					),
			),
		};
		await expect(
			runCase(client, syntheticPlan("unit")[0], MODEL_MATRIX.deepseek, {
				conversationId: "synthetic-c1",
				streamId: "synthetic-s1",
			}),
		).rejects.toThrow(/not answered/);
		expect(client.request).toHaveBeenCalledOnce();
	});
	test("quiet control traverses SSE and explicitly records failure without pretending it answered", async () => {
		const c = { ...completion, outcome: "incomplete", stopCause: "length" };
		const scope = {
			version: 1,
			turnId: "turn-1",
			segmentId: "seg-1",
			attemptId: "a1",
			stepId: "s1",
			phase: "working",
			sequence: 1,
		};
		const payload = [
			{
				type: "data-normal-chat-output",
				data: { ...scope, type: "completion", completion: c },
			},
			{
				type: "data-stream-metadata",
				data: { modelId: MODEL_MATRIX.deepseek },
			},
			{ type: "finish", finishReason: "length" },
		];
		const client = {
			json: vi.fn(async () => ({ messages: [] })),
			request: vi.fn(
				async () =>
					new Response(
						payload.map((p) => `data: ${JSON.stringify(p)}\n\n`).join(""),
					),
			),
		};
		const result = await runCase(
			client,
			{ guard: true, prompt: "Synthetic quiet control." },
			MODEL_MATRIX.deepseek,
			{ conversationId: "synthetic-c1", streamId: "synthetic-s1" },
		);
		expect(result.control).toBe("expected-explicit-failure");
		expect(result.outcome).toBe("incomplete");
		expect(result.answer).toBe("");
	});
	test("HTTP client refuses redirects and keeps login cookies out of payloads", async () => {
		const transport = vi.fn(
			async () =>
				new Response("{}", {
					headers: { "Set-Cookie": "session=synthetic-cookie; HttpOnly" },
				}),
		);
		const client = createClient({
			base: "http://synthetic.invalid",
			origin: "http://synthetic.invalid",
			fetchImpl: transport,
		});
		await client.json("/api/auth/login", {
			email: "synthetic@example.invalid",
			password: "synthetic-only",
		});
		await client.json("/api/conversations/synthetic-c1");
		expect(transport.mock.calls[1]?.[1]).toMatchObject({
			headers: { cookie: "session=synthetic-cookie" },
			redirect: "error",
		});
	});
	test("unknown CLI options and a bad family cannot trigger remote calls", async () => {
		await expect(main(["--model", "deepseek-pro"])).rejects.toThrow(/Unknown/);
	});
});
