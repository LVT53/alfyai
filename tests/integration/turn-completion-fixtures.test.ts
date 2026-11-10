import assert from "node:assert/strict";
import { expect, test } from "vitest";
import type { PlainNormalChatModelRunResult } from "../../src/lib/server/services/normal-chat-model";
import {
	AI_SMOKE_LATE_CARD_FINAL_ANSWER,
	AI_SMOKE_LATE_CARD_INTRO,
	AI_SMOKE_LATE_CARD_MARKER,
	AI_SMOKE_LATE_CARD_TITLE,
} from "../fixtures/ai/late-card-scenario";
import { completionMessage } from "../fixtures/ai/turn-completion-scenarios";
import { createOpenAICompatibleProviderHarness } from "../mocks/ai-provider/openai-compatible-provider";
import {
	completionMode,
	completionToolsOff,
	turnCompletionReply,
} from "../mocks/ai-provider/turn-completion-scripts";

const tools = [{ type: "function", function: { name: "read_generated_file" } }];
const user = (mode: Parameters<typeof completionMessage>[0]) => ({
	role: "user",
	content: completionMessage(mode),
});
const attempt = { role: "assistant", content: "Hello. Let me check." };

test("a recalled scenario cannot hijack the current turn or auxiliary prompt", () => {
	assert.equal(
		turnCompletionReply({
			tools,
			messages: [
				{
					role: "user",
					content: `${completionMessage("tool")}\n\n## Current User Message\nA different question.\n\n## Instructions\nContinue.`,
				},
			],
		}),
		null,
	);
	assert.equal(turnCompletionReply({ messages: [user("tool")] }), null);
});
test("tool work preserves real content/tool_calls/finish/usage wire order", () => {
	const reply = turnCompletionReply({ tools, messages: [user("tool")] });
	assert.ok(reply);
	assert.deepEqual(
		reply.frames.slice(1, 3).map((f) => f.choices[0].delta.content),
		["Hello. ", "Let me check."],
	);
	assert.equal(
		reply.frames[3].choices[0].delta.tool_calls?.[0].function?.name,
		"read_generated_file",
	);
	assert.equal(reply.frames.at(-2)?.choices[0].finish_reason, "tool_calls");
	assert.deepEqual(reply.frames.at(-1)?.choices, []);
	assert.deepEqual(reply.frames.at(-1)?.usage, {
		prompt_tokens: 31,
		completion_tokens: 13,
		total_tokens: 44,
	});
});
test("tools-disabled closing retains heading bytes and a distinct truncation finish", () => {
	const reply = turnCompletionReply({
		messages: [user("closing-truncated"), attempt, closeUser],
	});
	assert.ok(reply);
	assert.deepEqual(
		reply.frames.slice(1, 3).map((f) => f.choices[0].delta.content),
		["## Result", "\n\nThe checked result is"],
	);
	assert.equal(reply.frames.at(-2)?.choices[0].finish_reason, "length");
	assert.equal(reply.hold, "completion-final");
});
test("closing failure and empty closing remain separate adversarial responses", () => {
	assert.equal(
		turnCompletionReply({
			messages: [user("closing-error"), attempt, closeUser],
		})?.status,
		500,
	);
	const empty = turnCompletionReply({
		messages: [user("closing-empty"), attempt, closeUser],
	});
	assert.ok(empty);
	assert.equal(empty.frames.at(-2)?.choices[0].finish_reason, "stop");
	assert.equal(
		empty.frames.some((frame) =>
			frame.choices.some((c) => Boolean(c.delta.content)),
		),
		false,
	);
});

