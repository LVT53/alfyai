import { describe, expect, it } from "vitest";
import {
	addAtlasV3Claim,
	addAtlasV3Quote,
	addAtlasV3Source,
	assignAtlasV3CitationNumbers,
	atlasV3ClaimKey,
	buildAtlasV3ReadPrompt,
	capAtlasV3Bank,
	createAtlasV3Bank,
	fileAtlasV3Read,
	freezeAtlasV3Bank,
	parseAtlasV3Read,
	thawAtlasV3Bank,
} from "./evidence-bank";

function bankWithSource(url = "https://iea.org/reports/solar-2025") {
	const state = createAtlasV3Bank();
	const source = addAtlasV3Source(state, {
		url,
		title: "Renewables 2025",
		publishedAt: "2025-12-01",
		read: true,
	});
	if (!source) throw new Error("expected a source");
	return { state, source };
}

describe("addAtlasV3Source", () => {
	it("mints one id per source and canonicalises the URL", () => {
		const { state, source } = bankWithSource(
			"https://www.iea.org/reports/solar-2025/?utm_source=x#top",
		);
		expect(source.id).toBe("s1");
		expect(source.canonicalUrl).toBe("https://iea.org/reports/solar-2025");
		expect(source.tier).toBe("primary");
		expect(state.sources).toHaveLength(1);
	});

	it("returns the existing source for the same canonical URL", () => {
		const { state } = bankWithSource();
		const again = addAtlasV3Source(state, {
			url: "https://iea.org/reports/solar-2025",
			title: "Renewables 2025",
			publishedAt: null,
		});
		expect(again?.id).toBe("s1");
		expect(state.sources).toHaveLength(1);
	});

	it("collapses the same article reached through a mirror host", () => {
		const { state } = bankWithSource(
			"https://example.com/news/eu-solar-additions-2025",
		);
		const mirror = addAtlasV3Source(state, {
			url: "https://cdn.example.com/news/eu-solar-additions-2025",
			title: "Renewables 2025",
			publishedAt: null,
		});
		expect(mirror?.id).toBe("s1");
		expect(state.sources).toHaveLength(1);
		expect(state.filteredCount).toBe(1);
	});

	it("refuses a redirect stub, a status stub and a social profile", () => {
		const state = createAtlasV3Bank();
		expect(
			addAtlasV3Source(state, {
				url: "https://example.com/a",
				title: "301 Moved Permanently",
				publishedAt: null,
			}),
		).toBeNull();
		expect(
			addAtlasV3Source(state, {
				url: "https://linkedin.com/company/x",
				title: "A company",
				publishedAt: null,
			}),
		).toBeNull();
		expect(
			addAtlasV3Source(state, {
				url: "not a url",
				title: "x",
				publishedAt: null,
			}),
		).toBeNull();
		expect(state.filteredCount).toBe(3);
	});

	it("normalises a bare year into a date", () => {
		const state = createAtlasV3Bank();
		const source = addAtlasV3Source(state, {
			url: "https://iea.org/a",
			title: "x",
			publishedAt: "2024",
		});
		expect(source?.date).toBe("2024-01-01");
	});
});

describe("addAtlasV3Quote", () => {
	it("keeps a quote verbatim and dedupes it", () => {
		const { state, source } = bankWithSource();
		const text =
			"The European Union added 65.1 GW of new solar capacity in 2025.";
		const first = addAtlasV3Quote(state, {
			sourceId: source.id,
			text,
			goal: "g",
		});
		const second = addAtlasV3Quote(state, {
			sourceId: source.id,
			text: `  ${text}  `,
			goal: "g",
		});
		expect(first?.id).toBe("e1");
		expect(second?.id).toBe("e1");
		expect(state.quotes).toHaveLength(1);
	});

	it("refuses a quote too short to support anything", () => {
		const { state, source } = bankWithSource();
		expect(
			addAtlasV3Quote(state, {
				sourceId: source.id,
				text: "65.1 GW",
				goal: "g",
			}),
		).toBeNull();
	});

	it("refuses a quote against a source that is not in the bank", () => {
		const { state } = bankWithSource();
		expect(
			addAtlasV3Quote(state, {
				sourceId: "s99",
				text: "The European Union added 65.1 GW of new solar capacity in 2025.",
				goal: "g",
			}),
		).toBeNull();
	});
});

