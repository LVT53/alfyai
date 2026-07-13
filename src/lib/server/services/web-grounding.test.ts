import { describe, expect, it } from "vitest";
import type { ToolCallEntry, ToolEvidenceCandidate } from "$lib/types";
import {
	emptyGroundedWebDiagnostics,
	type GroundedWebResult,
} from "./parallel-search/types";
import {
	buildGroundedWebModelPayload,
	createGroundedWebCandidates,
	createGroundedWebMetadata,
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
		diagnostics: emptyGroundedWebDiagnostics({
			mode: "turbo",
			fetchedSourceCount: 2,
			fusedSourceCount: 2,
			selectedSourceCount: 2,
			evidenceCandidateCount: 2,
		}),
		...overrides,
	};
}

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
	"diagnostics",
	"instructions",
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
		expect(typeof payload.instructions).toBe("string");
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

	it("createGroundedWebMetadata gates evidence", () => {
		expect(createGroundedWebMetadata(fixture())).toMatchObject({
			ok: true,
			evidenceReady: true,
		});
		const noEvidence = createGroundedWebMetadata(fixture({ evidence: [] }));
		expect(noEvidence.ok).toBe(true);
		expect(noEvidence.evidenceReady).toBe(false);
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

		// Default caps the brief at 30000 chars (plus a truncation ellipsis).
		const defaultPayload = buildGroundedWebModelPayload(fixture(briefOverride));
		expect(defaultPayload.answerBriefMarkdown.length).toBeLessThanOrEqual(
			30003,
		);
		expect(defaultPayload.answerBriefMarkdown.length).toBeGreaterThan(29000);

		// A larger maxMarkdownChars lets the full brief through untruncated.
		const raisedPayload = buildGroundedWebModelPayload(fixture(briefOverride), {
			maxMarkdownChars: 50000,
		});
		expect(raisedPayload.answerBriefMarkdown.length).toBe(45000);
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
