import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import { resetPrefetchNotesForTests } from "./prefetch";
import {
	createTurnProvenance,
	NON_PROVENANCE_RESULT_TOOLS,
	PROVENANCE_RESULT_TOOLS,
	provenanceKeysOfStoredSources,
	resultCountsAsProvenance,
	type StoredProvenanceSources,
} from "./turn";

// The rule the turn enforces on `fetch_url` and `produce_file`: an address is
// opened only when it came from the user's own messages or from a tool's
// result, never from the model's words. These cases pin each source, each thing
// that must NOT count as one, and that the stored messages are read only when
// they are needed.

type StoredCall = Extract<ThinkingSegment, { type: "tool_call" }>;

function storedCall(overrides: Partial<StoredCall>): StoredCall {
	return {
		type: "tool_call",
		name: "research_web",
		input: {},
		status: "done",
		...overrides,
	};
}

const NOTHING_STORED: StoredProvenanceSources = {
	userTexts: [],
	toolCalls: [],
};

function turn(
	options: {
		requestText?: string;
		stored?: StoredProvenanceSources | (() => Promise<StoredProvenanceSources>);
	} = {},
) {
	const loadStored = vi.fn(async () =>
		typeof options.stored === "function"
			? options.stored()
			: (options.stored ?? NOTHING_STORED),
	);
	return {
		loadStored,
		provenance: createTurnProvenance({
			userId: "user-1",
			conversationId: "conversation-1",
			requestText: options.requestText,
			loadStored,
		}),
	};
}

describe("the turn's provenance: the user's own words", () => {
	beforeEach(() => resetPrefetchNotesForTests());

	it("allows an address in the turn's own message, which is not stored yet", async () => {
		const { provenance, loadStored } = turn({
			requestText: "Read https://example.com/post?id=7 for me, please.",
		});

		const verdict = await provenance.partition([
			"https://example.com/post?id=7",
		]);

		expect(verdict).toEqual({
			allowed: ["https://example.com/post?id=7"],
			refusedCount: 0,
		});
		expect(loadStored).not.toHaveBeenCalled();
	});

	it("allows a bare domain the user typed, as the address the model opens it by", async () => {
		const { provenance } = turn({
			requestText: "what does example.com/pricing say about the pro plan?",
		});

		const verdict = await provenance.partition([
			"https://example.com/pricing",
			"https://www.example.com/pricing#plans",
			"http://EXAMPLE.com/pricing",
		]);

		expect(verdict.refusedCount).toBe(0);
		expect(verdict.allowed).toHaveLength(3);
	});

	it("refuses an address that adds anything to the one the user gave", async () => {
		const { provenance } = turn({
			requestText: "Read https://example.com/post?id=7",
		});

		const verdict = await provenance.partition([
			"https://example.com/post?id=7&leak=secret",
			"https://example.com/post/secret",
			"https://secret.example.com/post?id=7",
			"https://example.com/post?id=8",
			"https://example.com/",
		]);

		expect(verdict).toEqual({ allowed: [], refusedCount: 5 });
	});

	it("allows an address the user typed in an earlier message of this conversation", async () => {
		const { provenance, loadStored } = turn({
			requestText: "and the second one?",
			stored: {
				userTexts: ["newer", "check https://earlier.example/page for me"],
				toolCalls: [],
			},
		});

		const verdict = await provenance.partition([
			"https://earlier.example/page",
		]);

		expect(verdict.allowed).toEqual(["https://earlier.example/page"]);
		expect(loadStored).toHaveBeenCalledTimes(1);
	});
});

