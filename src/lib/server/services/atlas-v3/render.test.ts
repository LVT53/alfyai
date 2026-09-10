import { describe, expect, it } from "vitest";
import {
	addAtlasV3Quote,
	addAtlasV3Source,
	assignAtlasV3CitationNumbers,
	createAtlasV3Bank,
	freezeAtlasV3Bank,
} from "./evidence-bank";
import {
	buildAtlasV3DocumentSource,
	renderAtlasV3Sentence,
	renderAtlasV3SentenceMarkdown,
} from "./render";
import type {
	AtlasV3AnswerTable,
	AtlasV3VerifiedSection,
	AtlasV3VerifiedSentence,
} from "./types";

function bank() {
	const state = createAtlasV3Bank();
	const iea = addAtlasV3Source(state, {
		url: "https://iea.org/reports/solar",
		title: "Renewables 2025",
		publishedAt: "2025-12-01",
	});
	const bbc = addAtlasV3Source(state, {
		url: "https://bbc.com/news/solar",
		title: "EU solar stalls",
		publishedAt: "2025-12-02",
	});
	addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "The EU added 65.1 GW of solar capacity in 2025, industry data show.",
		goal: "g",
	});
	addAtlasV3Quote(state, {
		sourceId: bbc?.id ?? "",
		text: "Europe installed 65.1 GW of solar last year, the first fall since 2016.",
		goal: "g",
	});
	addAtlasV3Quote(state, {
		sourceId: iea?.id ?? "",
		text: "Rooftop installations fell 21% while utility-scale capacity grew.",
		goal: "g",
	});
	return freezeAtlasV3Bank(state);
}

function sentence(
	text: string,
	evidenceIds: string[],
	confidence: AtlasV3VerifiedSentence["confidence"] = "single",
): AtlasV3VerifiedSentence {
	return {
		text,
		evidenceIds,
		kind: "claim",
		confidence,
		outcome: "kept",
		failures: [],
	};
}

const TABLE: AtlasV3AnswerTable = {
	kind: "comparison",
	title: "EU solar additions",
	columns: [
		{ key: "year", label: "Year" },
		{ key: "additions", label: "Additions" },
	],
	rows: [
		{
			year: { text: "2025", evidenceIds: [] },
			additions: { text: "65.1 GW", evidenceIds: ["e1", "e2"] },
		},
	],
	derived: [
		{
			id: "k1",
			label: "Change 2024-2025",
			expression: "(65.1-65.6)/65.6*100",
			inputs: ["e1"],
			value: "-0.76",
		},
	],
};

const SECTIONS: AtlasV3VerifiedSection[] = [
	{
		nodeId: "n1",
		title: "EU solar additions fell in 2025",
		table: TABLE,
		paragraphs: [
			[sentence("The EU added 65.1 GW in 2025.", ["e1", "e2"], "corroborated")],
		],
	},
	{
		nodeId: "n2",
		title: "Rooftop demand drove the fall",
		table: null,
		paragraphs: [[sentence("Rooftop installations fell 21%.", ["e3"])]],
	},
];

describe("renderAtlasV3Sentence", () => {
	it("writes every citation but the last as [n] and the last as an annotation", () => {
		const citations = assignAtlasV3CitationNumbers({
			bank: bank(),
			citedEvidenceIds: ["e1", "e2"],
		});
		expect(
			renderAtlasV3Sentence({
				sentence: sentence(
					"The EU added 65.1 GW.",
					["e1", "e2"],
					"corroborated",
				),
				citations,
			}),
		).toBe("The EU added 65.1 GW. [1][[cite:2:c]]");
	});

	it("renders ONE citation when two quotes share a source", () => {
		const citations = assignAtlasV3CitationNumbers({
			bank: bank(),
			citedEvidenceIds: ["e1", "e3"],
		});
		expect(
			renderAtlasV3Sentence({
				sentence: sentence("x", ["e1", "e3"]),
				citations,
			}),
		).toBe("x [[cite:1:s]]");
	});

	it("annotates an uncited sentence with no number", () => {
		const citations = assignAtlasV3CitationNumbers({
			bank: bank(),
			citedEvidenceIds: [],
		});
		expect(
			renderAtlasV3Sentence({
				sentence: sentence("A judgement.", [], "inferred"),
				citations,
			}),
		).toBe("A judgement. [[cite:i]]");
	});
});

