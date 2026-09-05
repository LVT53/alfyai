import { describe, expect, it } from "vitest";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import {
	baseGroundedWebDiagnostics,
	type GroundedWebResult,
	MAX_PAYLOAD_SOURCES,
} from "./parallel-search/types";
import {
	buildGroundedWebModelPayload,
	createGroundedWebCandidates,
	createGroundedWebMetadata,
	extractCitedCanonicalWebUrls,
	extractGroundedWebCitationSources,
	summarizeGroundedWebResult,
} from "./web-grounding";

function fixture(
	overrides: Partial<GroundedWebResult> = {},
): GroundedWebResult {
	return {
		query: "what is the capital of france",
		queries: [{ query: "what is the capital of france" }],
		sources: [
			{
				id: "p0",
				title: "Source Zero",
				url: "https://example.com/a",
				provider: "parallel",
				authorityClass: "standard",
				authorityScore: 50,
				snippet: "snippet a",
				highlights: ["highlight a"],
				providerRank: 0,
				publishedAt: null,
				updatedAt: null,
			},
			{
				id: "p1",
				title: "Source One",
				url: "https://example.org/b",
				provider: "parallel",
				authorityClass: "standard",
				authorityScore: 50,
				snippet: "snippet b",
				highlights: ["highlight b"],
				providerRank: 1,
				publishedAt: null,
				updatedAt: null,
			},
		],
		evidence: [
			{
				id: "p0e0",
				sourceId: "p0",
				title: "Source Zero",
				url: "https://example.com/a",
				provider: "parallel",
				quote: "quote a",
				score: 1,
			},
			{
				id: "p1e0",
				sourceId: "p1",
				title: "Source One",
				url: "https://example.org/b",
				provider: "parallel",
				quote: "quote b",
				score: 0.9,
			},
		],
		answerBrief: {
			markdown: "# Web research brief\n[1] Source Zero — https://example.com/a",
			instructions: ["Answer only from these sources."],
		},
		diagnostics: baseGroundedWebDiagnostics({
			mode: "turbo",
			fetchedSourceCount: 2,
			fusedSourceCount: 2,
			selectedSourceCount: 2,
			evidenceCandidateCount: 2,
		}),
		...overrides,
	};
}

// P4 tool-result hygiene: `diagnostics`, `answerBrief.instructions` and the
// trailing `instructions` string are gone from the MODEL payload — diagnostics
// now live only in the recorder `metadata` via createGroundedWebMetadata (see
// the "diagnostics move to recorder metadata" tests below).
const FROZEN_PAYLOAD_KEYS = [
	"success",
	"name",
	"sourceType",
	"query",
	"queries",
	"answerBrief",
	"answerBriefMarkdown",
	"sources",
	"evidence",
];

