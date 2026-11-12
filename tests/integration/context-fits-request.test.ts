// A long conversation through the real chat turn: the real prepared turn, the
// real context builder (buildConstructedContext) against the migrated test
// database, the real tool pack with every connector on, the real engine check
// and the real provider adapter. Only the provider's HTTP and the connector
// lookup are stood in for. The point is what the budget does to what the builder
// builds: the engine refuses a request whose context, system prompt, tool
// catalogue, output cap and margin do not fit the window, so a context built to
// the configured target on a window that leaves no room for the catalogue was
// refused; built to the target that leaves the room, it goes out.
//
// The text is synthetic filler written to the test database only.
import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const CONNECTORS = [
	"files",
	"calendar",
	"email",
	"photos",
	"media",
	"location",
	"contacts",
	"repos",
	"tasks",
] as const;

const wire = vi.hoisted(() => ({
	requests: [] as Array<{
		max_tokens?: number;
		max_completion_tokens?: number;
	}>,
	run: undefined as
		| {
				system?: string;
				messages: unknown[];
				tools?: unknown;
				maxOutputTokens?: number | null;
		  }
		| undefined,
}));

vi.mock("$lib/server/services/connections/resolve", () => ({
	resolveActiveCapabilities: async () => new Set(CONNECTORS),
}));
// A context that is over budget asks the control model to summarize its oldest
// turns; here it cannot, and the turn goes on with the context it was built to.
vi.mock("$lib/server/services/normal-chat-control-model", () => ({
	sendJsonControlMessage: vi.fn(async () => {
		throw new Error("no control model in this test");
	}),
}));
vi.mock("$lib/server/services/normal-chat-model", async (original) => {
	const actual =
		await original<typeof import("$lib/server/services/normal-chat-model")>();
	return {
		...actual,
		prepareNormalChatCompletionRun: (
			params: Parameters<typeof actual.prepareNormalChatCompletionRun>[0],
		) => {
			wire.run = {
				system: params.system,
				messages: params.messages,
				tools: params.tools,
				maxOutputTokens: params.maxOutputTokens,
			};
			return actual.prepareNormalChatCompletionRun({
				...params,
				fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
					wire.requests.push(JSON.parse(String(init?.body)));
					return new Response(
						JSON.stringify({
							id: "r",
							object: "chat.completion",
							created: 1,
							model: "actual-test",
							choices: [
								{
									index: 0,
									message: { role: "assistant", content: "Within capacity." },
									finish_reason: "stop",
								},
							],
							usage: {
								prompt_tokens: 10,
								completion_tokens: 3,
								total_tokens: 13,
							},
						}),
						{ headers: { "content-type": "application/json" } },
					);
				},
			});
		},
	};
});

import { deriveModelContextLimits } from "$lib/model-context-defaults";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	conversationContextStatus,
	conversations,
	users,
} from "$lib/server/db/schema";
import { buildConstructedContext } from "$lib/server/services/chat-turn/context-selection";
import { estimateHistoryMessagesTokens } from "$lib/server/services/chat-turn/conversation-history";
import { prepareNormalChatTurn } from "$lib/server/services/chat-turn/prepared-normal-chat-turn";
import { createConversation } from "$lib/server/services/conversations";
import { createMessage } from "$lib/server/services/messages";
import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import {
	CONTEXT_GUARD_MARGIN_TOKENS,
	countToolCatalogueTokens,
} from "$lib/server/services/normal-chat-model/context-guard";
import { estimateTokenCount } from "$lib/utils/tokens";

// A window the default ratios leave no room on: 49,152 of which the default
// target takes 44,236 and the output reserve 4,916, with a catalogue of about
// 16,500 tokens and a 4,096-token margin still to find.
const WINDOW = 49_152;
const MODEL_ID = "provider:fit-test:fit-model" as const;
const PROVIDER = {
	id: "fit-test",
	name: "gateway",
	displayName: "Gateway",
	baseUrl: "https://gateway.example/v1",
	modelName: "fit-model",
	apiKey: "synthetic",
	maxModelContext: WINDOW,
} as NormalChatModelRunProvider;

let userId: string;

// Synthetic filler: one estimated token per word.
function words(label: string, count: number): string {
	return `${label} ${"word ".repeat(count)}`.trim();
}

function historyTokens(messages: ModelMessage[]): number {
	return estimateHistoryMessagesTokens(messages, estimateTokenCount);
}