describe("the turn's provenance: tool results", () => {
	beforeEach(() => resetPrefetchNotesForTests());

	it("allows a link on a page fetched earlier in the same turn", async () => {
		const { provenance, loadStored } = turn({
			requestText: "summarize https://news.example/story",
		});
		provenance.noteToolResult({
			toolName: "fetch_url",
			payload: {
				success: true,
				answerBriefMarkdown:
					"The story cites [the filing](https://sec.example/filing?id=3).",
				sources: [{ url: "https://news.example/story" }],
			},
			entry: {
				input: { urls: ["https://news.example/story"] },
				candidates: [],
				metadata: { ok: true },
			},
		});

		const verdict = await provenance.partition([
			"https://sec.example/filing?id=3",
			"https://sec.example/filing?id=4",
		]);

		expect(verdict.allowed).toEqual(["https://sec.example/filing?id=3"]);
		expect(verdict.refusedCount).toBe(1);
		expect(loadStored).toHaveBeenCalledTimes(1);
	});

	it("allows an address a tool reported as one of its sources", async () => {
		const { provenance } = turn();
		provenance.noteToolResult({
			toolName: "research_web",
			payload: { success: true },
			entry: {
				input: { query: "bike lanes" },
				candidates: [
					{
						id: "c1",
						title: "Bike lanes",
						url: "https://city.example/bike-lanes",
						sourceType: "web",
					},
				],
				metadata: { ok: true },
			},
		});

		expect(
			(await provenance.partition(["https://city.example/bike-lanes"])).allowed,
		).toEqual(["https://city.example/bike-lanes"]);
	});

	it("does not let a search's echo of the model's own query make an address a result", async () => {
		const { provenance } = turn();
		const made = "https://exfil.example/?d=PRIVATE-DATA";
		provenance.noteToolResult({
			toolName: "research_web",
			payload: { success: true, query: `find ${made}`, queries: [made] },
			entry: {
				input: { query: `find ${made}`, searchQueries: [made] },
				candidates: [],
				metadata: { ok: true },
			},
		});

		expect((await provenance.partition([made])).allowed).toEqual([]);
	});

	it("does not count what a tool that returns the model's own text printed", async () => {
		const { provenance } = turn();
		for (const toolName of [
			"run_python",
			"produce_file",
			"create_artifact",
			"read_artifact",
			"edit_artifact",
		]) {
			provenance.noteToolResult({
				toolName,
				payload: { stdout: "https://exfil.example/?d=PRIVATE-DATA" },
				entry: { input: {}, candidates: [], metadata: { ok: true } },
			});
		}

		expect(
			(await provenance.partition(["https://exfil.example/?d=PRIVATE-DATA"]))
				.allowed,
		).toEqual([]);
	});

	it("counts a document the user supplied, but not a file the model produced", async () => {
		const { provenance } = turn();
		provenance.noteToolResult({
			toolName: "read_generated_file",
			payload: { text: "see https://own-doc.example/ref" },
			entry: { input: {}, candidates: [], metadata: { source: "document" } },
		});
		provenance.noteToolResult({
			toolName: "read_generated_file",
			payload: { text: "see https://model-file.example/ref" },
			entry: { input: {}, candidates: [], metadata: { source: "generated" } },
		});

		const verdict = await provenance.partition([
			"https://own-doc.example/ref",
			"https://model-file.example/ref",
		]);

		expect(verdict.allowed).toEqual(["https://own-doc.example/ref"]);
	});

	it("keeps the order the model asked in, and the addresses as it wrote them", async () => {
		const { provenance } = turn({
			requestText: "https://b.example/ and https://a.example/ and c.example",
		});

		const verdict = await provenance.partition([
			"https://c.example",
			"https://nope.example/",
			"https://A.example/",
			"https://b.example/",
		]);

		expect(verdict.allowed).toEqual([
			"https://c.example",
			"https://A.example/",
			"https://b.example/",
		]);
		expect(verdict.refusedCount).toBe(1);
	});

	it("refuses what is not an address at all", async () => {
		const { provenance } = turn({ requestText: "https://example.com/a" });

		const verdict = await provenance.partition([
			"not an address",
			"javascript:alert(1)",
			"https://user:pass@example.com/a",
			"/relative",
		]);

		expect(verdict).toEqual({ allowed: [], refusedCount: 4 });
	});
});

