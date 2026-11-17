// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_SENTENCES_PER_SESSION } from "$lib/shared/read-aloud/session-limits";
import { readingRequestSchema } from "./request";

const sentence = (index: number) => ({
	id: `s${index}`,
	language: "en",
	paragraphStart: index === 0,
	words: [{ shown: "Hello", kind: "prose", tokens: ["Hello."] }],
});

const request = (count: number) => ({
	conversationId: "c1",
	messageId: "m1",
	sentences: Array.from({ length: count }, (_, index) => sentence(index)),
});

describe("the reading request's limits", () => {
	it("takes as many sentences as one session of the speech service holds, and no more (early review R21)", () => {
		// The browser sends a longer reply in sessions of this size, so the route must take one.
		expect(MAX_SENTENCES_PER_SESSION).toBe(2000);
		expect(readingRequestSchema.safeParse(request(2000)).success).toBe(true);
		expect(readingRequestSchema.safeParse(request(2001)).success).toBe(false);
		expect(readingRequestSchema.safeParse(request(0)).success).toBe(false);
	});
});
