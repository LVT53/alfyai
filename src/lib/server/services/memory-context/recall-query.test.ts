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

	it("leaves a short message alone in a chat with no title yet", () => {
		expect(messageRecallQuery("yes, do that", "New Conversation")).toBe(
			"yes, do that",
		);
		expect(messageRecallQuery("yes", null)).toBe("yes");
		expect(messageRecallQuery("yes", "  ")).toBe("yes");
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
