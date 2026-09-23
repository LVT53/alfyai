import { describe, expect, it } from "vitest";
import {
	ATLAS_V2_MAX_EVIDENCE_SNIPPET_CHARS,
	ATLAS_V2_MAX_PLAN_ENTRIES,
	ATLAS_V3_MAX_EVIDENCE_SNIPPET_CHARS,
	ATLAS_V3_MAX_PLAN_ENTRIES,
	isAtlasV2ProgressDetails,
	isAtlasV3ProgressDetails,
	sanitizeAtlasJobProgressDetails,
	sanitizeAtlasV2ProgressDetails,
	sanitizeAtlasV3ProgressDetails,
} from "./progress-details";

// ---------------------------------------------------------------------------
// Guard test (Phase A): the moved sanitisers must sanitise a stored v2 blob
// and a stored v3 blob EXACTLY as the pre-move code did. These input/output
// pairs were captured by running the pre-change `sanitizeAtlasV2ProgressDetails`
// (atlas-v2/progress.ts, untouched by this change) and the pre-change
// `sanitizeAtlasV3ProgressDetails` (atlas-v3/progress.ts, before its sanitiser
// moved here) against the same inputs, before this module existed. If this
// test ever fails, the new code's behaviour drifted from the old — the caps
// (1200 chars for v2 snippets, 4000 for v3) are the likeliest culprit.
// ---------------------------------------------------------------------------

