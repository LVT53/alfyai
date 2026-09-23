import { describe, expect, it } from "vitest";
import {
	atlasV3QuoteStillStated,
	atlasV3SourceIsTimeSensitive,
	planAtlasV3SeedRechecks,
} from "./freshness";
import type {
	AtlasV3Claim,
	AtlasV3EvidenceBank,
	AtlasV3Quote,
	AtlasV3Source,
	AtlasV3SourceTier,
} from "./types";

const NOW = new Date("2026-09-24T00:00:00Z");

function web(
	id: string,
	tier: AtlasV3SourceTier = "press",
	retrievedAt: string | null = null,
): AtlasV3Source {
	return {
		id,
		canonicalUrl: `https://example.org/${id}`,
		host: "example.org",
		publisher: `pub-${id}`,
		title: id,
		date: null,
		tier,
		read: true,
		...(retrievedAt ? { retrievedAt } : {}),
	};
}

function claim(
	id: string,
	evidenceIds: string[],
	period: string | null,
	asOf: string | null = null,
): AtlasV3Claim {
	return {
		id,
		entity: "EU",
		metric: "solar additions",
		value: "65.1",
		unit: "GW",
		period,
		asOf,
		series: null,
		evidenceIds,
		status: "single",
	};
}

function quote(
	id: string,
	sourceId: string,
	text = "a long enough quote text",
): AtlasV3Quote {
	return { id, sourceId, text, goal: "g" };
}

describe("atlasV3SourceIsTimeSensitive", () => {
	const cases: Array<{
		name: string;
		tier?: AtlasV3SourceTier;
		claims: Array<{ period: string | null; asOf?: string | null }>;
		quotes?: number;
		expected: boolean;
	}> = [
		{
			name: "a claim with no period and no publication date",
			claims: [{ period: null }],
			expected: true,
		},
		{
			name: "a claim for this year",
			claims: [{ period: "2026" }],
			expected: true,
		},
		{
			name: "a claim for last year",
			claims: [{ period: "Q4 2025" }],
			expected: true,
		},
		{
			name: "an old period, freshly published",
			claims: [{ period: "2023", asOf: "2025-06-01" }],
			expected: true,
		},
		{
			name: "an explicit older period (a 2023 statistic)",
			claims: [{ period: "2023" }],
			expected: false,
		},
		{
			name: "a 2019 statute",
			tier: "primary",
			claims: [{ period: "2019", asOf: "2019-05-01" }],
			expected: false,
		},
		{
			name: "a period written without a year",
			claims: [{ period: "monthly" }],
			expected: true,
		},
		{
			name: "one old and one current claim",
			claims: [{ period: "2019" }, { period: null }],
			expected: true,
		},
		{
			name: "an aggregator with quotes and no claims",
			tier: "aggregator",
			claims: [],
			quotes: 1,
			expected: true,
		},
		{
			name: "a forum with quotes and no claims",
			tier: "weak",
			claims: [],
			quotes: 2,
			expected: true,
		},
		{
			name: "a primary source with quotes and no claims",
			tier: "primary",
			claims: [],
			quotes: 1,
			expected: false,
		},
		{
			name: "a press source with quotes and no claims",
			tier: "press",
			claims: [],
			quotes: 1,
			expected: false,
		},
		{
			name: "an aggregator with no quotes at all",
			tier: "aggregator",
			claims: [],
			quotes: 0,
			expected: false,
		},
	];
	for (const entry of cases) {
		it(`${entry.expected ? "is" : "is not"} time-sensitive: ${entry.name}`, () => {
			const source = web("s1", entry.tier ?? "press");
			expect(
				atlasV3SourceIsTimeSensitive({
					source,
					claims: entry.claims.map((shape, index) =>
						claim(`c${index + 1}`, ["e1"], shape.period, shape.asOf ?? null),
					),
					quotes: Array.from({ length: entry.quotes ?? 1 }, (_unused, index) =>
						quote(`e${index + 1}`, "s1"),
					),
					now: NOW,
				}),
			).toBe(entry.expected);
		});
	}

	it("never treats a user document as time-sensitive", () => {
		expect(
			atlasV3SourceIsTimeSensitive({
				source: {
					id: "s9",
					kind: "local",
					canonicalUrl: "atlas-local:art-1",
					host: "",
					publisher: "user-documents",
					title: "Bill.pdf",
					date: null,
					tier: "user_document",
					read: true,
					displayArtifactId: "art-1",
					promptArtifactId: "art-1-n",
					origin: "attachment",
				},
				claims: [claim("c1", ["e1"], null)],
				now: NOW,
			}),
		).toBe(false);
	});
});