describe("renderAtlasV3SentenceMarkdown", () => {
	it("uses the superscript key rather than a token", () => {
		const citations = assignAtlasV3CitationNumbers({
			bank: bank(),
			citedEvidenceIds: ["e1"],
		});
		expect(
			renderAtlasV3SentenceMarkdown({
				sentence: sentence("x", ["e1"]),
				citations,
			}),
		).toBe("x [1]ˢ");
	});
});

describe("buildAtlasV3DocumentSource", () => {
	const base = {
		title: "EU solar additions, 2025 versus 2024",
		language: "en" as const,
		date: "2026-09-10",
		bank: bank(),
		verdict: [
			sentence("The EU added 65.1 GW in 2025.", ["e2"], "corroborated"),
		],
		sections: SECTIONS,
		limitations: [
			{ subject: "member-state breakdown", reason: "not yet published" },
		],
		abstained: false,
	};

	it("opens with the verdict and numbers from the verdict outward", () => {
		const result = buildAtlasV3DocumentSource(base);
		const blocks = result.documentSource.blocks;
		expect(blocks[0]).toEqual({ type: "heading", level: 2, text: "Verdict" });
		// e2's source is cited FIRST by the verdict, so it takes [1].
		expect(result.citations.numberByEvidenceId.get("e2")).toBe(1);
		expect(result.citations.numberByEvidenceId.get("e1")).toBe(2);
	});

	it("renders the answer table as a table block with per-cell citations", () => {
		const result = buildAtlasV3DocumentSource(base);
		const table = result.documentSource.blocks.find(
			(block) => block.type === "table",
		);
		expect(table).toBeDefined();
		if (table?.type !== "table") throw new Error("expected a table block");
		expect(table.rows[0].additions).toMatch(/65\.1 GW \[\d\]\[\d\]/);
		expect(table.rows[0].year).toBe("2025");
	});

	it("lists the computed figures under the table", () => {
		const result = buildAtlasV3DocumentSource(base);
		const list = result.documentSource.blocks.find(
			(block) => block.type === "list" && block.items[0]?.includes("computed"),
		);
		expect(list).toBeDefined();
	});

	it("says what could not be established, never how many sentences were cut", () => {
		const result = buildAtlasV3DocumentSource(base);
		const heading = result.documentSource.blocks.find(
			(block) =>
				block.type === "heading" && block.text.includes("could not establish"),
		);
		expect(heading).toBeDefined();
		const rendered = JSON.stringify(result.documentSource);
		expect(rendered).toContain("member-state breakdown — not yet published");
		expect(rendered).not.toContain("sentences were removed");
	});

	it("marks an abstention at the top of the report and in the message", () => {
		const result = buildAtlasV3DocumentSource({ ...base, abstained: true });
		expect(result.documentSource.blocks[0].type).toBe("callout");
		expect(result.verdictMarkdown).toContain("does not answer the question");
	});

	it("publishes only the sources the report cites, in order", () => {
		const result = buildAtlasV3DocumentSource(base);
		const chips = result.documentSource.blocks.find(
			(block) => block.type === "sourceChips",
		);
		if (chips?.type !== "sourceChips") throw new Error("expected chips");
		expect(chips.title).toBe("Sources");
		expect(chips.sources[0].title).toContain("EU solar stalls — bbc.com");
		expect(chips.sources).toHaveLength(2);
	});

	it("puts the verdict in the assistant message with a source list", () => {
		const result = buildAtlasV3DocumentSource(base);
		expect(result.verdictMarkdown).toContain(
			"## EU solar additions, 2025 versus 2024",
		);
		expect(result.verdictMarkdown).toContain(
			"The EU added 65.1 GW in 2025. [1]ᶜ",
		);
		expect(result.verdictMarkdown).toContain("**Sources**");
	});

	it("returns an empty message when there is no verdict", () => {
		const result = buildAtlasV3DocumentSource({ ...base, verdict: [] });
		expect(result.verdictMarkdown).toBe("");
	});

	it("falls back to a reassuring Limitations line when nothing is missing", () => {
		const result = buildAtlasV3DocumentSource({ ...base, limitations: [] });
		expect(JSON.stringify(result.documentSource)).toContain(
			"nothing material was left unestablished",
		);
	});
});