describe("addAtlasV3Claim", () => {
	function twoPublisherBank() {
		const state = createAtlasV3Bank();
		const iea = addAtlasV3Source(state, {
			url: "https://iea.org/a",
			title: "IEA",
			publishedAt: "2025-12-01",
		});
		const bbc = addAtlasV3Source(state, {
			url: "https://bbc.com/news/a",
			title: "BBC",
			publishedAt: "2025-12-02",
		});
		const q1 = addAtlasV3Quote(state, {
			sourceId: iea?.id ?? "",
			text: "The EU added 65.1 GW of solar capacity in 2025, the first fall since 2016.",
			goal: "g",
		});
		const q2 = addAtlasV3Quote(state, {
			sourceId: bbc?.id ?? "",
			text: "Europe installed 65.1 GW of solar last year, industry figures show.",
			goal: "g",
		});
		return { state, q1: q1?.id ?? "", q2: q2?.id ?? "" };
	}

	it("marks a claim verified only with two independent publishers", () => {
		const { state, q1, q2 } = twoPublisherBank();
		const single = addAtlasV3Claim(state, {
			entity: "EU-27",
			metric: "solar additions",
			value: "65.1",
			unit: "GW",
			period: "2025",
			asOf: "2025-12-01",
			series: "grid-connected additions",
			evidenceIds: [q1],
		});
		expect(single?.status).toBe("single");
		const merged = addAtlasV3Claim(state, {
			entity: "EU-27",
			metric: "solar additions",
			value: "65.1",
			unit: "GW",
			period: "2025",
			asOf: null,
			series: "grid-connected additions",
			evidenceIds: [q2],
		});
		expect(merged?.id).toBe(single?.id);
		expect(merged?.status).toBe("verified");
		expect(state.claims).toHaveLength(1);
	});

	it("does NOT call two different series a disagreement", () => {
		const { state, q1, q2 } = twoPublisherBank();
		addAtlasV3Claim(state, {
			entity: "EU-27",
			metric: "solar additions",
			value: "65.1",
			unit: "GW",
			period: "2025",
			asOf: null,
			series: "grid-connected additions",
			evidenceIds: [q1],
		});
		const other = addAtlasV3Claim(state, {
			entity: "EU-27",
			metric: "solar additions",
			value: "70",
			unit: "GW",
			period: "2025",
			asOf: null,
			series: "installed capacity",
			evidenceIds: [q2],
		});
		expect(other?.status).toBe("single");
		expect(state.claims.every((claim) => claim.status !== "contested")).toBe(
			true,
		);
	});

	it("marks BOTH sides contested when the same series disagrees", () => {
		const { state, q1, q2 } = twoPublisherBank();
		addAtlasV3Claim(state, {
			entity: "EU-27",
			metric: "solar additions",
			value: "65.1",
			unit: "GW",
			period: "2025",
			asOf: null,
			series: "grid-connected additions",
			evidenceIds: [q1],
		});
		addAtlasV3Claim(state, {
			entity: "EU-27",
			metric: "solar additions",
			value: "70",
			unit: "GW",
			period: "2025",
			asOf: null,
			series: "grid-connected additions",
			evidenceIds: [q2],
		});
		expect(state.claims.every((claim) => claim.status === "contested")).toBe(
			true,
		);
	});

	it("refuses a claim with no evidence", () => {
		const { state } = twoPublisherBank();
		expect(
			addAtlasV3Claim(state, {
				entity: "EU",
				metric: "x",
				value: "1",
				unit: null,
				period: null,
				asOf: null,
				series: null,
				evidenceIds: ["e99"],
			}),
		).toBeNull();
	});

	it("treats formatting differences in a value as the same value", () => {
		const { state, q1, q2 } = twoPublisherBank();
		const first = addAtlasV3Claim(state, {
			entity: "EU",
			metric: "additions",
			value: "65,1",
			unit: "GW",
			period: "2025",
			asOf: null,
			series: null,
			evidenceIds: [q1],
		});
		const second = addAtlasV3Claim(state, {
			entity: "EU",
			metric: "additions",
			value: "65.1",
			unit: "GW",
			period: "2025",
			asOf: null,
			series: null,
			evidenceIds: [q2],
		});
		expect(second?.id).toBe(first?.id);
	});
});

describe("atlasV3ClaimKey", () => {
	it("ignores case and whitespace but not the series", () => {
		expect(
			atlasV3ClaimKey({
				entity: " EU ",
				metric: "Additions",
				period: "2025",
				series: "a",
			}),
		).toBe(
			atlasV3ClaimKey({
				entity: "eu",
				metric: "additions",
				period: "2025",
				series: "a",
			}),
		);
		expect(
			atlasV3ClaimKey({
				entity: "EU",
				metric: "additions",
				period: "2025",
				series: "a",
			}),
		).not.toBe(
			atlasV3ClaimKey({
				entity: "EU",
				metric: "additions",
				period: "2025",
				series: "b",
			}),
		);
	});
});