describe("guard: moved sanitisers match the pre-move output byte for byte", () => {
	const v2Input = {
		pipelineVersion: 2,
		phase: "verify",
		plan: [
			{
				id: "q1",
				question: "What capacity was added?",
				status: "done",
				sourceCount: 5,
				confidence: "corroborated",
			},
			{
				id: "q2",
				question: "What does the regulator require?",
				status: "running",
				sourceCount: 0,
			},
			{ id: "", question: "dropped, no id" },
		],
		round: { current: 2, total: 3 },
		sourcesRead: 17,
		next: "  verify every cited figure  ",
		phaseDurationsMs: { plan: 1200, research: 45000, bogus: 5 },
		sections: { written: 3, planned: 4 },
		writerRunaways: { length: 1, salvaged: 1, retried: 0, fallback: 0 },
		evidence: {
			corroborated: 3,
			single: 2,
			inferred: 1,
			cut: 1,
			filteredCount: 4,
			sources: [
				{
					n: 1,
					title: "Report 1",
					host: "source1.example",
					date: "2026-04-01",
					cited: true,
					snippet: "Evidence for source 1 with a figure of 1 GW.",
				},
				{
					n: 2,
					title: "Report 2",
					host: "source2.example",
					date: "2026-04-01",
					cited: false,
					snippet: "Evidence for source 2 with a figure of 2 GW.",
				},
			],
		},
	};

	// Captured from `sanitizeAtlasV2ProgressDetails(v2Input)` before this
	// module existed.
	const v2ExpectedOutput = {
		pipelineVersion: 2,
		queries: [],
		phase: "verify",
		plan: [
			{
				id: "q1",
				question: "What capacity was added?",
				status: "done",
				sourceCount: 5,
				confidence: "corroborated",
			},
			{
				id: "q2",
				question: "What does the regulator require?",
				status: "running",
				sourceCount: 0,
			},
		],
		round: { current: 2, total: 3 },
		sourcesRead: 17,
		next: "verify every cited figure",
		phaseDurationsMs: { plan: 1200, research: 45000 },
		sections: { written: 3, planned: 4 },
		writerRunaways: { length: 1, salvaged: 1, retried: 0, fallback: 0 },
		evidence: {
			corroborated: 3,
			single: 2,
			inferred: 1,
			cut: 1,
			filteredCount: 4,
			sources: [
				{
					n: 1,
					title: "Report 1",
					host: "source1.example",
					date: "2026-04-01",
					cited: true,
					snippet: "Evidence for source 1 with a figure of 1 GW.",
				},
				{
					n: 2,
					title: "Report 2",
					host: "source2.example",
					date: "2026-04-01",
					cited: false,
					snippet: "Evidence for source 2 with a figure of 2 GW.",
				},
			],
		},
	};

	const v3Input = {
		pipelineVersion: 3,
		phase: "write",
		plan: [
			{
				id: "n1",
				question: "EU solar additions fell in 2025",
				status: "done",
				sourceCount: 2,
				confidence: "corroborated",
			},
			{
				id: "n2",
				question: "Rooftop demand drove the fall",
				status: "queued",
				sourceCount: 1,
				confidence: "single",
			},
		],
		round: { current: 1, total: 1 },
		sourcesRead: 6,
		next: "write 2 sections with one writer",
		phaseDurationsMs: { ask: 900, research: 12000, write: 4000, bogus: 5 },
		sections: { written: 2, planned: 2 },
		qualityDiagnostics: {
			abstained: false,
			verdictPresent: true,
			verdictFallback: false,
			repeatedSentences: 0,
			claimCount: 4,
			verifiedClaimCount: 3,
			contestedClaimCount: 0,
			claimsMerged: 1,
			answerTableCells: 6,
			derivedFigures: 2,
			criticRounds: 1,
			criticFindings: 0,
			needsEvidenceResolved: 0,
			roundsRun: 1,
			searches: 4,
			pagesRead: 5,
			sectionsPlanned: 2,
			sectionsWritten: 2,
			sectionsSupplemented: 0,
			wordCount: 320,
			writerRunaways: { length: 0, salvaged: 0, retried: 0, fallback: 0 },
		},
		evidence: {
			corroborated: 1,
			single: 1,
			inferred: 0,
			cut: 0,
			filteredCount: 2,
			sources: [
				{
					n: 1,
					title: "IEA",
					host: "iea.org",
					date: "2025-12-01",
					cited: true,
					snippet:
						"The EU added 65.1 GW of solar capacity in 2025, industry data show.",
				},
				{
					n: 2,
					title: "BBC",
					host: "bbc.com",
					date: null,
					cited: false,
					snippet: "",
				},
			],
		},
	};

	// Captured from `sanitizeAtlasV3ProgressDetails(v3Input)` before its
	// sanitiser moved here.
	const v3ExpectedOutput = {
		pipelineVersion: 3,
		queries: [],
		phase: "write",
		plan: [
			{
				id: "n1",
				question: "EU solar additions fell in 2025",
				status: "done",
				sourceCount: 2,
				confidence: "corroborated",
			},
			{
				id: "n2",
				question: "Rooftop demand drove the fall",
				status: "queued",
				sourceCount: 1,
				confidence: "single",
			},
		],
		round: { current: 1, total: 1 },
		sourcesRead: 6,
		next: "write 2 sections with one writer",
		phaseDurationsMs: { ask: 900, research: 12000, write: 4000 },
		sections: { written: 2, planned: 2 },
		qualityDiagnostics: {
			abstained: false,
			verdictPresent: true,
			verdictFallback: false,
			repeatedSentences: 0,
			claimCount: 4,
			verifiedClaimCount: 3,
			contestedClaimCount: 0,
			claimsMerged: 1,
			answerTableCells: 6,
			derivedFigures: 2,
			criticRounds: 1,
			criticFindings: 0,
			needsEvidenceResolved: 0,
			roundsRun: 1,
			searches: 4,
			pagesRead: 5,
			sectionsPlanned: 2,
			sectionsWritten: 2,
			sectionsSupplemented: 0,
			wordCount: 320,
			writerRunaways: { length: 0, salvaged: 0, retried: 0, fallback: 0 },
		},
		evidence: {
			corroborated: 1,
			single: 1,
			inferred: 0,
			cut: 0,
			filteredCount: 2,
			sources: [
				{
					n: 1,
					title: "IEA",
					host: "iea.org",
					date: "2025-12-01",
					cited: true,
					snippet:
						"The EU added 65.1 GW of solar capacity in 2025, industry data show.",
				},
				{
					n: 2,
					title: "BBC",
					host: "bbc.com",
					date: null,
					cited: false,
					snippet: "",
				},
			],
		},
	};

	it("sanitizes a stored v2 blob exactly as the pre-move sanitiser did", () => {
		expect(sanitizeAtlasV2ProgressDetails(v2Input)).toEqual(v2ExpectedOutput);
	});

	it("sanitizes a stored v3 blob exactly as the pre-move sanitiser did", () => {
		expect(sanitizeAtlasV3ProgressDetails(v3Input)).toEqual(v3ExpectedOutput);
	});

	it("routes both through the shared dispatcher to the same result", () => {
		expect(sanitizeAtlasJobProgressDetails(v2Input)).toEqual(v2ExpectedOutput);
		expect(sanitizeAtlasJobProgressDetails(v3Input)).toEqual(v3ExpectedOutput);
	});

	it("keeps the sanitizer caps at their pinned values", () => {
		expect(ATLAS_V2_MAX_EVIDENCE_SNIPPET_CHARS).toBe(1200);
		expect(ATLAS_V3_MAX_EVIDENCE_SNIPPET_CHARS).toBe(4000);
	});
});

