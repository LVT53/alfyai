// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import { accountingReadFixture } from "./accounting-read-fixture";

let f: Awaited<ReturnType<typeof accountingReadFixture>>;
beforeEach(async () => {
	f = await accountingReadFixture();
	await f.seed();
});
afterEach(() => f?.close());
it.each([
	"ledger",
	"usage",
	"legacy",
] as const)("retains real constructed history through %s failure", async (kind) => {
	const { buildConstructedContext } = await import(
		"$lib/server/services/chat-turn/context-selection"
	);
	const input = {
		userId: "u",
		conversationId: "c",
		message: "Thanks.",
		contextLimits: {
			maxModelContext: 60000,
			compactionUiThreshold: 48000,
			targetConstructedContext: 40000,
		},
	};
	for (const historyBeforeMessageId of [undefined, "u2"]) {
		const params = { ...input, historyBeforeMessageId };
		const baseline = await buildConstructedContext(params);
		expect(JSON.stringify(baseline.historyMessages)).toContain("Body u1");
		expect(JSON.stringify(baseline.historyMessages)).toContain("Body a1");
		f.fault(kind);
		const result = await buildConstructedContext(params);
		expect(f.counts[kind]).toBe(1);
		expect(result.historyMessages).toEqual(baseline.historyMessages);
		expect(result.historyWindow).toEqual(baseline.historyWindow);
		if (historyBeforeMessageId)
			expect(JSON.stringify(result.historyMessages)).not.toContain("Body u2");
		f.fault();
	}
});

it.each([
	"ledger",
	"usage",
	"legacy",
] as const)("keeps real sequence-based compaction after %s failure", async (kind) => {
	const { createContextCompressionSnapshot } = await import(
		"$lib/server/services/context-compression"
	);
	await createContextCompressionSnapshot({
		userId: "u",
		conversationId: "c",
		trigger: "manual",
		status: "valid",
		modelId: "model1",
		sourceStartMessageId: "u1",
		sourceEndMessageId: "a1",
		sourceStartMessageSequence: 1,
		sourceEndMessageSequence: 2,
		snapshot: {
			goal: "Saved compact fact",
			currentState: "Earlier exchange summarized",
			importantDecisions: [],
			importantFacts: ["Synthetic compressed fact"],
			openTasks: [],
			openQuestions: [],
			toolUseAndEvidenceRefs: [],
			sourceCoverage: { messageIds: ["u1", "a1"] },
		},
		sourceCoverage: { messageIds: ["u1", "a1"] },
	});
	const { buildConstructedContext } = await import(
		"$lib/server/services/chat-turn/context-selection"
	);
	const params = {
		userId: "u",
		conversationId: "c",
		message: "Thanks.",
		contextLimits: {
			maxModelContext: 60000,
			compactionUiThreshold: 48000,
			targetConstructedContext: 40000,
		},
	};
	const baseline = await buildConstructedContext(params);
	expect(baseline.inputValue).toContain("Synthetic compressed fact");
	expect(JSON.stringify(baseline.historyMessages)).not.toContain("Body a1");
	expect(JSON.stringify(baseline.historyMessages)).toContain("Body a2");
	f.fault(kind);
	const result = await buildConstructedContext(params);
	expect(f.counts[kind]).toBe(1);
	expect(result.historyMessages).toEqual(baseline.historyMessages);
	expect(result.historyWindow).toEqual(baseline.historyWindow);
	expect(result.inputValue).toContain("Synthetic compressed fact");
});
