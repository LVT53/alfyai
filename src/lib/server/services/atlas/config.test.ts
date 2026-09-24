import { describe, expect, it } from "vitest";
import {
	buildAtlasIdempotencyKey,
	DEFAULT_ATLAS_JOB_TITLE,
	generateAtlasJobTitle,
	hashAtlasQuery,
	normalizeAtlasQueryForHash,
} from "./config";

// Atlas v3 is the only content pipeline (Phase B of the v3-only
// consolidation); the profile runtime config this file used to test
// (`getAtlasProfileRuntimeConfig`, its stage order and gap-fill caps) was
// deleted with the v1 pipeline. What remains here — idempotency, query
// normalization and title generation — is shared by every pipeline version
// and stays exercised.

describe("Atlas query normalization and hashing", () => {
	it("normalizes case, whitespace and trailing punctuation before hashing", () => {
		expect(normalizeAtlasQueryForHash("  What is  Atlas??  ")).toBe(
			"what is atlas",
		);
	});

	it("hashes equivalent queries to the same value", () => {
		expect(hashAtlasQuery("What is Atlas?")).toBe(
			hashAtlasQuery("what is atlas"),
		);
	});

	it("hashes different queries to different values", () => {
		expect(hashAtlasQuery("What is Atlas?")).not.toBe(
			hashAtlasQuery("What is Flash-Next?"),
		);
	});
});

describe("Atlas job title generation", () => {
	it("takes the first sentence and strips terminal punctuation", () => {
		expect(generateAtlasJobTitle("What is Atlas? It is a research tool.")).toBe(
			"What is Atlas",
		);
	});

	it("falls back to the default title when the query is empty after cleanup", () => {
		expect(generateAtlasJobTitle("   ...   ")).toBe(DEFAULT_ATLAS_JOB_TITLE);
	});

	it("clips long titles at a word boundary near the max length", () => {
		const longQuery = `${"word ".repeat(30)}tail`;
		const title = generateAtlasJobTitle(longQuery);
		expect(title.length).toBeLessThanOrEqual(80);
		expect(title.endsWith(" ")).toBe(false);
	});
});

describe("Atlas idempotency key", () => {
	const baseScope = {
		userId: "user-1",
		conversationId: "conv-1",
		action: "create" as const,
		profile: "overview" as const,
		normalizedQueryHash: "hash-1",
		clientAtlasTurnId: "turn-1",
	};

	it("is stable for the same scope", () => {
		expect(buildAtlasIdempotencyKey(baseScope)).toBe(
			buildAtlasIdempotencyKey(baseScope),
		);
	});

	it("treats a missing parentAtlasJobId as the same scope as an explicit null", () => {
		expect(buildAtlasIdempotencyKey(baseScope)).toBe(
			buildAtlasIdempotencyKey({ ...baseScope, parentAtlasJobId: null }),
		);
	});

	it("changes when the parent job differs", () => {
		expect(buildAtlasIdempotencyKey(baseScope)).not.toBe(
			buildAtlasIdempotencyKey({
				...baseScope,
				parentAtlasJobId: "parent-1",
			}),
		);
	});

	it("changes when the client turn id differs", () => {
		expect(buildAtlasIdempotencyKey(baseScope)).not.toBe(
			buildAtlasIdempotencyKey({ ...baseScope, clientAtlasTurnId: "turn-2" }),
		);
	});
});