describe("parseAtlasV3Read", () => {
	it("reads quotes and claims and links them", () => {
		const read = parseAtlasV3Read(
			JSON.stringify({
				quotes: [
					{ text: "The EU added 65.1 GW of solar capacity in 2025." },
					{ text: "That is 0.7% below the 65.6 GW added in 2024." },
				],
				claims: [
					{
						entity: "EU-27",
						metric: "solar additions",
						value: "65.1",
						unit: "GW",
						period: "2025",
						asOf: "2025-12-01",
						series: "grid-connected additions",
						quoteIndexes: [0],
					},
				],
			}),
		);
		expect(read?.quotes).toHaveLength(2);
		expect(read?.claims[0].value).toBe("65.1");
		expect(read?.useless).toBe(false);
	});

	it("drops a claim whose quote index points nowhere", () => {
		const read = parseAtlasV3Read(
			JSON.stringify({
				quotes: [{ text: "The EU added 65.1 GW of solar capacity in 2025." }],
				claims: [
					{ entity: "EU", metric: "m", value: "1", quoteIndexes: [7] },
					{ entity: "EU", metric: "m", value: "1", quoteIndexes: [] },
				],
			}),
		);
		expect(read?.claims).toEqual([]);
	});

	it("calls an empty read useless", () => {
		const read = parseAtlasV3Read(JSON.stringify({ quotes: [], claims: [] }));
		expect(read?.useless).toBe(true);
	});

	it("honours an explicit useless flag for a navigation page", () => {
		const read = parseAtlasV3Read(
			JSON.stringify({ useless: true, quotes: [], claims: [] }),
		);
		expect(read?.useless).toBe(true);
	});

	it("returns null on unparsable text", () => {
		expect(parseAtlasV3Read("sorry, I cannot")).toBeNull();
	});

	it('treats the string "null" as absent', () => {
		const read = parseAtlasV3Read(
			JSON.stringify({
				quotes: [{ text: "The EU added 65.1 GW of solar capacity in 2025." }],
				claims: [
					{
						entity: "EU",
						metric: "m",
						value: "1",
						unit: "null",
						series: "null",
						quoteIndexes: [0],
					},
				],
			}),
		);
		expect(read?.claims[0].unit).toBeNull();
		expect(read?.claims[0].series).toBeNull();
	});
});

describe("fileAtlasV3Read", () => {
	it("files quotes then claims and links them by id", () => {
		const { state, source } = bankWithSource();
		const filed = fileAtlasV3Read({
			state,
			sourceId: source.id,
			goal: "EU solar additions 2025",
			read: {
				quotes: [
					"The EU added 65.1 GW of solar capacity in 2025, industry data show.",
				],
				claims: [
					{
						entity: "EU-27",
						metric: "solar additions",
						value: "65.1",
						unit: "GW",
						period: "2025",
						asOf: null,
						series: null,
						quoteIndexes: [0],
					},
				],
				useless: false,
			},
		});
		expect(filed.quotes).toHaveLength(1);
		expect(filed.claims[0].evidenceIds).toEqual([filed.quotes[0].id]);
	});
});

