import { describe, expect, it } from "vitest";
import {
	addAtlasV3Quote,
	addAtlasV3Source,
	assignAtlasV3CitationNumbers,
	createAtlasV3Bank,
	freezeAtlasV3Bank,
} from "./evidence-bank";
import {
	buildAtlasV3NextLine,
	buildAtlasV3ProgressDetails,
	buildAtlasV3ProgressEvidence,
	isAtlasV3ProgressDetails,
	sanitizeAtlasV3ProgressDetails,
} from "./progress";
import type { AtlasV3Outline } from "./types";

const OUTLINE: AtlasV3Outline = {
	nodes: [
		{
			id: "n1",
			title: "EU solar additions fell in 2025",
			claim: "c",
			needs: [],
			evidenceIds: ["e1", "e2"],
			status: "ready",
		},
		{
			id: "n2",
			title: "Rooftop demand drove the fall",
			claim: "c",
			needs: ["member-state split"],
			evidenceIds: ["e3"],
			status: "thin",
		},
	],
	cut: [],
};

function bank() {
	const state = createAtlasV3Bank();
	const iea = addAtlasV3Source(state, {
		url: "https://iea.org/a",
		title: "IEA",
		publishedAt: "2025-12-01",
	});
	addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "The EU added 65.1 GW of solar capacity in 2025, industry data show.",
		goal: "g",
	});
	addAtlasV3Source(state, {
		url: "https://bbc.com/a",
		title: "BBC",
		publishedAt: null,
	});
	return freezeAtlasV3Bank(state);
}

describe("buildAtlasV3ProgressDetails", () => {
	it("shows the research questions before the outline exists", () => {
		const details = buildAtlasV3ProgressDetails({
			phase: "research",
			language: "en",
			outline: null,
			subQuestions: ["EU solar 2025", "EU solar 2024"],
			runningQuestions: ["EU solar 2025"],
			doneQuestions: ["EU solar 2024"],
			round: { current: 1, total: 2 },
			sourcesRead: 3,
		});
		expect(details.pipelineVersion).toBe(3);
		expect(details.queries).toEqual([]);
		expect(details.plan.map((entry) => entry.status)).toEqual([
			"running",
			"done",
		]);
		expect(details.next).toContain("round 1 of 2");
	});

	it("shows the outline's nodes once it exists", () => {
		const details = buildAtlasV3ProgressDetails({
			phase: "write",
			language: "en",
			outline: OUTLINE,
			round: { current: 1, total: 1 },
			sourcesRead: 6,
			sections: { written: 2, planned: 2 },
		});
		expect(details.plan[0].question).toBe("EU solar additions fell in 2025");
		expect(details.plan[0].confidence).toBe("corroborated");
		expect(details.plan[1].confidence).toBe("single");
		expect(details.sections).toEqual({ written: 2, planned: 2 });
	});
});

describe("buildAtlasV3ProgressEvidence", () => {
	it("publishes every source and marks the cited ones", () => {
		const evidence = buildAtlasV3ProgressEvidence({
			bank: bank(),
			totals: {
				corroborated: 1,
				single: 0,
				inferred: 0,
				repeated: 0,
				cut: 0,
				needsEvidence: 0,
			},
			citations: assignAtlasV3CitationNumbers({
				bank: bank(),
				citedEvidenceIds: ["e1"],
			}),
		});
		expect(evidence.sources).toHaveLength(2);
		expect(evidence.sources[0].cited).toBe(true);
		expect(evidence.sources[1].cited).toBe(false);
		// The harness re-checks figures against the QUOTES, not a page dump.
		expect(evidence.sources[0].snippet).toContain("65.1 GW");
	});

	/**
	 * Eight sources hit the old 1200-character cap on one staging job, and the
	 * evaluation then reported figures a CITED quote states as unsupported.
	 */
	it("writes the cited quotes first, before the cap can reach them", () => {
		const state = createAtlasV3Bank();
		const source = addAtlasV3Source(state, {
			url: "https://nice.org.uk/guidance/ng28",
			title: "NG28",
			publishedAt: "2026-01-01",
		});
		const padding = Array.from({ length: 12 }, (_unused, index) =>
			addAtlasV3Quote(state, {
				sourceId: source?.id ?? "",
				text: `Background paragraph ${index} of the guideline committee's discussion of the evidence it reviewed, at length.`,
				goal: "g",
			}),
		);
		const cited = addAtlasV3Quote(state, {
			sourceId: source?.id ?? "",
			text: "Major adverse cardiovascular events fall from 123 to 107-115 per 1,000.",
			goal: "g",
		});
		expect(padding.at(-1)?.id).toBeDefined();
		const bankState = freezeAtlasV3Bank(state);
		const evidence = buildAtlasV3ProgressEvidence({
			bank: bankState,
			totals: {
				corroborated: 0,
				single: 1,
				inferred: 0,
				repeated: 0,
				cut: 0,
				needsEvidence: 0,
			},
			citations: assignAtlasV3CitationNumbers({
				bank: bankState,
				citedEvidenceIds: [cited?.id ?? ""],
			}),
		});
		expect(evidence.sources[0].snippet.startsWith("Major adverse")).toBe(true);
		expect(evidence.sources[0].snippet).toContain("107-115 per 1,000");
	});

	/**
	 * An abstaining report numbers sources no sentence cites — the pages it
	 * read. Rebuilding the card's order from quotes alone gave those a different
	 * `[n]` than the report printed, which reads as a citation mismatch.
	 */
	it("keeps the numbers the report minted for uncited sources", () => {
		const reportCitations = assignAtlasV3CitationNumbers({
			bank: bank(),
			citedEvidenceIds: [],
			extraSourceIds: ["s2", "s1"],
		});
		const evidence = buildAtlasV3ProgressEvidence({
			bank: bank(),
			totals: {
				corroborated: 0,
				single: 0,
				inferred: 2,
				repeated: 0,
				cut: 0,
				needsEvidence: 0,
			},
			citations: reportCitations,
		});
		expect(reportCitations.numberBySourceId.get("s2")).toBe(1);
		expect(evidence.sources.map((source) => source.host)).toEqual([
			"bbc.com",
			"iea.org",
		]);
	});
});

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
});

describe("buildAtlasV3NextLine", () => {
	it("has a line for every phase, in both languages", () => {
		for (const language of ["en", "hu"] as const) {
			for (const phase of [
				"ask",
				"research",
				"outline",
				"answer",
				"write",
				"critic",
				"verify",
				"render",
			] as const) {
				expect(
					buildAtlasV3NextLine({
						phase,
						language,
						sectionCount: 3,
						questionCount: 4,
						round: { current: 1, total: 2 },
					}).length,
				).toBeGreaterThan(0);
			}
		}
	});
});
