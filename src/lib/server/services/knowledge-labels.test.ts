import { describe, expect, it } from "vitest";
import {
	deriveConversationArtifactBaseName,
	isPlaceholderConversationTitle,
} from "./knowledge-labels";

describe("knowledge label helpers", () => {
	it("treats provisional conversation titles as placeholders", () => {
		expect(isPlaceholderConversationTitle("New Conversation")).toBe(true);
		expect(isPlaceholderConversationTitle(" conversation ")).toBe(true);
		expect(isPlaceholderConversationTitle("Q1 growth portfolio")).toBe(false);
	});

	it("prefers a meaningful conversation title when available", () => {
		expect(
			deriveConversationArtifactBaseName({
				conversationTitle: "Q1 Growth Portfolio",
				fallbackText: "Draft an updated investment memo for the board",
			}),
		).toBe("Q1 Growth Portfolio");
	});

	it("falls back to a clipped prompt excerpt when the title is still provisional", () => {
		expect(
			deriveConversationArtifactBaseName({
				conversationTitle: "New Conversation",
				fallbackText:
					"Build an updated growth portfolio based on these notes and keep the format close to last year",
				maxLength: 38,
			}),
		).toBe("Build an updated growth portfolio...");
	});
});