test("installed SDK consumes the fixture's text, tool finish and trailing usage", async () => {
	const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
	const { streamText, tool } = await import("ai");
	const { z } = await import("zod");
	const fixture = turnCompletionReply({ tools, messages: [user("tool")] });
	assert.ok(fixture);
	const provider = createOpenAICompatible({
		name: "completion-fixture",
		baseURL: "http://fixture.invalid/v1",
		includeUsage: true,
		fetch: async () =>
			new Response(
				`${fixture.frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			),
	});
	const result = streamText({
		model: provider.chatModel("fake-model"),
		prompt: "Read the evidence.",
		maxRetries: 0,
		tools: {
			read_generated_file: tool({
				inputSchema: z.object({ filename: z.string() }),
			}),
		},
	});
	await result.consumeStream();
	assert.equal(await result.text, "Hello. Let me check.");
	assert.equal(await result.finishReason, "tool-calls");
	assert.deepEqual(
		(await result.toolCalls).map((call) => ({
			id: call.toolCallId,
			name: call.toolName,
			input: call.input,
		})),
		[
			{
				id: "call_completion_read_0",
				name: "read_generated_file",
				input: { filename: "completion-evidence.txt" },
			},
		],
	);
	assert.equal((await result.usage).inputTokens, 31);
	assert.equal((await result.usage).outputTokens, 13);
});

test("synthesis requires useful working prose AND the later read's full evidence", async () => {
	const { COMPLETION_USEFUL_WORKING, COMPLETION_EVIDENCE_TAIL } = await import(
		"../fixtures/ai/turn-completion-scenarios"
	);
	const contentOf = (messages: unknown[]) =>
		turnCompletionReply({ messages: [...messages, closeUser] })
			?.frames.flatMap((frame) =>
				frame.choices.map((choice) => choice.delta.content ?? ""),
			)
			.join("");
	const messages = [
		user("useful-partial"),
		{ role: "assistant", content: COMPLETION_USEFUL_WORKING },
		{
			role: "tool",
			tool_call_id: "call_completion_read_created",
			content: JSON.stringify({ blocks: [{ text: COMPLETION_EVIDENCE_TAIL }] }),
		},
	];
	assert.equal(
		contentOf(messages),
		"## Result\n\n6 × 7 = **42**. Archive key: **ORCHID-73**. Dispatch is **Tuesday**.",
	);
	assert.equal(
		contentOf(messages.slice(0, 2)),
		"## Result\n\nRequired evidence or useful partial was lost.",
	);
	assert.equal(
		contentOf([
			messages[0],
			{ role: "assistant", content: "A digest replaced the useful partial." },
			messages[2],
		]),
		"## Result\n\nRequired evidence or useful partial was lost.",
	);
});

const realClosingInstruction =
	"Complete the original request using the evidence and working text already present. Preserve useful completed subanswers. Do not repeat already committed answer parts. Tools are unavailable. State unresolved limitations honestly.";
const closeUser = { role: "user", content: realClosingInstruction };
test.each([
	"length",
	"reasoning-only",
	"budget",
	"stagnation",
	"closing-error",
	"closing-empty",
	"closing-truncated",
	"useful-partial",
] as const)("actual appended closing user preserves %s scenario lineage", (mode) => {
	const body = { messages: [user(mode), attempt, closeUser] };
	expect(completionMode(body)).toBe(mode);
	const reply = turnCompletionReply(body);
	expect(reply).not.toBeNull();
	expect(reply?.hold).toBe("completion-final");
	if (mode === "closing-error") expect(reply?.status).toBe(500);
	if (mode === "closing-truncated")
		expect(reply?.frames.at(-2)?.choices[0].finish_reason).toBe("length");
	if (mode === "closing-empty")
		expect(
			reply?.frames.some((frame) =>
				frame.choices.some((c) => Boolean(c.delta.content)),
			),
		).toBe(false);
});
test("closing cannot adopt recalled history or auxiliary/current-user requests", () => {
	const bodies = [
		{
			messages: [
				user("closing-error"),
				attempt,
				{ role: "user", content: "A different current request." },
				attempt,
				closeUser,
			],
		},
		{
			messages: [
				{
					role: "user",
					content: `${completionMessage("closing-error")}\n\n## Current User Message\nA different request.\n\n## Instructions\nContinue.`,
				},
				attempt,
				closeUser,
			],
		},
		{
			messages: [
				user("closing-error"),
				attempt,
				{ role: "user", content: "Summarize this for a title." },
			],
		},
		{ messages: [attempt, user("closing-error"), closeUser] },
	];
	for (const body of bodies) expect(turnCompletionReply(body)).toBeNull();
});
test("installed completion driver closing request is dispatched and counted with the working request", async () => {
	const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
	const { tool } = await import("ai");
	const { z } = await import("zod");
	const { runNormalChatCompletion } = await import(
		"../../src/lib/server/services/normal-chat-model/completion"
	);
	const requests: unknown[] = [];
	const sdk = createOpenAICompatible({
		name: "completion-lineage",
		baseURL: "http://synthetic.invalid/v1",
		includeUsage: true,
		fetch: async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			requests.push(body);
			const reply = turnCompletionReply(body);
			if (!reply)
				throw new Error("Real request bypassed the completion fixture");
			return new Response(
				`${reply.frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const provider = {
		id: "synthetic",
		name: "synthetic",
		displayName: "Synthetic",
		baseUrl: "http://synthetic.invalid/v1",
		modelName: "fake-model",
		maxOutputTokens: 4096,
		maxModelContext: 131072,
	};
	const run = runNormalChatCompletion(
		{
			provider,
			messages: [{ role: "user", content: completionMessage("length") }],
			tools: {
				read_generated_file: tool({
					inputSchema: z.object({ filename: z.string() }),
					execute: async () => "synthetic",
				}),
			},
			completionPolicy: {
				turnId: "t",
				segmentId: "s",
				deadlineAt: Date.now() + 300000,
				totalTimeoutMs: 300000,
			},
		},
		{
			model: sdk.chatModel("fake-model"),
			maxModelContext: 131072,
			providerOptions: undefined,
			stopWhen: undefined,
			metadata: (responseModelName) => ({
				modelId: "synthetic",
				providerId: "synthetic",
				providerName: "synthetic",
				displayName: "Synthetic",
				requestedModelName: "fake-model",
				responseModelName,
			}),
			mapUsage: () => ({ inputTokens: 31, outputTokens: 13, totalTokens: 44 }),
		},
		true,
	);
	let result: PlainNormalChatModelRunResult | undefined;
	for (;;) {
		const next = await run.next();
		if (next.done) {
			result = next.value;
			break;
		}
	}
	assert.ok(result);
	expect(result.completion).toMatchObject({
		outcome: "answered",
		closingAttempted: true,
	});
	expect(result.text).toContain("## Result");
	expect(requests).toHaveLength(2);
	expect(requests.map(completionMode)).toEqual(["length", "length"]);
	expect(completionToolsOff(requests[1])).toBe(true);
	expect(
		(requests[1] as { messages: { content: string }[] }).messages.at(-1)
			?.content,
	).toBe(realClosingInstruction);
});

// This is the app driver's actual SDK request, not a synthetic page.route SSE.
test("late-card continuation carries the full useful outline and exact tool result once", async () => {
	const { runStreamingNormalChatModelRun } = await import(
		"../../src/lib/server/services/normal-chat-model"
	);
	const { tool } = await import("ai");
	const { z } = await import("zod");
	const harness = createOpenAICompatibleProviderHarness();
	const result = {
		success: true,
		artifactId: "synthetic-late-card",
		artifactType: "document",
		title: AI_SMOKE_LATE_CARD_TITLE,
	};
	let executions = 0;
	try {
		await harness.start();
		const events = [];
		for await (const event of runStreamingNormalChatModelRun({
			provider: {
				id: "synthetic-late-card",
				name: "synthetic",
				displayName: "Synthetic",
				baseUrl: harness.baseURL,
				modelName: "alfyai-fake-chat-model",
				maxModelContext: 131072,
				maxOutputTokens: 4096,
			},
			messages: [{ role: "user", content: AI_SMOKE_LATE_CARD_MARKER }],
			tools: {
				create_artifact: tool({
					inputSchema: z.object({
						artifactType: z.literal("document"),
						title: z.string(),
						body: z.string(),
					}),
					execute: async () => {
						executions++;
						return result;
					},
				}),
			},
		}))
			events.push(event);
		const requests = harness
			.requests()
			.filter((r) => r.path === "/v1/chat/completions");
		expect(requests).toHaveLength(2);
		const messages = (
			requests[1].body as {
				messages: { role: string; content: string; tool_call_id?: string }[];
			}
		).messages;
		expect(
			messages
				.filter((m) => m.role === "assistant")
				.map((m) => m.content)
				.join(""),
		).toContain(AI_SMOKE_LATE_CARD_INTRO.join(""));
		expect(messages.filter((m) => m.role === "tool")).toEqual([
			{
				role: "tool",
				tool_call_id: "call_fake_create_artifact_1",
				content: JSON.stringify(result),
			},
		]);
		expect(executions).toBe(1);
		const answer = events
			.filter((e) => e.type === "text_delta")
			.map((e) => e.text)
			.join("");
		expect(answer).toContain(
			"szombaton a belváros, vasárnap pedig a múzeumok.",
		);
		expect(AI_SMOKE_LATE_CARD_FINAL_ANSWER).toContain(
			"szombaton a belváros, vasárnap pedig a múzeumok.",
		);
	} finally {
		await harness.stop();
	}
});

test.each([
	"outline",
	"tool-result",
	"failed-tool",
])("late-card refuses a confident synthesis when %s evidence is missing", async (lost) => {
	const harness = createOpenAICompatibleProviderHarness();
	try {
		await harness.start();
		const response = await fetch(`${harness.baseURL}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "alfyai-fake-chat-model",
				stream: true,
				messages: [
					{ role: "user", content: AI_SMOKE_LATE_CARD_MARKER },
					{
						role: "assistant",
						content:
							lost === "outline"
								? "Only a digest."
								: AI_SMOKE_LATE_CARD_INTRO.join(""),
						tool_calls: [
							{
								id: "call_fake_create_artifact_1",
								type: "function",
								function: { name: "create_artifact", arguments: "{}" },
							},
						],
					},
					{
						role: "tool",
						tool_call_id: "call_fake_create_artifact_1",
						content: JSON.stringify(
							lost === "tool-result"
								? {}
								: {
										success: lost !== "failed-tool",
										artifactId: "synthetic-late-card",
										artifactType: "document",
										title: AI_SMOKE_LATE_CARD_TITLE,
									},
						),
					},
				],
			}),
		});
		expect(response.status).toBe(422);
		expect(await response.text()).toContain(
			"Late-card continuation lost required evidence",
		);
	} finally {
		await harness.stop();
	}
});
