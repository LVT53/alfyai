import { describe, expect, it } from "vitest";
import { sanitizeAtlasJobProgressDetails } from "../atlas/read-model";
import {
	ATLAS_V2_MAX_EVIDENCE_SNIPPET_CHARS,
	ATLAS_V2_MAX_PLAN_ENTRIES,
	buildAtlasV2ProgressDetails,
	buildAtlasV2ProgressEvidence,
	isAtlasV2ProgressDetails,
	sanitizeAtlasV2ProgressDetails,
} from "./progress";
import type { AtlasV2IndexedSource, AtlasV2Plan } from "./types";

const PLAN: AtlasV2Plan = {
	questions: [
		{ id: "q1", question: "What capacity was added?" },
		{ id: "q2", question: "What does the regulator require?" },
	],
	sections: [
		{ id: "s1", title: "Capacity", brief: "Capacity", questionIds: ["q1"] },
		{ id: "s2", title: "Rules", brief: "Rules", questionIds: ["q2"] },
	],
};

function source(n: number): AtlasV2IndexedSource {
	return {
		n,
		canonicalUrl: `https://source${n}.example/a`,
		host: `source${n}.example`,
		organisation: `source${n}.example`,
		title: `Report ${n}`,
		date: "2026-04-01",
		snippets: [`Evidence for source ${n} with a figure of ${n} GW.`],
		pageExcerpt: null,
		questionIds: ["q1"],
	};
}

describe("buildAtlasV2ProgressDetails", () => {
	it("emits the contract shape with per-question status and a next line", () => {
		const details = buildAtlasV2ProgressDetails({
			phase: "research",
			language: "en",
			plan: PLAN,
			round: { current: 2, total: 3 },
			sourcesRead: 17,
			runningQuestionIds: ["q2"],
			doneQuestionIds: ["q1"],
			sourceCountByQuestion: { q1: 5 },
		});
		expect(details).toMatchObject({
			pipelineVersion: 2,
			phase: "research",
			round: { current: 2, total: 3 },
			sourcesRead: 17,
		});
		expect(details.plan).toEqual([
			{
				id: "q1",
				question: "What capacity was added?",
				status: "done",
				sourceCount: 5,
			},
			{
				id: "q2",
				question: "What does the regulator require?",
				status: "running",
				sourceCount: 0,
			},
		]);
		expect(details.next).toContain("round 2 of 3");
		expect(details.evidence).toBeUndefined();
	});

	it("writes the next line in Hungarian for a Hungarian report", () => {
		const details = buildAtlasV2ProgressDetails({
			phase: "write",
			language: "hu",
			plan: PLAN,
			round: { current: 1, total: 1 },
			sourcesRead: 0,
		});
		expect(details.next).toContain("szakasz megírása");
	});

	it("carries per-phase durations once there are any", () => {
		expect(
			buildAtlasV2ProgressDetails({
				phase: "write",
				language: "en",
				plan: PLAN,
				round: { current: 1, total: 1 },
				sourcesRead: 0,
				phaseDurationsMs: {},
			}).phaseDurationsMs,
		).toBeUndefined();
		expect(
			buildAtlasV2ProgressDetails({
				phase: "write",
				language: "en",
				plan: PLAN,
				round: { current: 1, total: 1 },
				sourcesRead: 0,
				phaseDurationsMs: { plan: 1200, research: 45_000 },
			}).phaseDurationsMs,
		).toEqual({ plan: 1200, research: 45_000 });
	});
});

describe("sanitizePhaseDurations (through the details sanitiser)", () => {
	const sanitize = (phaseDurationsMs: unknown) =>
		sanitizeAtlasV2ProgressDetails({
			pipelineVersion: 2,
			phase: "verify",
			plan: [],
			round: { current: 1, total: 1 },
			sourcesRead: 0,
			next: "",
			phaseDurationsMs,
		}).phaseDurationsMs;

	it("keeps the known phase keys as non-negative integers", () => {
		expect(sanitize({ plan: 1200.7, verify: -5, write: 900 })).toEqual({
			plan: 1200,
			verify: 0,
			write: 900,
		});
	});

	it("drops an unknown key so the job row cannot be grown", () => {
		expect(sanitize({ plan: 10, somethingElse: 99 })).toEqual({ plan: 10 });
	});

	it("is absent when there is nothing usable", () => {
		expect(sanitize(undefined)).toBeUndefined();
		expect(sanitize({ nope: 1 })).toBeUndefined();
		expect(sanitize("not an object")).toBeUndefined();
	});
});

describe("buildAtlasV2ProgressEvidence", () => {
	it("carries the snippet the eval harness checks numbers against", () => {
		const evidence = buildAtlasV2ProgressEvidence({
			index: {
				sources: [source(1), source(2)],
				dropped: [],
				filteredCount: 4,
				byQuestion: {},
			},
			totals: { corroborated: 3, single: 2, inferred: 1, cut: 1 },
			citedSourceNumbers: [1],
			publishedSources: [source(1), source(2)],
		});
		expect(evidence).toMatchObject({
			corroborated: 3,
			single: 2,
			inferred: 1,
			cut: 1,
			filteredCount: 4,
		});
		expect(evidence.sources[0]).toMatchObject({
			n: 1,
			host: "source1.example",
			date: "2026-04-01",
			cited: true,
		});
		expect(evidence.sources[0].snippet).toContain("1 GW");
		expect(evidence.sources[1].cited).toBe(false);
	});
});

describe("sanitizeAtlasV2ProgressDetails", () => {
	it("keeps a well-formed blob intact", () => {
		const details = buildAtlasV2ProgressDetails({
			phase: "verify",
			language: "en",
			plan: PLAN,
			round: { current: 1, total: 2 },
			sourcesRead: 9,
			confidenceByQuestion: { q1: "corroborated" },
			evidence: buildAtlasV2ProgressEvidence({
				index: {
					sources: [source(1)],
					dropped: [],
					filteredCount: 2,
					byQuestion: {},
				},
				totals: { corroborated: 1, single: 0, inferred: 0, cut: 0 },
				citedSourceNumbers: [1],
				publishedSources: [source(1)],
			}),
		});
		expect(sanitizeAtlasV2ProgressDetails(details)).toEqual(details);
	});

	it("carries the writer runaway counters to the evaluation intact", () => {
		const details = buildAtlasV2ProgressDetails({
			phase: "render",
			language: "en",
			plan: PLAN,
			round: { current: 1, total: 1 },
			sourcesRead: 4,
			sections: { written: 3, planned: 4 },
			writerRunaways: { length: 2, salvaged: 1, retried: 1, fallback: 1 },
		});
		expect(details.writerRunaways).toEqual({
			length: 2,
			salvaged: 1,
			retried: 1,
			fallback: 1,
		});
		expect(sanitizeAtlasV2ProgressDetails(details)).toEqual(details);
	});

	it("omits the runaway counters entirely before the writer has run", () => {
		const details = buildAtlasV2ProgressDetails({
			phase: "plan",
			language: "en",
			plan: PLAN,
			round: { current: 1, total: 1 },
			sourcesRead: 0,
		});
		expect(details).not.toHaveProperty("writerRunaways");
		expect(
			sanitizeAtlasV2ProgressDetails({
				...details,
				writerRunaways: "not an object",
			}),
		).not.toHaveProperty("writerRunaways");
	});

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
});

describe("sanitizeAtlasJobProgressDetails dispatch", () => {
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
