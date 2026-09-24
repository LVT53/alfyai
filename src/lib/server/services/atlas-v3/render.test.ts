import { describe, expect, it } from "vitest";
import { renderStandardReportHtml } from "$lib/server/services/file-production/renderers/standard-report-html";
import { validateGeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import { buildAtlasV3AbstentionReport } from "./abstain";
import {
	addAtlasV3LocalSource,
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

	/**
	 * The abstaining report bypasses verification, so the renderer is the first
	 * thing that sees it. Every source it read must reach the Sources list, and
	 * a source no sentence can cite must still be published.
	 */
	it("renders an abstention report, sources and all", () => {
		const abstention = buildAtlasV3AbstentionReport({
			coreQuestion: "What is the Kerry slug population trend since 2015?",
			subQuestions: ["Kerry slug population survey", "NPWS monitoring"],
			bank: bank(),
			language: "en",
			searches: 12,
			pagesRead: 8,
		});
		const result = buildAtlasV3DocumentSource({
			...base,
			verdict: abstention.verdict,
			sections: abstention.sections,
			limitations: [],
			abstained: true,
			extraSourceIds: abstention.extraSourceIds,
		});
		expect(result.documentSource.blocks[0].type).toBe("callout");
		const heading = result.documentSource.blocks.find(
			(block) => block.type === "heading" && block.text === "What was searched",
		);
		expect(heading).toBeTruthy();
		const chips = result.documentSource.blocks.find(
			(block) => block.type === "sourceChips",
		);
		if (chips?.type !== "sourceChips") throw new Error("expected chips");
		expect(chips.sources).toHaveLength(2);
		expect(result.verdictMarkdown).toContain("does not answer the question");
	});

	it("falls back to a reassuring Limitations line when nothing is missing", () => {
		const result = buildAtlasV3DocumentSource({ ...base, limitations: [] });
		expect(JSON.stringify(result.documentSource)).toContain(
			"nothing material was left unestablished",
		);
	});

	it("renders a user document as a library chip in the same block, and validates", () => {
		const state = createAtlasV3Bank();
		const web = addAtlasV3Source(state, {
			url: "https://iea.org/reports/household",
			title: "Household electricity",
			publishedAt: "2025-12-01",
		});
		const local = addAtlasV3LocalSource(state, {
			displayArtifactId: "art-bill",
			promptArtifactId: "art-bill-normalized",
			title: "Electricity bill 2025.pdf",
			origin: "attachment",
		});
		const localQuote = addAtlasV3Quote(state, {
			sourceId: local.id,
			text: "Our household used 1,234 kWh of electricity in 2025.",
			goal: "g",
		});
		const webQuote = addAtlasV3Quote(state, {
			sourceId: web?.id ?? "",
			text: "The average household used 1,234 kWh of electricity in 2025.",
			goal: "g",
		});
		const result = buildAtlasV3DocumentSource({
			...base,
			bank: freezeAtlasV3Bank(state),
			// The web source is cited first, so the library chip is [2].
			verdict: [
				sentence("Households used 1,234 kWh in 2025.", [
					webQuote?.id ?? "",
					localQuote?.id ?? "",
				]),
			],
			sections: [],
		});
		const chips = result.documentSource.blocks.filter(
			(block) => block.type === "sourceChips",
		);
		expect(chips).toHaveLength(1);
		if (chips[0]?.type !== "sourceChips") throw new Error("expected chips");
		expect(chips[0].sources).toEqual([
			{
				title: "Household electricity — iea.org, 2025-12-01",
				url: "https://iea.org/reports/household",
				kind: "web",
				provided: false,
			},
			{
				title: "Electricity bill 2025.pdf",
				url: null,
				kind: "library",
				provided: true,
			},
		]);
		expect(result.verdictMarkdown).toContain(
			"[2] Electricity bill 2025.pdf — your library",
		);
		expect(result.verdictMarkdown).not.toContain("atlas-local:");
		const validated = validateGeneratedDocumentSource(result.documentSource);
		expect(validated.ok).toBe(true);
		if (!validated.ok) return;
		const validatedChips = validated.source.blocks.find(
			(block) => block.type === "sourceChips",
		);
		if (validatedChips?.type !== "sourceChips") {
			throw new Error("expected validated chips");
		}
		expect(validatedChips.sources.map((chip) => chip.kind)).toEqual([
			"web",
			"library",
		]);
		expect(validatedChips.sources[1]?.url ?? null).toBeNull();
	});

	// The report renderers key a chip by url + title and drop repeats. Two of
	// the user's documents that share a name (two generated "Report.pdf"s, or
	// titles alike in their first 200 characters) both have a null url, so the
	// second collapsed into the first and every later chip took the number
	// before its own: the prose's [3] then pointed at chip 2.
	it("keeps two same-named user documents as two numbered chips", () => {
		const state = createAtlasV3Bank();
		const first = addAtlasV3LocalSource(state, {
			displayArtifactId: "art-a",
			promptArtifactId: "art-a-n",
			title: "Report.pdf",
			origin: "linked",
		});
		const second = addAtlasV3LocalSource(state, {
			displayArtifactId: "art-b",
			promptArtifactId: "art-b-n",
			title: "Report.pdf",
			origin: "linked",
		});
		const web = addAtlasV3Source(state, {
			url: "https://iea.org/reports/household",
			title: "Household electricity",
			publishedAt: "2025-12-01",
		});
		const quotes = [first, second, web].map((source, index) =>
			addAtlasV3Quote(state, {
				sourceId: source?.id ?? "",
				text: `Household number ${index + 1} used 1,234 kWh of electricity in 2025.`,
				goal: "g",
			}),
		);
		const result = buildAtlasV3DocumentSource({
			...base,
			bank: freezeAtlasV3Bank(state),
			verdict: [
				sentence(
					"Households used 1,234 kWh in 2025.",
					quotes.map((quote) => quote?.id ?? ""),
				),
			],
			sections: [],
		});
		const html = renderStandardReportHtml(
			result.documentSource,
		).content.toString("utf8");
		const numbers = new Set(
			[...html.matchAll(/data-source-number="(\d+)"/g)].map((match) =>
				Number(match[1]),
			),
		);
		expect([...numbers].sort()).toEqual([1, 2, 3]);
	});
});