describe("assignAtlasV3CitationNumbers", () => {
	it("numbers sources in the order the report first cites them", () => {
		const state = createAtlasV3Bank();
		const a = addAtlasV3Source(state, {
			url: "https://iea.org/a",
			title: "A",
			publishedAt: null,
		});
		const b = addAtlasV3Source(state, {
			url: "https://bbc.com/b",
			title: "B",
			publishedAt: null,
		});
		const q1 = addAtlasV3Quote(state, {
			sourceId: a?.id ?? "",
			text: "First quote long enough to be evidence for a claim.",
			goal: "g",
		});
		const q2 = addAtlasV3Quote(state, {
			sourceId: b?.id ?? "",
			text: "Second quote long enough to be evidence for a claim.",
			goal: "g",
		});
		const q3 = addAtlasV3Quote(state, {
			sourceId: a?.id ?? "",
			text: "Third quote long enough to be evidence, from the first source.",
			goal: "g",
		});
		const citations = assignAtlasV3CitationNumbers({
			bank: freezeAtlasV3Bank(state),
			citedEvidenceIds: [q2?.id ?? "", q1?.id ?? "", q3?.id ?? ""],
		});
		expect(citations.numberByEvidenceId.get(q2?.id ?? "")).toBe(1);
		expect(citations.numberByEvidenceId.get(q1?.id ?? "")).toBe(2);
		// Two quotes from ONE source share ONE number: this is what stops [2][2].
		expect(citations.numberByEvidenceId.get(q3?.id ?? "")).toBe(2);
		expect(
			citations.sources.map((source) => source.n ?? source.id),
		).toHaveLength(2);
	});

	it("publishes a source named only by a Limitations line", () => {
		const state = createAtlasV3Bank();
		const a = addAtlasV3Source(state, {
			url: "https://iea.org/a",
			title: "A",
			publishedAt: null,
		});
		const citations = assignAtlasV3CitationNumbers({
			bank: freezeAtlasV3Bank(state),
			citedEvidenceIds: [],
			extraSourceIds: [a?.id ?? ""],
		});
		expect(citations.sources).toHaveLength(1);
		expect(citations.numberBySourceId.get(a?.id ?? "")).toBe(1);
	});

	it("ignores an evidence id that is not in the bank", () => {
		const state = createAtlasV3Bank();
		const citations = assignAtlasV3CitationNumbers({
			bank: freezeAtlasV3Bank(state),
			citedEvidenceIds: ["e404"],
		});
		expect(citations.sources).toEqual([]);
	});
});

describe("freeze / thaw", () => {
	it("round-trips a bank and keeps minting fresh ids", () => {
		const { state, source } = bankWithSource();
		addAtlasV3Quote(state, {
			sourceId: source.id,
			text: "A quote long enough to survive the minimum length rule.",
			goal: "g",
		});
		const thawed = thawAtlasV3Bank(freezeAtlasV3Bank(state));
		const next = addAtlasV3Quote(thawed, {
			sourceId: source.id,
			text: "A second quote, also long enough to survive the rule.",
			goal: "g",
		});
		expect(next?.id).toBe("e2");
		const nextSource = addAtlasV3Source(thawed, {
			url: "https://bbc.com/x",
			title: "B",
			publishedAt: null,
		});
		expect(nextSource?.id).toBe("s2");
	});
});

describe("capAtlasV3Bank", () => {
	it("keeps the sources claims rest on, then the best tier", () => {
		const state = createAtlasV3Bank();
		const forum = addAtlasV3Source(state, {
			url: "https://reddit.com/r/solar/a",
			title: "Forum",
			publishedAt: null,
		});
		const press = addAtlasV3Source(state, {
			url: "https://bbc.com/b",
			title: "Press",
			publishedAt: null,
		});
		const primary = addAtlasV3Source(state, {
			url: "https://iea.org/c",
			title: "Primary",
			publishedAt: null,
		});
		const quote = addAtlasV3Quote(state, {
			sourceId: press?.id ?? "",
			text: "A press quote long enough to be evidence for one claim.",
			goal: "g",
		});
		addAtlasV3Claim(state, {
			entity: "EU",
			metric: "m",
			value: "1",
			unit: null,
			period: null,
			asOf: null,
			series: null,
			evidenceIds: [quote?.id ?? ""],
		});
		const result = capAtlasV3Bank({ state, maxSources: 2 });
		expect(result.dropped).toBe(1);
		const kept = state.sources.map((source) => source.id);
		expect(kept).toContain(press?.id);
		expect(kept).toContain(primary?.id);
		expect(kept).not.toContain(forum?.id);
	});

	it("does nothing when the bank is inside the budget", () => {
		const { state } = bankWithSource();
		expect(capAtlasV3Bank({ state, maxSources: 5 }).dropped).toBe(0);
	});
});

describe("buildAtlasV3ReadPrompt", () => {
	it("caps the page text and carries the goal and the tier", () => {
		const prompt = buildAtlasV3ReadPrompt({
			goal: "EU solar additions 2025",
			language: "en",
			sourceTitle: "Renewables 2025",
			sourceHost: "iea.org",
			sourceDate: "2025-12-01",
			tier: "primary",
			pageText: "x".repeat(5000),
			maxPageChars: 100,
			currentDate: "2026-09-10",
		});
		const parsed = JSON.parse(prompt);
		expect(parsed.goal).toBe("EU solar additions 2025");
		expect(parsed.source.tier).toBe("primary");
		expect(parsed.page).toHaveLength(100);
	});
});