describe("a long conversation on a window that leaves no room for the tool catalogue", () => {
	beforeAll(async () => {
		userId = randomUUID();
		await db.insert(users).values({
			id: userId,
			email: `context-fits-request-${userId}@example.com`,
			passwordHash: "hash",
			name: "Context Fit User",
			role: "user",
		});
	});

	afterAll(async () => {
		await db.delete(conversations).where(eq(conversations.userId, userId));
		await db.delete(users).where(eq(users.id, userId));
	});

	it("is built smaller, reports the number it was built to, and goes out as one request", async () => {
		const conversation = await createConversation(userId, "A long chat");
		// 120 turns of ~430 tokens: far more than the history budget holds, in
		// pieces small enough that the history fills its budget to within a turn.
		for (let turn = 0; turn < 120; turn += 1) {
			await createMessage(
				conversation.id,
				"user",
				`Question ${turn} about the plan?`,
			);
			await createMessage(
				conversation.id,
				"assistant",
				words(`Answer ${turn}`, 400),
			);
		}
		const message = "And what is next?";
		const configured = deriveModelContextLimits({ maxModelContext: WINDOW });
		expect(configured.targetConstructedContext).toBe(44_236);

		// What the builder builds to the configured target.
		const unfitted = await buildConstructedContext({
			userId,
			conversationId: conversation.id,
			message,
			modelId: MODEL_ID,
			contextLimits: configured,
		});
		expect(unfitted.historyWindow.omittedTurnCount).toBeGreaterThan(0);

		const config = getConfig();
		const run = await prepareNormalChatTurn({
			userId,
			runtimeConfig: {
				...config,
				requestTimeoutMs: 60_000,
				model1: { ...config.model1, maxTokens: null },
			},
			message,
			conversationId: conversation.id,
			modelId: MODEL_ID,
			user: { id: userId },
			overrideProvider: PROVIDER,
		});
		await run.runPlain();

		// The request fits, and it went out.
		const completion = run.receipt.getSnapshot()?.completion;
		expect(completion?.stopCause).not.toBe("context_capacity");
		expect(completion).toMatchObject({ outcome: "answered" });
		expect(wire.requests).toHaveLength(1);
		const sent = wire.run;
		if (!sent) throw new Error("the model run was never prepared");
		const sentHistory = historyTokens(sent.messages as ModelMessage[]);
		const catalogue = await countToolCatalogueTokens(sent.tools as never);
		const reserve = sent.maxOutputTokens ?? 0;
		const standing =
			sentHistory +
			estimateTokenCount(sent.system ?? "") +
			catalogue +
			reserve +
			CONTEXT_GUARD_MARGIN_TOKENS;
		expect(catalogue).toBeGreaterThan(15_000);
		expect(reserve).toBe(WINDOW - configured.targetConstructedContext);
		expect(standing).toBeLessThanOrEqual(WINDOW);
		expect(
			wire.requests[0].max_completion_tokens ?? wire.requests[0].max_tokens,
		).toBe(reserve);

		// The same conversation built to the configured target does not fit: the
		// history is the only thing that differs.
		const smaller = (sent.messages as ModelMessage[]).length;
		expect(unfitted.historyMessages.length + 1).toBeGreaterThan(smaller);
		const sentWithout = standing - sentHistory;
		expect(
			sentWithout + historyTokens(unfitted.historyMessages),
		).toBeGreaterThan(WINDOW);

		// The status the page reads is the number the context was built to.
		const [status] = await db
			.select()
			.from(conversationContextStatus)
			.where(eq(conversationContextStatus.conversationId, conversation.id));
		const room = WINDOW - reserve - catalogue - CONTEXT_GUARD_MARGIN_TOKENS;
		expect(status.maxContextTokens).toBe(WINDOW);
		expect(status.targetTokens).toBe(room);
		expect(status.targetTokens).toBeLessThan(
			configured.targetConstructedContext,
		);
		expect(status.thresholdTokens).toBeLessThanOrEqual(status.targetTokens);
		const provenance = run.receipt.getSnapshot()?.original.provenance as {
			prepared: {
				contextLimits: { targetConstructedContext: number };
				outputTokenBudget: { effectiveMaxTokens: number };
			};
		};
		expect(provenance.prepared.contextLimits.targetConstructedContext).toBe(
			room,
		);
		expect(provenance.prepared.outputTokenBudget.effectiveMaxTokens).toBe(
			reserve,
		);
	}, 60_000);
});
