// Automatic context compression through the chat turn's real context
// preparation (prepareOutboundContext → prepareOutboundChatContext →
// context-selection + context-compression) against the migrated test
// database. Only the control model itself is faked: it answers with a valid
// snapshot covering exactly the message ids it was sent, or throws.
import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { eq } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
	sendJsonControlMessage: vi.fn(),
}));

vi.mock("$lib/server/services/normal-chat-control-model", () => ({
	sendJsonControlMessage: mocks.sendJsonControlMessage,
}));

import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { conversations, users } from "$lib/server/db/schema";
import {
	type PreparedModelContext,
	prepareOutboundContext,
	resolveProviderRuntime,
} from "$lib/server/services/chat-turn/shared-normal-chat-model-run-helpers";
import { listContextCompressionSnapshots } from "$lib/server/services/context-compression";
import { createConversation } from "$lib/server/services/conversations";
import { createMessage } from "$lib/server/services/messages";
import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import { estimateTokenCount } from "$lib/utils/tokens";

const TEST_USER_EMAIL = "automatic-context-compression@example.com";
// Session history budget = 65% of the 40,000 target = 26,000 tokens;
// the raw tail automatic compression keeps is at most a quarter of that.
const CONTEXT_LIMITS = {
	maxModelContext: 60_000,
	compactionUiThreshold: 48_000,
	targetConstructedContext: 40_000,
};
const PROVIDER = {
	id: "provider-local",
	name: "local",
	displayName: "Local",
	baseUrl: "http://local-model/v1",
	modelName: "local-model",
	apiKey: "local-key",
} as NormalChatModelRunProvider;

let userId: string;

function words(label: string, count: number): string {
	// One estimated token per 4-letter word.
	return `${label} ${"word ".repeat(count)}`.trim();
}

// The control model's contract: the prompt carries a JSON payload whose
// source messages (plus any prior snapshot coverage) must all be covered.
function validSnapshotResponse(prompt: string, fact: string) {
	const payload = JSON.parse(prompt.slice(prompt.indexOf("{"))) as {
		sourceMessages: Array<{ id: string }>;
		priorSnapshot: { sourceCoverage?: { messageIds?: string[] } } | null;
	};
	const messageIds = [
		...(payload.priorSnapshot?.sourceCoverage?.messageIds ?? []),
		...payload.sourceMessages.map((message) => message.id),
	];
	return {
		text: JSON.stringify({
			goal: "Plan the product launch across the discussed workstreams.",
			currentState: "Earlier turns settled the launch plan details.",
			importantDecisions: [],
			importantFacts: [fact],
			openTasks: [],
			openQuestions: [],
			toolUseAndEvidenceRefs: [],
			sourceCoverage: { messageIds },
		}),
	};
}

async function seedTurns(
	conversationId: string,
	turns: Array<{ question: string; answer: string; thinking?: string }>,
) {
	for (const turn of turns) {
		await createMessage(conversationId, "user", turn.question);
		await createMessage(
			conversationId,
			"assistant",
			turn.answer,
			turn.thinking,
		);
	}
}

async function runTurn(
	conversationId: string,
	message: string,
): Promise<PreparedModelContext> {
	const runtimeConfig = getConfig();
	const params = {
		userId,
		runtimeConfig,
		message,
		conversationId,
		modelId: "model1" as const,
		user: { id: userId },
	};
	const runtime = await resolveProviderRuntime({
		...params,
		overrideProvider: PROVIDER,
	});
	return prepareOutboundContext(
		params,
		{
			...runtime,
			modelConfig: { ...runtime.modelConfig, maxTokens: 2_000 },
			baseContextLimits: CONTEXT_LIMITS,
		},
		null,
		new Set(),
	);
}

function historyText(history: ModelMessage[]): string {
	return JSON.stringify(history);
}

// Everything the provider is sent that context preparation decides.
function payloadTokens(prepared: PreparedModelContext): number {
	return (
		estimateTokenCount(prepared.systemPrompt) +
		estimateTokenCount(prepared.inputValue) +
		estimateTokenCount(prepared.turnGuidance) +
		estimateTokenCount(historyText(prepared.historyMessages))
	);
}

// Twelve ~3,000-token turns: ~36k tokens of history against a 26k history
// budget, so the oldest turns no longer fit.
function longConversation() {
	return Array.from({ length: 12 }, (_, index) => ({
		question: `QUESTION_${index + 1} about workstream ${index + 1}?`,
		answer: words(`ANSWER_${index + 1}`, 3_000),
	}));
}