// ---------------------------------------------------------------------------
// v2 sanitiser cases (moved from atlas-v2/progress.test.ts)
// ---------------------------------------------------------------------------

describe("sanitizeAtlasV2ProgressDetails", () => {
	it("drops junk and clamps the caps", () => {
		const sanitized = sanitizeAtlasV2ProgressDetails({
			pipelineVersion: 2,
			phase: "not-a-phase",
			plan: [
				{
					id: "q1",
					question: "Real question",
					status: "weird",
					sourceCount: -4,
				},
				{ id: "", question: "No id" },
				"nonsense",
				...Array.from({ length: ATLAS_V2_MAX_PLAN_ENTRIES + 5 }, (_, i) => ({
					id: `x${i}`,
					question: `Filler ${i}`,
					status: "queued",
					sourceCount: 1,
				})),
			],
			round: { current: 9, total: 2 },
			sourcesRead: "many",
			next: "  do   things  ",
			evidence: {
				corroborated: 1,
				sources: [
					{ n: 0, host: "bad.example" },
					{ n: 2, host: "", title: "no host" },
					{
						n: 3,
						host: "ok.example",
						title: "Fine",
						date: "",
						cited: "yes",
						snippet: "x".repeat(ATLAS_V2_MAX_EVIDENCE_SNIPPET_CHARS + 100),
					},
				],
			},
		});
		expect(sanitized.phase).toBe("plan");
		expect(sanitized.plan).toHaveLength(ATLAS_V2_MAX_PLAN_ENTRIES);
		expect(sanitized.plan[0]).toEqual({
			id: "q1",
			question: "Real question",
			status: "queued",
			sourceCount: 0,
		});
		// `current` can never exceed `total`.
		expect(sanitized.round).toEqual({ current: 2, total: 2 });
		expect(sanitized.sourcesRead).toBe(0);
		expect(sanitized.next).toBe("do things");
		expect(sanitized.evidence?.sources).toEqual([
			{
				n: 3,
				title: "Fine",
				host: "ok.example",
				date: null,
				cited: false,
				snippet: "x".repeat(ATLAS_V2_MAX_EVIDENCE_SNIPPET_CHARS),
			},
		]);
	});

	it("omits the runaway counters entirely when they were never set", () => {
		expect(
			sanitizeAtlasV2ProgressDetails({
				pipelineVersion: 2,
				phase: "plan",
				plan: [],
				round: { current: 1, total: 1 },
				sourcesRead: 0,
				next: "",
				writerRunaways: "not an object",
			}),
		).not.toHaveProperty("writerRunaways");
	});
});

// ---------------------------------------------------------------------------
// v3 sanitiser cases (moved from atlas-v3/progress.test.ts)
// ---------------------------------------------------------------------------

