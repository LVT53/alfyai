import type { JSONValue } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateTokenCount } from "$lib/utils/tokens";
import { estimateHistoryMessagesTokens } from "../chat-turn/conversation-history";
import { deriveToolResultDigest } from "../normal-chat-tools/tool-result-digest";
import {
	buildContextGuardPrepareStep,
	CONTEXT_GUARD_MARGIN_TOKENS,
} from "./context-guard";

// The line the guard writes when it shrinks a step: content-free, one per
// shrink, so a turn that had to give up payload can be found in the logs
// without grepping messages out of them.
const TRUNCATED_SUFFIX = "\n\n[truncated to fit the context window]";
const OMITTED_RESULT_TEXT =
	"Result omitted: it was too large for this step's context window.";

type ContextGuardPrepareStep = NonNullable<
	ReturnType<typeof buildContextGuardPrepareStep>
>;
type StepOptions = Parameters<ContextGuardPrepareStep>[0];

const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
	warnSpy.mockClear();
});

afterEach(() => {
	warnSpy.mockClear();
});

function guardFor(input: {
	maxModelContext?: number;
	maxOutputTokens?: number;
	systemPromptTokens?: number;
}): ContextGuardPrepareStep {
	const guard = buildContextGuardPrepareStep(input);
	if (!guard) throw new Error("expected a context guard");
	return guard;
}

function stepOptions(messages: ModelMessage[], stepNumber = 0): StepOptions {
	return {
		messages,
		stepNumber,
		steps: [],
		model: {} as StepOptions["model"],
		experimental_context: undefined,
	};
}

async function runGuard(
	guard: ContextGuardPrepareStep,
	messages: ModelMessage[],
	stepNumber = 0,
) {
	return await guard(stepOptions(messages, stepNumber));
}

type GuardResult = Awaited<ReturnType<typeof runGuard>>;

function shrunkMessages(result: GuardResult): ModelMessage[] {
	if (!result?.messages) {
		throw new Error("expected the guard to shrink the step");
	}
	return result.messages;
}

function promptTokens(
	messages: ModelMessage[],
	systemPromptTokens = 0,
): number {
	return (
		estimateHistoryMessagesTokens(messages, estimateTokenCount) +
		systemPromptTokens
	);
}

function requiredTokens(
	messages: ModelMessage[],
	maxOutputTokens: number,
	systemPromptTokens = 0,
): number {
	return (
		promptTokens(messages, systemPromptTokens) +
		maxOutputTokens +
		CONTEXT_GUARD_MARGIN_TOKENS
	);
}

function toolResultMessage(
	toolCallId: string,
	payload: JSONValue,
): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId,
				toolName: "files",
				output: { type: "json", value: payload },
			},
		],
	};
}

function textToolResultMessage(toolCallId: string, text: string): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId,
				toolName: "read",
				output: { type: "text", value: text },
			},
		],
	};
}

/**
 * A listing whose `results` array is far larger than any step can carry, with
 * the shape the files tool returns (`message` plus `results`), so
 * `deriveToolResultDigest` has something to say about it.
 */
function hugeListingPayload(label: string, itemCount: number) {
	return {
		success: true,
		name: "files",
		action: "list",
		message: `${label} contains ${itemCount} items (newest first, showing 1-50).`,
		results: Array.from({ length: itemCount }, (_, index) => ({
			name: `${label}-${index}.txt`,
			path: `/Documents/${label}/${index}.txt`,
			mtime: "2026-11-04T18:42:00.000Z",
		})),
	};
}

function digestFor(payload: unknown): string {
	const digest = deriveToolResultDigest(payload);
	expect(digest).not.toBeNull();
	return `${digest}${TRUNCATED_SUFFIX}`;
}

