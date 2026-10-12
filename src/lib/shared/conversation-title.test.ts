import { describe, expect, it } from "vitest";
import {
	conversationDisplayTitle,
	DEFAULT_CONVERSATION_TITLE,
	isUntitledConversationTitle,
} from "./conversation-title";

describe("conversation title", () => {
	it("keeps the stored default one English sentence", () => {
		expect(DEFAULT_CONVERSATION_TITLE).toBe("New Conversation");
	});

	it("counts a blank title and the stored default as untitled", () => {
		expect(isUntitledConversationTitle(DEFAULT_CONVERSATION_TITLE)).toBe(true);
		expect(
			isUntitledConversationTitle(`  ${DEFAULT_CONVERSATION_TITLE} `),
		).toBe(true);
		expect(isUntitledConversationTitle("")).toBe(true);
		expect(isUntitledConversationTitle("   ")).toBe(true);
		expect(isUntitledConversationTitle(null)).toBe(true);
		expect(isUntitledConversationTitle(undefined)).toBe(true);
	});

	it("counts any other title as a title", () => {
		expect(isUntitledConversationTitle("Kávéházak története")).toBe(false);
		expect(isUntitledConversationTitle("new conversation")).toBe(false);
	});

	it("prints the label for an untitled conversation and the trimmed title otherwise", () => {
		expect(conversationDisplayTitle("New Conversation", "Új beszélgetés")).toBe(
			"Új beszélgetés",
		);
		expect(conversationDisplayTitle("", "Új beszélgetés")).toBe(
			"Új beszélgetés",
		);
		expect(conversationDisplayTitle(null, "Új beszélgetés")).toBe(
			"Új beszélgetés",
		);
		expect(conversationDisplayTitle("  Kávéházak ", "Új beszélgetés")).toBe(
			"Kávéházak",
		);
	});
});
