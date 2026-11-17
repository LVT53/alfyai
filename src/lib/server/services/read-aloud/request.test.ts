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

describe("what a reading request names", () => {
	const sentences = [sentence(0)];

	it("takes a reply: its conversation and its message", () => {
		const parsed = readingRequestSchema.safeParse({
			conversationId: "c1",
			messageId: "m1",
			sentences,
		});
		expect(parsed.success).toBe(true);
	});

	it("takes a Document: its id and the version the panel shows, with the panel's chat or none", () => {
		for (const conversationId of ["c1", null, undefined]) {
			const parsed = readingRequestSchema.safeParse({
				document: { artifactId: "doc-1", version: 3 },
				conversationId,
				sentences,
			});
			expect(parsed.success, String(conversationId)).toBe(true);
			expect(parsed.data).toMatchObject({
				document: { artifactId: "doc-1", version: 3 },
			});
		}
	});

	it("refuses a Document with no version, a version that is not a whole number from 1, and a request that names neither", () => {
		for (const document of [
			{ artifactId: "doc-1" },
			{ artifactId: "doc-1", version: 0 },
			{ artifactId: "doc-1", version: 1.5 },
			{ artifactId: "doc-1", version: "3" },
			{ artifactId: "", version: 1 },
		]) {
			expect(
				readingRequestSchema.safeParse({ document, sentences }).success,
				JSON.stringify(document),
			).toBe(false);
		}
		expect(readingRequestSchema.safeParse({ sentences }).success).toBe(false);
		expect(
			readingRequestSchema.safeParse({ conversationId: "c1", sentences })
				.success,
		).toBe(false);
	});

	it("holds a Document's sentences to the same limits as a reply's", () => {
		const many = Array.from({ length: 2001 }, (_, index) => sentence(index));
		expect(
			readingRequestSchema.safeParse({
				document: { artifactId: "doc-1", version: 1 },
				sentences: many,
			}).success,
		).toBe(false);
		expect(
			readingRequestSchema.safeParse({
				document: { artifactId: "doc-1", version: 1 },
				sentences: [sentence(0), sentence(0)],
			}).success,
		).toBe(false);
	});
});
