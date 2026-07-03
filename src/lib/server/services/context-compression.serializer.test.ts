import { describe, expect, it } from "vitest";
import type { ContextCompressionSnapshot } from "./context-compression";
import { serializeContextCompressionSnapshot } from "./context-compression";

function makeSnapshot(
	overrides: Partial<ContextCompressionSnapshot>,
): ContextCompressionSnapshot {
	return {
		id: "snapshot-1",
		conversationId: "conv-1",
		userId: "user-1",
		trigger: "automatic",
		status: "valid",
		modelId: "model-1",
		sourceStartMessageId: "message-1",
		sourceEndMessageId: "message-4",
		sourceStartMessageSequence: 1,
		sourceEndMessageSequence: 4,
		snapshot: {},
		sourceCoverage: {},
		sourceRefs: [],
		estimatedTokens: 800,
		sourceTokenEstimate: 4000,
		failureReason: null,
		createdAt: new Date("2026-05-25T10:00:00.000Z"),
		updatedAt: new Date("2026-05-25T10:00:05.000Z"),
		...overrides,
	};
}

describe("serializeContextCompressionSnapshot — summary exposure", () => {
	it("includes summaryExcerpt and sourceMessageCount for a valid snapshot", () => {
		const snapshot = makeSnapshot({
			status: "valid",
			snapshot: {
				goal: "Help the user analyze Q3 revenue.",
				currentState: "Discussed revenue ($4.2M) and segment breakdown.",
				importantFacts: ["Enterprise leads at $2.8M."],
				sourceCoverage: {
					messageIds: ["m1", "m2", "m3", "m4"],
				},
			},
		});

		const marker = serializeContextCompressionSnapshot(snapshot);

		expect(typeof marker.summaryExcerpt).toBe("string");
		expect((marker.summaryExcerpt ?? "").length).toBeGreaterThan(0);
		expect(marker.summaryExcerpt).toContain("Q3 revenue");
		expect(marker.sourceMessageCount).toBe(4);
		expect(typeof marker.sourceMessageCount).toBe("number");
	});

	it("omits summaryExcerpt and sourceMessageCount for a running snapshot", () => {
		const snapshot = makeSnapshot({
			status: "running",
			snapshot: {},
		});

		const marker = serializeContextCompressionSnapshot(snapshot);

		expect(marker.summaryExcerpt).toBeUndefined();
		expect(marker.sourceMessageCount).toBeUndefined();
	});

	it("omits summaryExcerpt and sourceMessageCount for a failed snapshot", () => {
		const snapshot = makeSnapshot({
			status: "failed",
			snapshot: {},
			failureReason: "model error",
		});

		const marker = serializeContextCompressionSnapshot(snapshot);

		expect(marker.summaryExcerpt).toBeUndefined();
		expect(marker.sourceMessageCount).toBeUndefined();
	});

	it("omits summaryExcerpt when the valid snapshot has empty fields", () => {
		const snapshot = makeSnapshot({
			status: "valid",
			snapshot: {},
		});

		const marker = serializeContextCompressionSnapshot(snapshot);

		// No goal/currentState -> nothing to excerpt.
		expect(marker.summaryExcerpt).toBeUndefined();
	});

	it("caps the summaryExcerpt near ~400 characters", () => {
		const longGoal = "G".repeat(600);
		const longState = "S".repeat(600);
		const snapshot = makeSnapshot({
			status: "valid",
			snapshot: {
				goal: longGoal,
				currentState: longState,
				sourceCoverage: { messageIds: ["m1"] },
			},
		});

		const marker = serializeContextCompressionSnapshot(snapshot);

		expect((marker.summaryExcerpt ?? "").length).toBeLessThanOrEqual(400);
	});

	it("counts sourceMessageCount from sourceCoverage.messageIds even when zero goal text", () => {
		const snapshot = makeSnapshot({
			status: "valid",
			snapshot: {
				sourceCoverage: { messageIds: ["a", "b", "c"] },
			},
		});

		const marker = serializeContextCompressionSnapshot(snapshot);

		expect(marker.sourceMessageCount).toBe(3);
	});
});