/** The tool message exactly as the guard should leave it after replacing it. */
function replacedToolResult(message: ModelMessage, text: string): ModelMessage {
	if (message.role !== "tool") throw new Error("expected a tool message");
	return {
		...message,
		content: message.content.map((part) =>
			part.type === "tool-result"
				? { ...part, output: { type: "text" as const, value: text } }
				: part,
		),
	};
}

describe("buildContextGuardPrepareStep", () => {
	it("cannot guard without both numbers", () => {
		expect(CONTEXT_GUARD_MARGIN_TOKENS).toBe(4_096);
		expect(buildContextGuardPrepareStep({})).toBeUndefined();
		expect(
			buildContextGuardPrepareStep({ maxModelContext: 32_000 }),
		).toBeUndefined();
		expect(
			buildContextGuardPrepareStep({ maxOutputTokens: 1_024 }),
		).toBeUndefined();
	});

	it("leaves a step that fits untouched", async () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "Show me the files in Documents." },
			toolResultMessage("call-1", hugeListingPayload("documents", 10)),
		];
		const maxOutputTokens = 1_024;
		const maxModelContext = requiredTokens(messages, maxOutputTokens) + 1_000;
		const guard = guardFor({ maxModelContext, maxOutputTokens });
		const snapshot = structuredClone(messages);

		await expect(runGuard(guard, messages)).resolves.toBeUndefined();
		expect(messages).toEqual(snapshot);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("counts the system prompt in what a step must carry", async () => {
		const messages: ModelMessage[] = [
			{
				role: "user",
				content: Array.from(
					{ length: 2_000 },
					() => "alpha bravo charlie",
				).join(" "),
			},
		];
		const maxOutputTokens = 512;
		// Room for the message, but not for the message and a 1,400-token
		// system prompt.
		const maxModelContext = requiredTokens(messages, maxOutputTokens) + 1_200;

		const withoutSystem = guardFor({
			maxModelContext,
			maxOutputTokens,
			systemPromptTokens: 0,
		});
		await expect(runGuard(withoutSystem, messages)).resolves.toBeUndefined();

		const withSystem = guardFor({
			maxModelContext,
			maxOutputTokens,
			systemPromptTokens: 1_400,
		});
		const after = shrunkMessages(await runGuard(withSystem, messages));
		expect(requiredTokens(after, maxOutputTokens, 1_400)).toBeLessThanOrEqual(
			maxModelContext,
		);
	});

	it("replaces one huge tool result with its digest so the step fits", async () => {
		const payload = hugeListingPayload("large", 2_000);
		const messages: ModelMessage[] = [
			{ role: "user", content: "List everything in /Documents." },
			toolResultMessage("call-1", payload),
		];
		const maxOutputTokens = 1_024;
		const maxModelContext = 16_384;
		expect(requiredTokens(messages, maxOutputTokens)).toBeGreaterThan(
			maxModelContext,
		);

		const after = shrunkMessages(
			await runGuard(guardFor({ maxModelContext, maxOutputTokens }), messages),
		);

		expect(after[1]).toEqual(
			replacedToolResult(messages[1], digestFor(payload)),
		);
		expect(requiredTokens(after, maxOutputTokens)).toBeLessThanOrEqual(
			maxModelContext,
		);
		// The caller's messages are never mutated.
		expect(messages[1]).toEqual(toolResultMessage("call-1", payload));
	});

	it("omits a huge tool result it cannot digest instead of emptying it", async () => {
		const payload = "x".repeat(200_000);
		const messages: ModelMessage[] = [
			{ role: "user", content: "Read the file." },
			textToolResultMessage("call-1", payload),
		];
		const maxOutputTokens = 1_024;
		const maxModelContext = 16_384;
		expect(requiredTokens(messages, maxOutputTokens)).toBeGreaterThan(
			maxModelContext,
		);

		const after = shrunkMessages(
			await runGuard(guardFor({ maxModelContext, maxOutputTokens }), messages),
		);

		expect(after[1]).toEqual(
			replacedToolResult(messages[1], OMITTED_RESULT_TEXT),
		);
		expect(requiredTokens(after, maxOutputTokens)).toBeLessThanOrEqual(
			maxModelContext,
		);
	});

	it("shrinks both huge tool results when one is not enough", async () => {
		const largePayload = hugeListingPayload("large", 4_000);
		const smallPayload = hugeListingPayload("small", 1_200);
		const messages: ModelMessage[] = [
			{ role: "user", content: "List the files." },
			toolResultMessage("call-large", largePayload),
			toolResultMessage("call-small", smallPayload),
		];
		const maxOutputTokens = 512;

		const bothShrunk = [
			messages[0],
			replacedToolResult(messages[1], digestFor(largePayload)),
			replacedToolResult(messages[2], digestFor(smallPayload)),
		];
		const largeOnly = [
			messages[0],
			replacedToolResult(messages[1], digestFor(largePayload)),
			messages[2],
		];
		const bothRequired = requiredTokens(bothShrunk, maxOutputTokens);
		const largeOnlyRequired = requiredTokens(largeOnly, maxOutputTokens);
		expect(bothRequired).toBeLessThan(largeOnlyRequired);

		// Between "both shrunk fits" and "only the largest shrunk fits": the
		// step needs both.
		const maxModelContext = Math.floor((bothRequired + largeOnlyRequired) / 2);
		expect(requiredTokens(messages, maxOutputTokens)).toBeGreaterThan(
			maxModelContext,
		);
		expect(largeOnlyRequired).toBeGreaterThan(maxModelContext);

		const after = shrunkMessages(
			await runGuard(guardFor({ maxModelContext, maxOutputTokens }), messages),
		);

		expect(after).toEqual(bothShrunk);
		expect(requiredTokens(after, maxOutputTokens)).toBeLessThanOrEqual(
			maxModelContext,
		);
	});

	it("shrinks the largest tool result first", async () => {
		const largePayload = hugeListingPayload("large", 4_000);
		const smallPayload = hugeListingPayload("small", 1_200);
		const messages: ModelMessage[] = [
			{ role: "user", content: "List the files." },
			toolResultMessage("call-large", largePayload),
			toolResultMessage("call-small", smallPayload),
		];
		const maxOutputTokens = 512;

		const largeOnly = [
			messages[0],
			replacedToolResult(messages[1], digestFor(largePayload)),
			messages[2],
		];
		const smallOnly = [
			messages[0],
			messages[1],
			replacedToolResult(messages[2], digestFor(smallPayload)),
		];
		const largeOnlyRequired = requiredTokens(largeOnly, maxOutputTokens);
		const smallOnlyRequired = requiredTokens(smallOnly, maxOutputTokens);
		expect(largeOnlyRequired).toBeLessThan(smallOnlyRequired);

		// A window that fits once the LARGEST result is a digest, but would
		// still be over if only the smaller one were: the guard must pick the
		// largest first and stop there.
		const maxModelContext = Math.floor(
			(largeOnlyRequired + smallOnlyRequired) / 2,
		);

		const after = shrunkMessages(
			await runGuard(guardFor({ maxModelContext, maxOutputTokens }), messages),
		);

		expect(after).toEqual(largeOnly);
		expect(requiredTokens(after, maxOutputTokens)).toBeLessThanOrEqual(
			maxModelContext,
		);
	});

	it("truncates the largest text part when no tool result can free enough", async () => {
		const longText = Array.from(
			{ length: 20_000 },
			() => "alpha bravo charlie",
		).join(" ");
		const messages: ModelMessage[] = [
			{ role: "user", content: [{ type: "text", text: longText }] },
		];
		const maxOutputTokens = 512;
		const maxModelContext = 8_192;
		expect(requiredTokens(messages, maxOutputTokens)).toBeGreaterThan(
			maxModelContext,
		);

		const after = shrunkMessages(
			await runGuard(guardFor({ maxModelContext, maxOutputTokens }), messages),
		);

		// Still a valid ModelMessage[]: the user message and its text part.
		expect(after[0].role).toBe("user");
		const parts = after[0].content as Array<{ type: string; text?: string }>;
		expect(Array.isArray(parts)).toBe(true);
		const textPart = parts[0];
		expect(textPart.type).toBe("text");
		expect((textPart.text ?? "").length).toBeLessThan(longText.length);
		expect(requiredTokens(after, maxOutputTokens)).toBeLessThanOrEqual(
			maxModelContext,
		);
		// The caller's messages are never mutated.
		expect(messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: longText }],
		});
	});

	it("frees older text before the person's newest message", async () => {
		// The newest message is the LARGEST text in the step, so a guard that
		// only sorts by size would cut the person's own words first. Older text
		// can free the little this step is over by, and must be cut instead.
		const olderText = Array.from(
			{ length: 4_000 },
			() => "older words here",
		).join(" ");
		const newestText = Array.from(
			{ length: 20_000 },
			() => "alpha bravo charlie",
		).join(" ");
		const messages: ModelMessage[] = [
			{ role: "user", content: olderText },
			{ role: "user", content: newestText },
		];
		const maxOutputTokens = 512;
		const maxModelContext = requiredTokens(messages, maxOutputTokens) - 100;
		expect(requiredTokens(messages, maxOutputTokens)).toBeGreaterThan(
			maxModelContext,
		);
		// What a guard sorting only by size would cut first.
		expect(estimateTokenCount(newestText)).toBeGreaterThan(
			estimateTokenCount(olderText),
		);

		const after = shrunkMessages(
			await runGuard(guardFor({ maxModelContext, maxOutputTokens }), messages),
		);

		expect(after[1]).toEqual(messages[1]);
		const olderAfter = after[0]?.content as string;
		expect(olderAfter.length).toBeLessThan(olderText.length);
		expect(requiredTokens(after, maxOutputTokens)).toBeLessThanOrEqual(
			maxModelContext,
		);
	});

	it("is deterministic for the same input", async () => {
		const payload = hugeListingPayload("large", 2_000);
		const messages: ModelMessage[] = [
			{ role: "user", content: "List everything in /Documents." },
			toolResultMessage("call-1", payload),
		];
		const maxOutputTokens = 1_024;
		const maxModelContext = 16_384;
		const snapshot = structuredClone(messages);
		const guard = guardFor({ maxModelContext, maxOutputTokens });

		const first = await runGuard(guard, messages, 1);
		const second = await runGuard(guard, messages, 1);

		expect(second).toEqual(first);
		expect(messages).toEqual(snapshot);
	});

	it("logs one content-free line per shrink", async () => {
		const payload = hugeListingPayload("large", 2_000);
		const messages: ModelMessage[] = [
			{ role: "user", content: "List everything in /Documents." },
			toolResultMessage("call-1", payload),
		];
		const maxOutputTokens = 1_024;
		const maxModelContext = 16_384;
		const promptBefore = promptTokens(messages);

		const after = shrunkMessages(
			await runGuard(
				guardFor({ maxModelContext, maxOutputTokens }),
				messages,
				7,
			),
		);

		expect(after).toHaveLength(2);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const line = String(warnSpy.mock.calls[0]?.[0]);
		expect(line).toMatch(
			/^\[NORMAL_CHAT_MODEL\] context guard step=7 prompt=\d+ required=\d+ budget=16384 shrunk=1 after=\d+$/,
		);
		expect(line).toContain(`prompt=${promptBefore}`);
		expect(line).toContain(
			`required=${promptBefore + maxOutputTokens + CONTEXT_GUARD_MARGIN_TOKENS}`,
		);
		// Content-free: no payload text, result names, or message text.
		expect(line).not.toContain("contains 2000 items");
		expect(line).not.toContain("large-0.txt");
		expect(line).not.toContain("Documents");
	});
});