describe("sanitizeAtlasV3ProgressDetails", () => {
	it("recognises the v3 shape and nothing else", () => {
		expect(isAtlasV3ProgressDetails({ pipelineVersion: 3 })).toBe(true);
		expect(isAtlasV3ProgressDetails({ pipelineVersion: 2 })).toBe(false);
		expect(isAtlasV3ProgressDetails(null)).toBe(false);
	});

	it("bounds the plan, the round and the durations", () => {
		const details = sanitizeAtlasV3ProgressDetails({
			pipelineVersion: 3,
			phase: "nonsense",
			plan: [
				{ id: "n1", question: "q", status: "done", sourceCount: 2 },
				{ id: "", question: "dropped" },
			],
			round: { current: 9, total: 2 },
			sourcesRead: -4,
			next: "x".repeat(400),
			phaseDurationsMs: { write: 10, nonsense: 5 },
			qualityDiagnostics: { abstained: true, claimCount: 3 },
		});
		expect(details.phase).toBe("ask");
		expect(details.plan).toHaveLength(1);
		expect(details.round).toEqual({ current: 2, total: 2 });
		expect(details.sourcesRead).toBe(0);
		expect(details.next.length).toBeLessThanOrEqual(200);
		expect(details.phaseDurationsMs).toEqual({ write: 10 });
		expect(details.qualityDiagnostics?.abstained).toBe(true);
		expect(details.qualityDiagnostics?.claimCount).toBe(3);
		expect(details.qualityDiagnostics?.verdictPresent).toBe(false);
	});

	it("survives an empty blob", () => {
		const details = sanitizeAtlasV3ProgressDetails(undefined);
		expect(details.plan).toEqual([]);
		expect(details.round).toEqual({ current: 1, total: 1 });
	});

	it("clamps the plan to its own cap", () => {
		const details = sanitizeAtlasV3ProgressDetails({
			pipelineVersion: 3,
			plan: Array.from({ length: ATLAS_V3_MAX_PLAN_ENTRIES + 5 }, (_, i) => ({
				id: `n${i}`,
				question: `Node ${i}`,
				status: "queued",
				sourceCount: 0,
			})),
		});
		expect(details.plan).toHaveLength(ATLAS_V3_MAX_PLAN_ENTRIES);
	});

	it("keeps a local evidence source with no host, and still drops a hostless web one", () => {
		const details = sanitizeAtlasV3ProgressDetails({
			pipelineVersion: 3,
			phase: "render",
			phaseDurationsMs: { local: 12, ask: 3 },
			evidence: {
				corroborated: 1,
				sources: [
					{
						n: 1,
						title: "Electricity bill 2025.pdf",
						host: "",
						date: null,
						cited: true,
						snippet: "Our household used 1,234 kWh.",
						kind: "local",
					},
					{ n: 2, title: "No host", host: "", kind: "web" },
					{ n: 3, title: "Legacy row", host: "iea.org" },
				],
			},
			qualityDiagnostics: {
				localSources: { resolved: 2, read: 1, quotes: 3, unavailable: -1 },
			},
		});
		expect(details.evidence?.sources).toEqual([
			{
				n: 1,
				title: "Electricity bill 2025.pdf",
				host: "",
				date: null,
				cited: true,
				snippet: "Our household used 1,234 kWh.",
				kind: "local",
			},
			{
				n: 3,
				title: "Legacy row",
				host: "iea.org",
				date: null,
				cited: false,
				snippet: "",
			},
		]);
		expect(details.phaseDurationsMs).toEqual({ local: 12, ask: 3 });
		expect(details.qualityDiagnostics?.localSources).toEqual({
			resolved: 2,
			read: 1,
			quotes: 3,
			unavailable: 0,
		});
	});
});

// ---------------------------------------------------------------------------
// Dispatch (v1 / v2 / v3)
// ---------------------------------------------------------------------------

describe("sanitizeAtlasJobProgressDetails dispatch", () => {
	it("routes a v3 blob to the v3 sanitiser", () => {
		expect(isAtlasV3ProgressDetails({ pipelineVersion: 3 })).toBe(true);
		const sanitized = sanitizeAtlasJobProgressDetails({
			pipelineVersion: 3,
			phase: "render",
			plan: [],
			round: { current: 1, total: 1 },
			sourcesRead: 3,
			next: "render",
		});
		expect(sanitized).toMatchObject({ pipelineVersion: 3, phase: "render" });
	});

	it("routes a v2 blob to the v2 sanitiser", () => {
		expect(isAtlasV2ProgressDetails({ pipelineVersion: 2 })).toBe(true);
		const sanitized = sanitizeAtlasJobProgressDetails({
			pipelineVersion: 2,
			phase: "render",
			plan: [],
			round: { current: 1, total: 1 },
			sourcesRead: 3,
			next: "render",
		});
		expect(sanitized).toMatchObject({ pipelineVersion: 2, phase: "render" });
	});

	it("leaves v1's shape exactly as it was", () => {
		expect(isAtlasV2ProgressDetails({ queries: ["a"] })).toBe(false);
		expect(
			sanitizeAtlasJobProgressDetails({
				queries: ["solar capacity 2026"],
				roundKind: "gap-fill",
				focus: ["grid queue"],
			}),
		).toEqual({
			queries: ["solar capacity 2026"],
			roundKind: "gap-fill",
			focus: ["grid queue"],
		});
		expect(sanitizeAtlasJobProgressDetails(null)).toEqual({ queries: [] });
	});
});
