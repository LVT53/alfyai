import { describe, expect, it } from "vitest";
import { messageRecallQuery } from "./recall-query";

describe("messageRecallQuery", () => {
	it("keeps a message's words as its query", () => {
		expect(
			messageRecallQuery("  What should I\n\ncook tonight? ", "Dinner ideas"),
		).toBe("What should I cook tonight?");
	});

	it("adds the chat's title to a short follow-up", () => {
		expect(messageRecallQuery("yes, do that", "Kitchen plan")).toBe(
			"Kitchen plan: yes, do that",
		);
	});

	it("adds the chat's title to a follow-up of four words, not five", () => {
		expect(messageRecallQuery("and the second one?", "Kitchen plan")).toBe(
			"Kitchen plan: and the second one?",
		);
		expect(messageRecallQuery("Mi a helyzet vele?", "Konyhaterv")).toBe(
			"Konyhaterv: Mi a helyzet vele?",
		);
		expect(
			messageRecallQuery("what about the second one?", "Kitchen plan"),
		).toBe("what about the second one?");
	});

	it("leaves a short message alone in a chat with no title yet", () => {
		expect(messageRecallQuery("yes, do that", "New Conversation")).toBe(
			"yes, do that",
		);
		expect(messageRecallQuery("yes", null)).toBe("yes");
		expect(messageRecallQuery("yes", "  ")).toBe("yes");
	});

	it("reads the default title the way the query would write it", () => {
		// Whitespace is folded before the title is judged, so the stored default
		// with stray spacing is still no title.
		expect(messageRecallQuery("yes", "  New \n Conversation ")).toBe("yes");
		expect(messageRecallQuery("yes", "new conversation")).toBe(
			"new conversation: yes",
		);
	});

	it("uses the title alone for a message with no words", () => {
		expect(messageRecallQuery("", "Kitchen plan")).toBe("Kitchen plan");
		expect(messageRecallQuery(" \n\t ", null)).toBeNull();
		expect(messageRecallQuery("", "New Conversation")).toBeNull();
	});

	it("keeps a message of 500 characters whole", () => {
		const message = "a".repeat(500);
		expect(messageRecallQuery(message)).toBe(message);
	});

	it("cuts a long message to its start and end", () => {
		expect(
			messageRecallQuery(
				`${"s".repeat(300)}${"x".repeat(5000)}${"e".repeat(200)}`,
			),
		).toBe(`${"s".repeat(300)} ... ${"e".repeat(200)}`);
	});

	it("cuts by characters, never inside one", () => {
		expect(messageRecallQuery("😀".repeat(1500))).toBe(
			`${"😀".repeat(300)} ... ${"😀".repeat(200)}`,
		);
	});
});