describe("web-grounding contract guard (GroundedWebResult)", () => {
	it("buildGroundedWebModelPayload emits the frozen top-level field names", () => {
		const payload = buildGroundedWebModelPayload(fixture());
		for (const key of FROZEN_PAYLOAD_KEYS) {
			expect(payload).toHaveProperty(key);
		}
		expect(payload.name).toBe("research_web");
		expect(payload.sourceType).toBe("web");
		expect(payload.success).toBe(true);
		expect(payload.query).toBe("what is the capital of france");
		expect(payload.queries).toEqual(["what is the capital of france"]);
		expect(payload.answerBriefMarkdown).toContain("Web research brief");
		expect(payload).not.toHaveProperty("diagnostics");
		expect(payload).not.toHaveProperty("instructions");
		expect(payload.answerBrief).not.toHaveProperty("instructions");
	});

	it("source and evidence entries carry the frozen field names", () => {
		const payload = buildGroundedWebModelPayload(fixture());
		expect(payload.sources[0]).toMatchObject({
			id: "p0",
			title: "Source Zero",
			url: "https://example.com/a",
			provider: "parallel",
			authorityClass: "standard",
			authorityScore: 50,
		});
		expect(payload.evidence[0]).toMatchObject({
			id: "p0e0",
			sourceId: "p0",
			quote: "quote a",
			url: "https://example.com/a",
			score: 1,
		});
	});

	it("createGroundedWebCandidates yields web candidates", () => {
		const candidates = createGroundedWebCandidates(fixture());
		expect(candidates.length).toBe(2);
		for (const c of candidates) {
			expect(c.sourceType).toBe("web");
			expect(c.material).toBe(true);
			expect(c.id).toBeTruthy();
			expect(c.title).toBeTruthy();
			expect(c.url).toBeTruthy();
		}
	});

	it("createGroundedWebCandidates never exceeds the model's source slice (MAX_PAYLOAD_SOURCES)", () => {
		const manySources = Array.from({ length: 12 }, (_, index) => ({
			id: `p${index}`,
			title: `Source ${index}`,
			url: `https://example${index}.com/a`,
			provider: "parallel",
			authorityClass: "standard",
			authorityScore: 50,
			snippet: `snippet ${index}`,
			highlights: [`highlight ${index}`],
			providerRank: index,
			publishedAt: null,
			updatedAt: null,
		}));
		const candidates = createGroundedWebCandidates(
			fixture({ sources: manySources }),
		);
		// The chip/candidate set must never represent a source the model was not
		// given (the model payload is sliced to MAX_PAYLOAD_SOURCES).
		expect(candidates.length).toBe(MAX_PAYLOAD_SOURCES);
		expect(candidates.map((c) => c.id)).toEqual(
			manySources.slice(0, MAX_PAYLOAD_SOURCES).map((s) => s.id),
		);
	});

	it("createGroundedWebMetadata gates evidence", () => {
		expect(createGroundedWebMetadata(fixture())).toMatchObject({
			ok: true,
			evidenceReady: true,
		});
		const noEvidence = createGroundedWebMetadata(fixture({ evidence: [] }));
		expect(noEvidence.ok).toBe(true);
		expect(noEvidence.evidenceReady).toBe(false);
	});

	it("createGroundedWebMetadata carries the diagnostics dropped from the model payload", () => {
		const metadata = createGroundedWebMetadata(fixture());
		expect(metadata).toMatchObject({
			mode: "turbo",
			fetchedSourceCount: 2,
			fusedSourceCount: 2,
			selectedSourceCount: 2,
			evidenceCandidateCount: 2,
			pageExtractionAttemptedCount: 0,
			pageExtractionSucceededCount: 0,
		});
		// Every metadata value must be a flat scalar (or null) — the recorder
		// entry's `metadata` field rejects nested objects/arrays.
		for (const value of Object.values(metadata)) {
			expect(["string", "number", "boolean"]).toContain(typeof value);
		}
	});

	it("empty evidence makes the payload not evidence-ready", () => {
		const payload = buildGroundedWebModelPayload(fixture({ evidence: [] }));
		expect(payload.success).toBe(false);
	});

	it("maxMarkdownChars opt raises the answer-brief markdown limit", () => {
		const longMarkdown = "x".repeat(45000);
		const briefOverride = {
			answerBrief: { markdown: longMarkdown, instructions: [] },
		};

		// Default (research_web, no opts) caps the brief at the
		// WEB_RESEARCH_BRIEF_MAX_CHARS default of 12000 chars (plus ellipsis).
		const defaultPayload = buildGroundedWebModelPayload(fixture(briefOverride));
		expect(defaultPayload.answerBriefMarkdown.length).toBeLessThanOrEqual(
			12003,
		);
		expect(defaultPayload.answerBriefMarkdown.length).toBeGreaterThan(11000);

		// A larger maxMarkdownChars (e.g. fetch_url's model-aware cap) lets the
		// full brief through untruncated.
		const raisedPayload = buildGroundedWebModelPayload(fixture(briefOverride), {
			maxMarkdownChars: 50000,
		});
		expect(raisedPayload.answerBriefMarkdown.length).toBe(45000);
	});

	it("WEB_RESEARCH_BRIEF_MAX_CHARS env override changes the research_web default", () => {
		const longMarkdown = "x".repeat(20000);
		const briefOverride = {
			answerBrief: { markdown: longMarkdown, instructions: [] },
		};
		const previous = process.env.WEB_RESEARCH_BRIEF_MAX_CHARS;
		process.env.WEB_RESEARCH_BRIEF_MAX_CHARS = "5000";
		try {
			const payload = buildGroundedWebModelPayload(fixture(briefOverride));
			expect(payload.answerBriefMarkdown.length).toBeLessThanOrEqual(5003);
			expect(payload.answerBriefMarkdown.length).toBeGreaterThan(4000);
		} finally {
			if (previous === undefined) {
				delete process.env.WEB_RESEARCH_BRIEF_MAX_CHARS;
			} else {
				process.env.WEB_RESEARCH_BRIEF_MAX_CHARS = previous;
			}
		}
	});

	it("fetch_url is unaffected by the research_web default cap when it passes its own", () => {
		const longMarkdown = "x".repeat(20000);
		const briefOverride = {
			answerBrief: { markdown: longMarkdown, instructions: [] },
		};
		const payload = buildGroundedWebModelPayload(fixture(briefOverride), {
			name: "fetch_url",
			maxMarkdownChars: 60000,
		});
		expect(payload.name).toBe("fetch_url");
		expect(payload.answerBriefMarkdown.length).toBe(20000);
	});

	it("summarizeGroundedWebResult reports the counts", () => {
		const summary = summarizeGroundedWebResult(fixture());
		expect(summary).toContain("2");
		expect(summary.length).toBeGreaterThan(0);
	});
});

describe("extractGroundedWebCitationSources", () => {
	const candidate = (url: string): ToolEvidenceCandidate => ({
		id: `c-${url}`,
		title: "T",
		url,
		snippet: null,
		sourceType: "web",
		material: true,
	});
	const entry = (name: string, url: string): ToolCallEntry =>
		({
			callId: `call-${name}`,
			name,
			input: {},
			status: "done",
			sourceType: "web",
			candidates: [candidate(url)],
			metadata: { ok: true, evidenceReady: true },
		}) as unknown as ToolCallEntry;

	it("harvests citation sources from both research_web and fetch_url", () => {
		const sources = extractGroundedWebCitationSources([
			entry("research_web", "https://example.com/a"),
			entry("fetch_url", "https://example.org/b"),
		]);
		const hosts = sources.map((s) => s.host).sort();
		expect(hosts).toEqual(["example.com", "example.org"]);
	});

	it("ignores non-web / non-done tool calls", () => {
		const notDone = {
			...entry("research_web", "https://x.com/1"),
			status: "running",
		} as unknown as ToolCallEntry;
		expect(extractGroundedWebCitationSources([notDone])).toEqual([]);
	});
});

describe("extractCitedCanonicalWebUrls", () => {
	it("canonicalizes cited URLs from markdown links and bare URLs", () => {
		const set = extractCitedCanonicalWebUrls(
			"See [docs](https://www.foo.com/a/?utm_source=x) and https://bar.com/b.",
		);
		expect([...set].sort()).toEqual(["https://bar.com/b", "https://foo.com/a"]);
	});

	it("returns an empty set when the answer cites no URLs", () => {
		expect(extractCitedCanonicalWebUrls("no links here at all").size).toBe(0);
	});
});
