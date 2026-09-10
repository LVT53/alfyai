import { describe, expect, it } from "vitest";
import {
	atlasV3BankIsUnusable,
	atlasV3StrongestSources,
	buildAtlasV3AbstentionReport,
} from "./abstain";
import {
	addAtlasV3Quote,
	addAtlasV3Source,
	createAtlasV3Bank,
	freezeAtlasV3Bank,
} from "./evidence-bank";

function bank(options?: { withQuote?: boolean }) {
	const state = createAtlasV3Bank();
	const npws = addAtlasV3Source(state, {
		url: "https://npws.ie/protected-species/kerry-slug",
		title: "Kerry slug",
		publishedAt: "2019-04-01",
		read: true,
	});
	addAtlasV3Source(state, {
		url: "https://reddit.com/r/ireland/kerry-slug",
		title: "Kerry slug sightings",
		publishedAt: null,
		read: true,
	});
	if (options?.withQuote) {
		addAtlasV3Quote(state, {
			sourceId: npws?.id ?? "",
			text: "The Kerry slug is listed under Annex II of the Habitats Directive.",
			goal: "population trend",
		});
	}
	return freezeAtlasV3Bank(state);
}

describe("atlasV3BankIsUnusable", () => {
	it("is true when sources were reached but nothing was quoted", () => {
		expect(atlasV3BankIsUnusable(bank())).toBe(true);
	});

	it("is false as soon as one quote exists", () => {
		expect(atlasV3BankIsUnusable(bank({ withQuote: true }))).toBe(false);
	});
});

describe("atlasV3StrongestSources", () => {
	it("puts the primary source ahead of the forum", () => {
		expect(
			atlasV3StrongestSources(bank()).map((source) => source.host),
		).toEqual(["npws.ie", "reddit.com"]);
	});
});

describe("buildAtlasV3AbstentionReport", () => {
	const input = {
		coreQuestion:
			"What is known about the population trend of the Kerry slug since 2015?",
		subQuestions: [
			"Kerry slug population survey Ireland",
			"Geomalacus maculosus monitoring NPWS",
			"Kerry slug population survey Ireland",
		],
		language: "en" as const,
		searches: 12,
		pagesRead: 8,
	};

	it("says it did not answer, and what was spent", () => {
		const report = buildAtlasV3AbstentionReport({ ...input, bank: bank() });
		expect(report.verdict[0].text).toContain("does not answer the question");
		expect(report.verdict[1].text).toContain("12 searches");
		expect(report.verdict[1].text).toContain("8 pages");
	});

	it("lists the sub-questions once each and the sources read", () => {
		const report = buildAtlasV3AbstentionReport({ ...input, bank: bank() });
		const section = report.sections[0];
		expect(section.title).toBe("What was searched");
		const asked = section.paragraphs[0].map((sentence) => sentence.text);
		expect(asked).toHaveLength(2);
		expect(asked[0]).toContain("Kerry slug population survey Ireland");
		const read = section.paragraphs[1].map((sentence) => sentence.text);
		expect(read[0]).toContain("npws.ie");
	});

	it("publishes a source no sentence can cite as an extra source", () => {
		const report = buildAtlasV3AbstentionReport({ ...input, bank: bank() });
		expect(report.extraSourceIds).toEqual(["s1", "s2"]);
	});

	it("cites the quote a source did carry, so it renders as [n]", () => {
		const report = buildAtlasV3AbstentionReport({
			...input,
			bank: bank({ withQuote: true }),
		});
		const read = report.sections[0].paragraphs[1];
		expect(read[0].evidenceIds).toEqual(["e1"]);
		expect(report.extraSourceIds).toEqual(["s2"]);
	});

	it("counts its own sentences into the verification totals", () => {
		const report = buildAtlasV3AbstentionReport({ ...input, bank: bank() });
		const sentences =
			report.verdict.length + report.sections[0].paragraphs.flat().length;
		expect(
			report.totals.corroborated +
				report.totals.single +
				report.totals.inferred,
		).toBe(sentences);
		expect(report.totals.cut).toBe(0);
	});

	it("writes the Hungarian report in Hungarian", () => {
		const report = buildAtlasV3AbstentionReport({
			...input,
			language: "hu",
			bank: bank(),
		});
		expect(report.sections[0].title).toBe("Amit megkerestünk");
		expect(report.verdict[0].text).toContain("nem válaszolja meg");
	});
});