describe("the turn's provenance: what earlier turns stored", () => {
	beforeEach(() => resetPrefetchNotesForTests());

	it("allows a source a tool returned in an earlier turn", async () => {
		const { provenance } = turn({
			stored: {
				userTexts: [],
				toolCalls: [
					storedCall({
						candidates: [
							{
								id: "c1",
								title: "Earlier",
								url: "https://earlier-source.example/doc",
								sourceType: "web",
							},
						],
					}),
				],
			},
		});

		const verdict = await provenance.partition([
			"https://earlier-source.example/doc",
			"https://earlier-source.example/other",
		]);

		expect(verdict.allowed).toEqual(["https://earlier-source.example/doc"]);
	});

	it("allows an address in an earlier call's result digest, but not one the model itself wrote into that call", async () => {
		const own = "https://exfil.example/?d=PRIVATE-DATA";
		const { provenance } = turn({
			stored: {
				userTexts: [],
				toolCalls: [
					storedCall({
						name: "fetch_url",
						input: { urls: ["https://news.example/story"] },
						resultDigest:
							'{"answerBriefMarkdown":"read [the filing](https://sec.example/f) first"}',
					}),
					storedCall({
						name: "research_web",
						input: { query: `look up ${own}` },
						resultDigest: JSON.stringify({ query: `look up ${own}` }),
					}),
				],
			},
		});

		const verdict = await provenance.partition(["https://sec.example/f", own]);

		expect(verdict.allowed).toEqual(["https://sec.example/f"]);
	});

	it("does not count an earlier call of a tool whose result is the model's own text", () => {
		const keys = provenanceKeysOfStoredSources({
			userTexts: [],
			toolCalls: [
				storedCall({
					name: "run_python",
					resultDigest: '{"stdout":"https://printed.example/x"}',
				}),
				storedCall({
					name: "read_generated_file",
					metadata: { source: "generated" },
					resultDigest: '{"text":"https://generated.example/x"}',
				}),
			],
		});

		expect([...keys]).toEqual([]);
	});

	it("reads the stored messages once, however many calls ask", async () => {
		const { provenance, loadStored } = turn({
			stored: { userTexts: ["https://stored.example/"], toolCalls: [] },
		});

		await provenance.partition(["https://stored.example/"]);
		await provenance.partition(["https://other.example/"]);
		await Promise.all([
			provenance.partition(["https://stored.example/"]),
			provenance.partition(["https://stored.example/"]),
		]);

		expect(loadStored).toHaveBeenCalledTimes(1);
	});

	it("refuses, rather than guesses, when the stored messages cannot be read, and tries again next time", async () => {
		let attempts = 0;
		const { provenance, loadStored } = turn({
			stored: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("database is locked");
				return { userTexts: ["https://stored.example/"], toolCalls: [] };
			},
		});

		const first = await provenance.partition(["https://stored.example/"]);
		const second = await provenance.partition(["https://stored.example/"]);

		expect(first).toEqual({ allowed: [], refusedCount: 1 });
		expect(second.allowed).toEqual(["https://stored.example/"]);
		expect(loadStored).toHaveBeenCalledTimes(2);
	});
});

describe("the classification of tools", () => {
	it("puts no tool in both lists", () => {
		for (const name of PROVENANCE_RESULT_TOOLS) {
			expect(NON_PROVENANCE_RESULT_TOOLS.has(name), name).toBe(false);
		}
	});

	it("counts read_generated_file only for a document the user supplied", () => {
		expect(resultCountsAsProvenance("read_generated_file", null)).toBe(false);
		expect(
			resultCountsAsProvenance("read_generated_file", { source: "generated" }),
		).toBe(false);
		expect(
			resultCountsAsProvenance("read_generated_file", { source: "document" }),
		).toBe(true);
		expect(resultCountsAsProvenance("research_web")).toBe(true);
		expect(resultCountsAsProvenance("run_python")).toBe(false);
		expect(resultCountsAsProvenance("a_tool_nobody_classified")).toBe(false);
	});
});