describe("automatic context compression in the chat turn", () => {
	beforeAll(async () => {
		userId = randomUUID();
		await db.insert(users).values({
			id: userId,
			email: TEST_USER_EMAIL,
			passwordHash: "hash",
			name: "Automatic Compression User",
			role: "user",
		});
	});

	afterAll(async () => {
		await db.delete(conversations).where(eq(conversations.userId, userId));
		await db.delete(users).where(eq(users.id, userId));
	});

	beforeEach(() => {
		mocks.sendJsonControlMessage.mockReset();
	});

	it("compresses once when history overflows, then reuses the snapshot on the next turn", async () => {
		const conversation = await createConversation(userId, "Long launch chat");
		await seedTurns(conversation.id, longConversation());
		mocks.sendJsonControlMessage.mockImplementation(async (prompt: string) =>
			validSnapshotResponse(prompt, "SNAPSHOT_FACT_LAUNCH_PLAN"),
		);

		// What the turn would send without compression: the same real context
		// build, before any snapshot exists.
		const { buildConstructedContext } = await import(
			"$lib/server/services/chat-turn/context-selection"
		);
		const uncompressed = await buildConstructedContext({
			userId,
			conversationId: conversation.id,
			message: "Thanks, what is next?",
			modelId: "model1",
			contextLimits: CONTEXT_LIMITS,
		});
		expect(uncompressed.historyWindow.omittedTurnCount).toBeGreaterThan(0);
		expect(historyText(uncompressed.historyMessages)).not.toContain(
			"QUESTION_1 ",
		);

		const first = await runTurn(conversation.id, "Thanks, what is next?");

		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
		const snapshots = await listContextCompressionSnapshots(conversation.id);
		expect(snapshots).toEqual([
			expect.objectContaining({ trigger: "automatic", status: "valid" }),
		]);
		expect(first.inputValue).toContain("## Context Compression Snapshot");
		expect(first.inputValue).toContain("SNAPSHOT_FACT_LAUNCH_PLAN");
		// The two newest turns stay raw; everything older lives only in the
		// snapshot, never twice.
		const firstHistory = historyText(first.historyMessages);
		expect(firstHistory).toContain("QUESTION_12");
		expect(firstHistory).toContain("QUESTION_11");
		expect(firstHistory).not.toContain("QUESTION_10");
		expect(firstHistory).not.toContain("ANSWER_3 ");
		expect(payloadTokens(first)).toBeLessThan(
			estimateTokenCount(uncompressed.inputValue) +
				estimateTokenCount(historyText(uncompressed.historyMessages)),
		);

		// The turn completes and is persisted; the next turn reuses the snapshot.
		await seedTurns(conversation.id, [
			{
				question: "Thanks, what is next?",
				answer: "NEXT_STEP_ANSWER: finalize the press kit.",
			},
		]);
		const second = await runTurn(conversation.id, "And after that?");

		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
		expect(await listContextCompressionSnapshots(conversation.id)).toHaveLength(
			1,
		);
		expect(second.inputValue).toContain("SNAPSHOT_FACT_LAUNCH_PLAN");
		expect(historyText(second.historyMessages)).toContain("NEXT_STEP_ANSWER");
		expect(historyText(second.historyMessages)).not.toContain("QUESTION_10");
	});

	it("does not compress while the real payload fits, however much reasoning is stored", async () => {
		const conversation = await createConversation(userId, "Short chat");
		await seedTurns(
			conversation.id,
			Array.from({ length: 3 }, (_, index) => ({
				question: `SHORT_QUESTION_${index + 1}?`,
				answer: `SHORT_ANSWER_${index + 1}.`,
				// Stored reasoning is never sent as history; it must not count.
				thinking: words("reasoning", 30_000),
			})),
		);

		const prepared = await runTurn(conversation.id, "Thanks.");

		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
		expect(await listContextCompressionSnapshots(conversation.id)).toEqual([]);
		expect(historyText(prepared.historyMessages)).toContain("SHORT_QUESTION_1");
		expect(prepared.inputValue).not.toContain("Context Compression Snapshot");
	});

	it("records a failed attempt and still prepares the turn when the control call throws", async () => {
		const conversation = await createConversation(userId, "Failing chat");
		await seedTurns(conversation.id, longConversation());
		mocks.sendJsonControlMessage.mockRejectedValue(
			new Error("control model unavailable"),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			const prepared = await runTurn(conversation.id, "Thanks, what is next?");

			expect(prepared.inputValue).toContain("Thanks, what is next?");
			expect(prepared.inputValue).not.toContain("Context Compression Snapshot");
			expect(historyText(prepared.historyMessages)).toContain("QUESTION_12");
			expect(await listContextCompressionSnapshots(conversation.id)).toEqual([
				expect.objectContaining({
					trigger: "automatic",
					status: "failed",
					failureReason: expect.stringContaining("control model unavailable"),
				}),
			]);
			expect(warn).toHaveBeenCalledWith(
				"[NORMAL_CHAT_CONTEXT] Automatic context compression failed validation",
				expect.objectContaining({ sessionId: conversation.id }),
			);
			const callsAfterFailure = mocks.sendJsonControlMessage.mock.calls.length;

			// The very next turn does not pay for another failing attempt.
			await seedTurns(conversation.id, [
				{ question: "Thanks, what is next?", answer: "Short answer." },
			]);
			await runTurn(conversation.id, "And then?");
			expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(
				callsAfterFailure,
			);
		} finally {
			warn.mockRestore();
		}
	});

	// Incognito hides a chat from the user's OTHER chats and from memory; its
	// own summary and context stay inside it (CONTEXT.md, Memory Incognito).
	// A compression snapshot is the same kind of per-conversation continuity
	// data - stored and read only by conversation id - so an incognito chat
	// compresses exactly like the manual path and a normal chat would.
	it("compresses an incognito conversation within that conversation", async () => {
		const conversation = await createConversation(userId, "Incognito chat", {
			memoryIncognito: true,
		});
		await seedTurns(conversation.id, longConversation());
		mocks.sendJsonControlMessage.mockImplementation(async (prompt: string) =>
			validSnapshotResponse(prompt, "SNAPSHOT_FACT_INCOGNITO"),
		);

		const prepared = await runTurn(conversation.id, "Thanks, what is next?");

		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
		expect(prepared.inputValue).toContain("SNAPSHOT_FACT_INCOGNITO");
		expect(await listContextCompressionSnapshots(conversation.id)).toEqual([
			expect.objectContaining({
				status: "valid",
				conversationId: conversation.id,
			}),
		]);
	});
});
