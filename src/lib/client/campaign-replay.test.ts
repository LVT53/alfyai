import { beforeEach, describe, expect, it } from "vitest";
import {
	mayAutoShowCampaign,
	shouldPersistCampaignCompletion,
} from "./campaign-replay";
import {
	consumePendingConversationMessage,
	storePendingConversationMessage,
} from "./conversation-session";

describe("campaign replay mode", () => {
	it("persists terminal state only for automatic campaign display", () => {
		expect(shouldPersistCampaignCompletion("auto")).toBe(true);
		expect(shouldPersistCampaignCompletion("replay")).toBe(false);
	});
});

// Owner, 2026-10-13: "the 2.2 slides just appeared when I sent a new message".
// The landing page sends a first message with a full document navigation, which
// loads the whole app shell again; the shell took that load for an arrival.
describe("when the app shell may open a card by itself", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
	});

	const firstMessage = {
		message: "Szia!",
		attachmentIds: [],
		attachments: [],
	};

	it("may on an arrival: the landing page, or a chat nothing is being sent to", () => {
		expect(mayAutoShowCampaign(undefined)).toBe(true);
		expect(mayAutoShowCampaign(null)).toBe(true);
		expect(mayAutoShowCampaign("chat-1")).toBe(true);
	});

	it("may not on the load that carries a first message from the landing page into its chat", () => {
		storePendingConversationMessage("chat-1", firstMessage);

		expect(mayAutoShowCampaign("chat-1")).toBe(false);
	});

	it("may again once the chat has taken the message up: a reload after that is an arrival", () => {
		storePendingConversationMessage("chat-1", firstMessage);
		consumePendingConversationMessage("chat-1");

		expect(mayAutoShowCampaign("chat-1")).toBe(true);
	});

	it("is not held back by a message that waits for another chat", () => {
		storePendingConversationMessage("chat-2", firstMessage);

		expect(mayAutoShowCampaign("chat-1")).toBe(true);
	});
});
