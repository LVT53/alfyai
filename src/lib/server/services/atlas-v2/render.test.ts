import { describe, expect, it } from "vitest";
import { renderStandardReportHtml } from "$lib/server/services/file-production/renderers/standard-report-html";
import { renderStandardReportMarkdown } from "$lib/server/services/file-production/renderers/standard-report-markdown";
import {
	ATLAS_V2_CONFIDENCE_MARKS,
	buildAtlasV2DocumentSource,
	buildAtlasV2ExecutiveSummaryMarkdown,
	buildAtlasV2Limitations,
	renderSentenceWithCitations,
	renumberAtlasV2ForPublication,
} from "./render";
import type {
	AtlasV2EvidenceIndex,
	AtlasV2IndexedSource,
	AtlasV2VerificationResult,
	AtlasV2VerifiedSection,
} from "./types";

function source(
	n: number,
	overrides: Partial<AtlasV2IndexedSource> = {},
): AtlasV2IndexedSource {
	return {
		n,
		canonicalUrl: `https://source${n}.example/report`,
		host: `source${n}.example`,
		organisation: `source${n}.example`,
		title: `Report ${n}`,
		date: "2026-04-01",
		snippets: [`Evidence text for source ${n}.`],
		pageExcerpt: null,
		questionIds: ["q1"],
		...overrides,
	};
}

function verifiedSection(
	sentences: Array<{
		text: string;
		citations: number[];
		confidence: "corroborated" | "single" | "inferred";
	}>,
): AtlasV2VerifiedSection {
	return {
		sectionId: "s1",
		title: "Capacity",
		paragraphs: [
			sentences.map((sentence) => ({
				sectionId: "s1",
				text: sentence.text,
				citations: sentence.citations,
				confidence: sentence.confidence,
				failures: [],
				kept: true,
				rewritten: false,
			})),
		],
	};
}

function verification(
	overrides: Partial<AtlasV2VerificationResult> = {},
): AtlasV2VerificationResult {
	return {
		sections: [
			verifiedSection([
				{
					text: "Capacity reached 8 GW.",
					citations: [2],
					confidence: "corroborated",
				},
			]),
		],
		totals: { corroborated: 1, single: 0, inferred: 0, cut: 0 },
		contradictions: [],
		staleCitations: [],
		citedSourceNumbers: [2],
		entailmentCallCount: 0,
		...overrides,
	};
}

function index(sources: AtlasV2IndexedSource[]): AtlasV2EvidenceIndex {
	return { sources, dropped: [], filteredCount: 3, byQuestion: { q1: [] } };
}

describe("renderSentenceWithCitations", () => {
	it("puts the citation group first, then one confidence mark", () => {
		expect(
			renderSentenceWithCitations({
				text: "Capacity reached 8 GW.",
				citations: [3, 7],
				confidence: "corroborated",
			}),
		).toBe(
			`Capacity reached 8 GW. [3][7]${ATLAS_V2_CONFIDENCE_MARKS.corroborated}`,
		);
	});

	it("renders the three confidence forms distinctly", () => {
		const marks = (["corroborated", "single", "inferred"] as const).map(
			(confidence) =>
				renderSentenceWithCitations({
					text: "A claim.",
					citations: confidence === "inferred" ? [] : [1],
					confidence,
				}),
		);
		expect(marks[0]).toBe("A claim. [1]ᶜ");
		expect(marks[1]).toBe("A claim. [1]ˢ");
		expect(marks[2]).toBe("A claim. ⁱ");
		expect(new Set(marks).size).toBe(3);
	});
});

describe("renumberAtlasV2ForPublication", () => {
	it("publishes only cited sources, renumbered from one", () => {
		const publication = renumberAtlasV2ForPublication({
			index: index([source(1), source(2), source(3)]),
			verification: verification(),
		});
		expect(publication.sources.map((entry) => entry.n)).toEqual([1]);
		expect(publication.sources[0].host).toBe("source2.example");
		expect(publication.sections[0].paragraphs[0][0].citations).toEqual([1]);
	});

	it("keeps a source a contradiction names even when nothing cites it", () => {
		const publication = renumberAtlasV2ForPublication({
			index: index([source(1), source(2), source(3)]),
			verification: verification({
				contradictions: [
					{
						statedValue: "8 GW",
						statedCitation: 2,
						competingValue: "6 GW",
						competingCitation: 3,
						sentence: "Capacity reached 8 GW.",
					},
				],
			}),
		});
		expect(publication.sources.map((entry) => entry.host)).toEqual([
			"source2.example",
			"source3.example",
		]);
		expect(publication.contradictions[0]).toMatchObject({
			statedCitation: 1,
			competingCitation: 2,
		});
	});

	it("remaps stale citations into the published numbering", () => {
		const publication = renumberAtlasV2ForPublication({
			index: index([source(1), source(2)]),
			verification: verification({ staleCitations: [2] }),
		});
		expect(publication.staleCitations).toEqual([1]);
	});
});

