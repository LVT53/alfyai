import assert from "node:assert/strict";
import { test } from "vitest";
import { turnCompletionReply } from "../mocks/ai-provider/turn-completion-scripts";
import { completionMessage } from "../fixtures/ai/turn-completion-scenarios";

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
		messages: [user("closing-truncated"), attempt],
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
		turnCompletionReply({ messages: [user("closing-error"), attempt] })?.status,
		500,
	);
	const empty = turnCompletionReply({
		messages: [user("closing-empty"), attempt],
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
		turnCompletionReply({ messages })
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
