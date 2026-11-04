import { describe, expect, it } from "vitest";
import type { ChatMessage } from "$lib/server/services/messages-types";
import {
	FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE,
	getForkCreationErrorKey,
	hasForkedAssistantInRange,
	isForkedSourceHistoryConfirmationRequired,
	laterTurnCount,
	regenerateDropsLaterTurns,
} from "./lifecycle-guards";

describe("chat lifecycle guards", () => {
	it("detects forked assistant messages inside a destructive edit or regeneration range", () => {
		const messages: ChatMessage[] = [
			{
				id: "user-1",
				role: "user",
				content: "Question",
				timestamp: 1,
			},
			{
				id: "assistant-1",
				role: "assistant",
				content: "Forked answer",
				timestamp: 2,
				sourceForks: {
					count: 1,
					forks: [
						{
							conversationId: "fork-1",
							title: "Question (fork 1)",
							forkSequence: 1,
							createdAt: 3,
						},
					],
				},
			},
			{
				id: "user-2",
				role: "user",
				content: "Later follow-up",
				timestamp: 4,
			},
		];

		expect(hasForkedAssistantInRange(messages, 0)).toBe(true);
		expect(hasForkedAssistantInRange(messages, 1)).toBe(true);
		expect(hasForkedAssistantInRange(messages, 2)).toBe(false);
	});

	it("maps fork creation service codes to localized i18n keys", () => {
		expect(getForkCreationErrorKey("invalid_source_message")).toBe(
			"fork.errors.invalidSourceMessage",
		);
		expect(getForkCreationErrorKey("required_generated_work_unavailable")).toBe(
			"fork.errors.requiredGeneratedWorkUnavailable",
		);
		expect(getForkCreationErrorKey("fork_sequence_conflict")).toBe(
			"fork.errors.sequenceConflict",
		);
		expect(getForkCreationErrorKey("unknown_code")).toBeNull();
	});

	it("detects stale server fork warnings from stream and API errors", () => {
		expect(
			isForkedSourceHistoryConfirmationRequired({
				code: FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE,
			}),
		).toBe(true);
		expect(isForkedSourceHistoryConfirmationRequired(new Error("nope"))).toBe(
			false,
		);
	});

	describe("regenerate later-turns guard (B1)", () => {
		const messages: ChatMessage[] = [
			{ id: "user-1", role: "user", content: "First question", timestamp: 1 },
			{
				id: "assistant-1",
				role: "assistant",
				content: "First answer",
				timestamp: 2,
			},
			{ id: "user-2", role: "user", content: "Follow-up", timestamp: 3 },
			{
				id: "assistant-2",
				role: "assistant",
				content: "Second answer",
				timestamp: 4,
			},
		];

		it("counts and flags later turns when regenerating a mid-conversation assistant message", () => {
			expect(laterTurnCount(messages, 1)).toBe(2);
			expect(regenerateDropsLaterTurns(messages, 1)).toBe(true);
		});

		it("reports no later turns when regenerating the latest assistant message", () => {
			expect(laterTurnCount(messages, 3)).toBe(0);
			expect(regenerateDropsLaterTurns(messages, 3)).toBe(false);
		});

		it("counts later turns from a reply's last segment", () => {
			// A reply that paused to ask is several rows, each carrying on from the row
			// above it. Redoing it redoes all of them, so the turns it would drop are the
			// ones after its LAST segment, whichever segment the count starts from.
			const asked: ChatMessage[] = [
				{
					id: "user-1",
					role: "user",
					content: "Plan dad's 60th",
					timestamp: 1,
				},
				{
					id: "assistant-1",
					role: "assistant",
					content: "First",
					timestamp: 2,
				},
				{
					id: "assistant-2",
					role: "assistant",
					content: "Second",
					timestamp: 3,
					continuesMessageId: "assistant-1",
				},
				{
					id: "assistant-3",
					role: "assistant",
					content: "Third",
					timestamp: 4,
					continuesMessageId: "assistant-2",
				},
				{ id: "user-2", role: "user", content: "Thanks", timestamp: 5 },
				{
					id: "assistant-4",
					role: "assistant",
					content: "Welcome",
					timestamp: 6,
				},
			];

			expect(laterTurnCount(asked, 1)).toBe(2);
			expect(laterTurnCount(asked, 2)).toBe(2);
			expect(laterTurnCount(asked, 3)).toBe(2);
			expect(regenerateDropsLaterTurns(asked, 1)).toBe(true);
			// A reply in segments that ends the chat drops nothing but itself.
			expect(laterTurnCount(asked.slice(0, 4), 1)).toBe(0);
			expect(regenerateDropsLaterTurns(asked.slice(0, 4), 1)).toBe(false);
			// A link to a row that is not right above starts a reply of its own.
			const unlinked: ChatMessage[] = [
				asked[0],
				asked[1],
				{ ...asked[2], continuesMessageId: "assistant-9" },
			];
			expect(laterTurnCount(unlinked, 1)).toBe(1);
		});

		it("still reports later turns when a fork is in range — callers must not double-prompt", () => {
			// Documents the single-prompt interaction: when
			// hasForkedAssistantInRange(messages, assistantIdx) is also true, the
			// fork-in-range implies later turns exist, so callers should show
			// only the fork warning and skip this helper's prompt entirely
			// rather than stacking two confirmations.
			const forkedMessages: ChatMessage[] = [
				messages[0],
				{
					...messages[1],
					sourceForks: {
						count: 1,
						forks: [
							{
								conversationId: "fork-1",
								title: "First question (fork 1)",
								forkSequence: 1,
								createdAt: 3,
							},
						],
					},
				},
				messages[2],
				messages[3],
			];

			expect(hasForkedAssistantInRange(forkedMessages, 1)).toBe(true);
			expect(regenerateDropsLaterTurns(forkedMessages, 1)).toBe(true);
		});
	});
});
