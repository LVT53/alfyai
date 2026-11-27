import { describe, expect, it, vi } from "vitest";
import {
	messageRecallQuery,
	shouldPrioritizeRecallMatches,
} from "./recall-query";

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

	describe("a character made of several code points", () => {
		/** A joined emoji: five code points, one character. */
		const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}";
		/** An e and its combining accent: two code points, one character. */
		const ACCENTED_E = "é";
		/** How many of the character's code points a piece holds. */
		const partsIn = (piece: string, character: string) =>
			[...piece].filter((part) => [...character].includes(part)).length;
		const pieces = (query: string | null) => (query ?? "").split(" ... ");

		it("is kept whole or left out when the head's cut falls inside it", () => {
			// The head ends at the 300th code point, which the emoji straddles for
			// 296 to 299 letters before it.
			for (let before = 290; before <= 300; before++) {
				const [head] = pieces(
					messageRecallQuery(
						`${"a".repeat(before)}${FAMILY}${"x".repeat(2000)}${"e".repeat(200)}`,
					),
				);
				expect([0, 5], `${before} letters before`).toContain(
					partsIn(head, FAMILY),
				);
			}
			expect(
				messageRecallQuery(
					`${"a".repeat(298)}${FAMILY}${"x".repeat(2000)}${"e".repeat(200)}`,
				),
			).toBe(`${"a".repeat(298)} ... ${"e".repeat(200)}`);
		});

		it("is kept whole or left out when the tail's cut falls inside it", () => {
			// The tail starts 200 code points from the end.
			for (let after = 190; after <= 205; after++) {
				const [, tail] = pieces(
					messageRecallQuery(
						`${"x".repeat(2000)}${FAMILY}${"e".repeat(after)}`,
					),
				);
				expect([0, 5], `${after} letters after`).toContain(
					partsIn(tail, FAMILY),
				);
			}
			expect(
				messageRecallQuery(`${"x".repeat(2000)}${FAMILY}${"e".repeat(198)}`),
			).toBe(`${"x".repeat(300)} ... ${"e".repeat(198)}`);
		});

		it("keeps a letter's accent with it at both cuts", () => {
			expect(
				messageRecallQuery(
					`${"a".repeat(299)}${ACCENTED_E}${"x".repeat(2000)}${"e".repeat(200)}`,
				),
			).toBe(`${"a".repeat(299)} ... ${"e".repeat(200)}`);
			expect(
				messageRecallQuery(
					`${"x".repeat(2000)}${ACCENTED_E}${"e".repeat(199)}`,
				),
			).toBe(`${"x".repeat(300)} ... ${"e".repeat(199)}`);
		});

		it("keeps a message of 500 code points whole, though they take more units", () => {
			const message = `${FAMILY}${"a".repeat(495)}`;
			expect(Array.from(message)).toHaveLength(500);
			expect(messageRecallQuery(message)).toBe(message);
		});
	});

	it("reads only the neighbourhood of each cut, however long the message", () => {
		const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
		try {
			const query = messageRecallQuery("word ".repeat(600_000));
			expect(Array.from(query ?? "")).toHaveLength(300 + 5 + 200);
			expect(segment).toHaveBeenCalled();
			for (const [text] of segment.mock.calls)
				expect(String(text).length).toBeLessThanOrEqual(200);
		} finally {
			segment.mockRestore();
		}
	});
});

describe("shouldPrioritizeRecallMatches", () => {
	it.each([
		"What do you remember about my work and responsibilities?",
		"What subjects or exams have I been studying for?",
		"What do you remember about my regular weekly routines?",
		"What personal preferences have I told you about?",
		"Remind me about my piano lessons",
		"What do you remember about me specifically in relation to my job?",
		"Mire emlékszel a munkámmal és a feladataimmal kapcsolatban?",
		"Milyen tantárgyakat tanulok, vagy milyen vizsgákra készülök?",
		"Mire emlékszel a rendszeres heti szokásaimból?",
		"Milyen személyes preferenciáimról meséltem neked?",
		"Hol dolgozom",
		"Mesélj a zongoraóráimról",
	])("leads with matches for a named subject: %s", (message) => {
		expect(shouldPrioritizeRecallMatches(message)).toBe(true);
	});

	it.each([
		"",
		"Sure.",
		"Yes, do that.",
		"What about the second one?",
		"What do you remember about me?",
		"What else can you tell me about myself?",
		"Could you please summarize everything you know about my life so far?",
		"What's in my memory profile?",
		"Tell me more",
		"Who am I?",
		"Can you give me a quick overview of what you know about me from our chats?",
		"What have I shared with you in previous conversations?",
		"Okay?",
		"Is that right?",
		"Mi mást tudsz még elmondani rólam?",
		"Össze tudnád foglalni, mit jegyeztél meg rólam?",
		"Mit tudsz rólam?",
		"Mire emlékszel velem kapcsolatban?",
		"Foglalj össze mindent, amit eddig rólam tudsz.",
		"Mi a helyzet vele?",
		"I usually play the piano after work.",
		"Munka után zongorázni szoktam.",
	])("keeps the core order for broad or non-question turns: %s", (message) => {
		expect(shouldPrioritizeRecallMatches(message)).toBe(false);
	});
});