describe("planAtlasV3SeedRechecks", () => {
	/**
	 * s1 current figure read 3 days ago, s2 current figure read 30 days ago,
	 * s3 a 2019 statute read long ago, s4 current, no retrieval time, s5 no
	 * quote at all, s6 current figure read 20 days ago, cited, s7 a user doc.
	 */
	function bank(): AtlasV3EvidenceBank {
		return {
			sources: [
				web("s1", "press", "2026-09-21T00:00:00Z"),
				web("s2", "press", "2026-08-25T00:00:00Z"),
				web("s3", "primary", "2025-01-01T00:00:00Z"),
				web("s4", "press"),
				web("s5", "press", "2026-01-01T00:00:00Z"),
				web("s6", "primary", "2026-09-04T00:00:00Z"),
				{
					id: "s7",
					kind: "local",
					canonicalUrl: "atlas-local:art-1",
					host: "",
					publisher: "user-documents",
					title: "Bill.pdf",
					date: null,
					tier: "user_document",
					read: true,
					displayArtifactId: "art-1",
					promptArtifactId: "art-1-n",
					origin: "attachment",
				},
			],
			quotes: [
				quote("e1", "s1"),
				quote("e2", "s2"),
				quote("e3", "s3"),
				quote("e4", "s4"),
				quote("e6", "s6"),
				quote("e7", "s6"),
				quote("e8", "s7"),
			],
			claims: [
				claim("c1", ["e1"], null),
				claim("c2", ["e2"], "2026"),
				claim("c3", ["e3"], "2019"),
				claim("c4", ["e4"], null),
				claim("c6", ["e6", "e7"], "2025"),
				claim("c8", ["e8"], null),
			],
			filteredCount: 0,
		};
	}

	it("trusts what a Continue may reuse and rechecks the rest, cited first", () => {
		const plan = planAtlasV3SeedRechecks({
			bank: bank(),
			action: "continue",
			now: NOW,
			windowDays: 14,
			budget: 10,
			citedSourceIds: ["s6"],
			fallbackRetrievedAt: null,
		});
		expect(plan.trusted.sort()).toEqual(["s1", "s3", "s5"]);
		// s6 is cited, then by claim load (s6 has two readings), then id.
		expect(plan.recheck).toEqual(["s6", "s2", "s4"]);
		expect(plan.overBudget).toEqual([]);
	});

	it("falls back to the parent's completion time for a source with no retrieval time", () => {
		const plan = planAtlasV3SeedRechecks({
			bank: bank(),
			action: "continue",
			now: NOW,
			windowDays: 14,
			budget: 10,
			citedSourceIds: [],
			fallbackRetrievedAt: "2026-09-20T00:00:00Z",
		});
		expect(plan.trusted).toContain("s4");
	});

	it("rechecks every time-sensitive source on a Revise, whatever its age", () => {
		const plan = planAtlasV3SeedRechecks({
			bank: bank(),
			action: "revise",
			now: NOW,
			windowDays: 14,
			budget: 10,
			citedSourceIds: [],
			fallbackRetrievedAt: null,
		});
		expect(plan.trusted.sort()).toEqual(["s3", "s5"]);
		expect(plan.recheck.sort()).toEqual(["s1", "s2", "s4", "s6"]);
	});

	it("drops what the budget cannot reach instead of trusting it", () => {
		const plan = planAtlasV3SeedRechecks({
			bank: bank(),
			action: "revise",
			now: NOW,
			windowDays: 0,
			budget: 1,
			citedSourceIds: ["s2"],
			fallbackRetrievedAt: null,
		});
		expect(plan.recheck).toEqual(["s2"]);
		expect(plan.overBudget).toEqual(["s6", "s1", "s4"]);
		expect(plan.trusted).not.toContain("s1");
	});
});

describe("atlasV3QuoteStillStated", () => {
	const seeded = quote(
		"e1",
		"s1",
		"The EU added 65.1 GW of solar capacity in 2025, industry data show.",
	);

	it("confirms a quote the page still states, through markdown and typography", () => {
		expect(
			atlasV3QuoteStillStated(
				seeded,
				"# Solar\n\nThe **EU** added 65.1 GW of solar  capacity in 2025, industry data show. More text.",
			),
		).toBe(true);
	});

	it("refuses a quote whose figure the page revised", () => {
		expect(
			atlasV3QuoteStillStated(
				seeded,
				"The EU added 70.2 GW of solar capacity in 2025, industry data show.",
			),
		).toBe(false);
	});

	it("refuses a quote the page no longer carries", () => {
		expect(
			atlasV3QuoteStillStated(
				seeded,
				"Solar additions were revised this week.",
			),
		).toBe(false);
	});
});
