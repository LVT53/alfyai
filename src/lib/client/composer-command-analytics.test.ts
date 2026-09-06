import { describe, expect, it, vi } from "vitest";
import { ACTIVITY_EVENT_NAME_MAX_LENGTH } from "$lib/server/services/activity-events";
import {
	recordAnswerNowClicked,
	recordComposerCommandUsed,
	recordFollowUpClicked,
} from "./composer-command-analytics";

function fetchSpy() {
	return vi.fn(async () => new Response(null, { status: 200 }));
}

function lastBody(fetchImpl: ReturnType<typeof fetchSpy>) {
	const init = fetchImpl.mock.calls.at(-1)?.[1] as RequestInit | undefined;
	return JSON.parse(String(init?.body));
}

describe("client activity analytics", () => {
	it("posts a composer command with its conversation id", () => {
		const fetchImpl = fetchSpy();
		recordComposerCommandUsed("remember", "conv-1", fetchImpl);

		expect(fetchImpl.mock.calls[0][0]).toBe("/api/analytics/activity");
		expect(lastBody(fetchImpl)).toEqual({
			kind: "composer_command",
			name: "remember",
			conversationId: "conv-1",
		});
	});

	it("drops an event with no conversation id rather than posting an invalid one", () => {
		const fetchImpl = fetchSpy();
		recordComposerCommandUsed("remember", null, fetchImpl);
		recordComposerCommandUsed("remember", undefined, fetchImpl);

		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("posts a follow-up click with its message id", () => {
		const fetchImpl = fetchSpy();
		recordFollowUpClicked("What about the sequel?", "conv-1", "m1", fetchImpl);

		expect(lastBody(fetchImpl)).toEqual({
			kind: "follow_up_click",
			name: "What about the sequel?",
			conversationId: "conv-1",
			messageId: "m1",
		});
	});

	it("truncates a name the endpoint would reject", () => {
		const fetchImpl = fetchSpy();
		const longQuestion = `${"a".repeat(200)}?`;
		recordFollowUpClicked(longQuestion, "conv-1", "m1", fetchImpl);

		expect(lastBody(fetchImpl).name).toHaveLength(
			ACTIVITY_EVENT_NAME_MAX_LENGTH,
		);
	});

	it("posts an answer-now click", () => {
		const fetchImpl = fetchSpy();
		recordAnswerNowClicked("conv-1", "m1", fetchImpl);

		expect(lastBody(fetchImpl)).toEqual({
			kind: "answer_now",
			name: "answer_now",
			conversationId: "conv-1",
			messageId: "m1",
		});
	});
});