describe("buildAtlasV2Limitations", () => {
	it("lists thin questions, stale sources, contradictions and cuts", () => {
		const publication = renumberAtlasV2ForPublication({
			index: index([source(1), source(2), source(3)]),
			verification: verification({
				staleCitations: [2],
				contradictions: [
					{
						statedValue: "8 GW",
						statedCitation: 2,
						competingValue: "6 GW",
						competingCitation: 3,
						sentence: "Capacity reached 8 GW.",
					},
				],
			}),
		});
		const items = buildAtlasV2Limitations({
			language: "en",
			publication,
			thinQuestions: ["What is the grid connection queue?"],
			cutSentenceCount: 2,
			staleMonths: 18,
		});
		expect(items[0]).toContain("grid connection queue");
		expect(items[1]).toContain("18 months old");
		expect(items[2]).toContain("Sources disagree");
		expect(items[3]).toContain("2 sentences were removed");
	});

	it("says so explicitly when there is nothing to limit", () => {
		const publication = renumberAtlasV2ForPublication({
			index: index([source(1), source(2)]),
			verification: verification(),
		});
		expect(
			buildAtlasV2Limitations({
				language: "en",
				publication,
				thinQuestions: [],
				cutSentenceCount: 0,
				staleMonths: 18,
			}),
		).toEqual([
			"Every cited figure was matched against its source and no contradiction was found.",
		]);
	});
});

describe("buildAtlasV2DocumentSource", () => {
	const publication = renumberAtlasV2ForPublication({
		index: index([source(1), source(2)]),
		verification: verification(),
	});
	const summary = verifiedSection([
		{
			text: "The union added capacity at pace.",
			citations: [2],
			confidence: "single",
		},
	]);
	const documentSource = buildAtlasV2DocumentSource({
		title: "EU solar capacity in 2026",
		language: "en",
		date: "2026-09-08",
		publication,
		summary: {
			...summary,
			paragraphs: summary.paragraphs.map((paragraph) =>
				paragraph.map((entry) => ({ ...entry, citations: [1] })),
			),
		},
		thinQuestions: [],
		cutSentenceCount: 0,
		staleMonths: 18,
	});

	it("uses one heading level for every section", () => {
		const levels = documentSource.blocks
			.filter((block) => block.type === "heading")
			.map((block) => (block as { level: number }).level);
		expect(new Set(levels)).toEqual(new Set([2]));
	});

	it("orders the report title, summary, sections, limitations, sources", () => {
		const headings = documentSource.blocks
			.filter((block) => block.type === "heading")
			.map((block) => (block as { text: string }).text);
		expect(headings).toEqual([
			"Executive summary",
			"Capacity",
			"Limitations",
			"Sources",
		]);
		expect(documentSource.title).toBe("EU solar capacity in 2026");
	});

	it("emits the sources as `title — host, date`", () => {
		const sources = documentSource.blocks.find(
			(block) => block.type === "sourceChips",
		) as { sources: Array<{ title: string; url?: string | null }> };
		expect(sources.sources[0].title).toBe(
			"Report 2 — source2.example, 2026-04-01",
		);
		expect(sources.sources[0].url).toBe("https://source2.example/report");
	});

	it("annotates every sentence with an inline confidence token and no basis prose", () => {
		const text = JSON.stringify(documentSource);
		// The renderers draw the legend themselves from these annotations.
		expect(text).toMatch(/\[\[cite:\d+:[csi]\]\]/);
		expect(text).not.toContain("Confidence key");
		expect(text.toLowerCase()).not.toContain("basis");
		expect(text).not.toContain("basisMarkers");
	});

	it("renders the citation and its mark in HTML and in Markdown", () => {
		const html =
			renderStandardReportHtml(documentSource).content.toString("utf8");
		// The HTML renderer resolves `[n]` against the Sources block's order, so
		// the published numbering has to line up with the source list.
		expect(html).toContain("source2.example");
		// The HTML renderer turns the annotation into a coloured dot plus a legend.
		expect(html).toContain("cite-dot--single");
		expect(html).toContain("cite-legend");

		const markdown =
			renderStandardReportMarkdown(documentSource).content.toString("utf8");
		expect(markdown).toContain(`[1]${ATLAS_V2_CONFIDENCE_MARKS.single}`);
		expect(markdown).not.toContain("(Basis:");
	});
});

describe("buildAtlasV2ExecutiveSummaryMarkdown", () => {
	it("is the summary plus the legend plus the numbered sources", () => {
		const publication = renumberAtlasV2ForPublication({
			index: index([source(1), source(2)]),
			verification: verification(),
		});
		const markdown = buildAtlasV2ExecutiveSummaryMarkdown({
			title: "EU solar capacity in 2026",
			language: "en",
			publication,
			summary: verifiedSection([
				{
					text: "The union added capacity at pace.",
					citations: [1],
					confidence: "single",
				},
			]),
		});
		expect(markdown).toContain("## EU solar capacity in 2026");
		expect(markdown).toContain("[1]ˢ");
		expect(markdown).toContain("[1] Report 2 — source2.example, 2026-04-01");
	});

	it("is empty when no summary survived verification", () => {
		const publication = renumberAtlasV2ForPublication({
			index: index([source(1)]),
			verification: verification({ citedSourceNumbers: [1] }),
		});
		expect(
			buildAtlasV2ExecutiveSummaryMarkdown({
				title: "T",
				language: "en",
				publication,
				summary: null,
			}),
		).toBe("");
	});
});
