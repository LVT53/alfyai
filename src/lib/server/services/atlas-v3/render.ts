// Atlas v3 stage 9b: render (ADR 0063).
//
// Two things are kept from v2 unchanged: the `documentSource` block schema, so
// heading levels are produced rather than reconstructed, and the
// `[[cite:n:c|s|i]]` inline annotation, which the HTML and PDF renderers draw
// as a numbered chip plus a confidence dot and Markdown and DOCX draw as a
// superscript key. One mechanism, three outputs, no change to file production.
//
// Two things are new. Citation NUMBERS are minted here from evidence ids, so a
// writer cannot mis-number a citation or cite a source that was dropped; and
// the answer table renders as a real `table` block with per-cell citations,
// which is what a comparison report needed and never got.

import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
	GeneratedDocumentSourceChip,
	GeneratedDocumentTableColumn,
} from "$lib/server/services/file-production/source-schema";
import type { SupportedLanguage } from "$lib/server/services/language";
import {
	type AtlasV3Citations,
	assignAtlasV3CitationNumbers,
	formatAtlasV3SourceLine,
} from "./evidence-bank";
import type {
	AtlasV3AnswerTable,
	AtlasV3Confidence,
	AtlasV3EvidenceBank,
	AtlasV3Limitation,
	AtlasV3Source,
	AtlasV3VerifiedSection,
	AtlasV3VerifiedSentence,
} from "./types";

interface AtlasV3Chrome {
	verdict: string;
	limitations: string;
	sources: string;
	confidenceLegend: string;
	abstained: string;
	noLimitations: string;
	derivedNote: (input: { label: string; value: string }) => string;
	notPublished: string;
}

const CHROME: Record<SupportedLanguage, AtlasV3Chrome> = {
	en: {
		verdict: "Verdict",
		limitations: "What this report could not establish",
		sources: "Sources",
		confidenceLegend:
			"Confidence key: ᶜ corroborated by two independent publishers · ˢ a single publisher · ⁱ synthesis across the cited evidence.",
		abstained:
			"This report does not answer the question asked. The research below is what could be established; the rest is listed as unestablished rather than filled in.",
		noLimitations:
			"Every cited figure was matched against the quote it rests on, and nothing material was left unestablished.",
		derivedNote: ({ label, value }) => `${label}: ${value} (computed)`,
		notPublished: "not published",
	},
	hu: {
		verdict: "Ítélet",
		limitations: "Amit ez a jelentés nem tudott megállapítani",
		sources: "Források",
		confidenceLegend:
			"Bizonyossági jelölés: ᶜ két független közzétevő is megerősíti · ˢ egyetlen közzétevő · ⁱ a hivatkozott bizonyítékokon átívelő következtetés.",
		abstained:
			"Ez a jelentés nem válaszolja meg a feltett kérdést. Az alábbi kutatás az, amit meg lehetett állapítani; a többi nem kitöltve, hanem megállapíthatatlanként szerepel.",
		noLimitations:
			"Minden hivatkozott számot összevetettünk azzal az idézettel, amelyen nyugszik, és semmi lényeges nem maradt megállapítatlanul.",
		derivedNote: ({ label, value }) => `${label}: ${value} (számított)`,
		notPublished: "nincs közzétéve",
	},
};

export function atlasV3Chrome(language: SupportedLanguage): AtlasV3Chrome {
	return CHROME[language];
}

const CONFIDENCE_CODE: Record<AtlasV3Confidence, "c" | "s" | "i"> = {
	corroborated: "c",
	single: "s",
	inferred: "i",
};

export const ATLAS_V3_CONFIDENCE_MARKS: Record<AtlasV3Confidence, string> = {
	corroborated: "ᶜ",
	single: "ˢ",
	inferred: "ⁱ",
};

/**
 * `"The EU added 65.1 GW. [3][[cite:7:c]]"` — every citation but the last as a
 * plain `[n]`, then ONE inline annotation naming the last. The last is NOT also
 * written as `[n]`: the annotation already renders it, and writing both is what
 * put `[2][3][3]ᶜ` in v2's reports.
 */
export function renderAtlasV3Sentence(input: {
	sentence: Pick<AtlasV3VerifiedSentence, "text" | "evidenceIds" | "confidence">;
	citations: AtlasV3Citations;
}): string {
	const code = CONFIDENCE_CODE[input.sentence.confidence];
	const numbers: number[] = [];
	for (const id of input.sentence.evidenceIds) {
		const number = input.citations.numberByEvidenceId.get(id);
		// Two quotes from one source share one number, so a sentence citing both
		// renders ONE citation.
		if (number !== undefined && !numbers.includes(number)) numbers.push(number);
	}
	const last = numbers.at(-1);
	const token = last === undefined ? `[[cite:${code}]]` : `[[cite:${last}:${code}]]`;
	const leading = numbers
		.slice(0, -1)
		.map((number) => `[${number}]`)
		.join("");
	return `${input.sentence.text} ${leading}${token}`;
}

/** The Markdown form, for the assistant message. Same numbering, no tokens. */
export function renderAtlasV3SentenceMarkdown(input: {
	sentence: Pick<AtlasV3VerifiedSentence, "text" | "evidenceIds" | "confidence">;
	citations: AtlasV3Citations;
}): string {
	const mark = ATLAS_V3_CONFIDENCE_MARKS[input.sentence.confidence];
	const numbers: number[] = [];
	for (const id of input.sentence.evidenceIds) {
		const number = input.citations.numberByEvidenceId.get(id);
		if (number !== undefined && !numbers.includes(number)) numbers.push(number);
	}
	const rendered = numbers.map((number) => `[${number}]`).join("");
	return rendered
		? `${input.sentence.text} ${rendered}${mark}`
		: `${input.sentence.text} ${mark}`;
}

function paragraphBlock(
	paragraph: readonly AtlasV3VerifiedSentence[],
	citations: AtlasV3Citations,
): GeneratedDocumentBlock {
	return {
		type: "paragraph",
		text: paragraph
			.map((sentence) => renderAtlasV3Sentence({ sentence, citations }))
			.join(" "),
	};
}

/**
 * The answer table as a real table block, each cell carrying its own `[n]`
 * markers. Per-cell citations are what make a table verifiable rather than
 * decorative.
 */
export function renderAtlasV3TableBlock(input: {
	table: AtlasV3AnswerTable;
	citations: AtlasV3Citations;
	language: SupportedLanguage;
}): GeneratedDocumentBlock[] {
	const columns: GeneratedDocumentTableColumn[] = input.table.columns.map(
		(column) => ({ key: column.key, label: column.label, kind: "text" }),
	);
	const rows = input.table.rows.map((row) => {
		const rendered: Record<string, string> = {};
		for (const column of input.table.columns) {
			const cell = row[column.key];
			if (!cell) {
				rendered[column.key] = "";
				continue;
			}
			const numbers: number[] = [];
			for (const id of cell.evidenceIds) {
				const number = input.citations.numberByEvidenceId.get(id);
				if (number !== undefined && !numbers.includes(number)) {
					numbers.push(number);
				}
			}
			rendered[column.key] = numbers.length
				? `${cell.text} ${numbers.map((number) => `[${number}]`).join("")}`
				: cell.text;
		}
		return rendered;
	});
	const blocks: GeneratedDocumentBlock[] = [
		{ type: "table", title: input.table.title, columns, rows },
	];
	const computed = input.table.derived.filter((entry) => entry.value !== null);
	if (computed.length > 0) {
		blocks.push({
			type: "list",
			style: "bullet",
			items: computed.map((entry) =>
				CHROME[input.language].derivedNote({
					label: entry.label,
					value: entry.value ?? "",
				}),
			),
		});
	}
	return blocks;
}

function sourceChip(source: AtlasV3Source): GeneratedDocumentSourceChip {
	return {
		title: formatAtlasV3SourceLine(source),
		url: source.canonicalUrl,
		kind: "web",
		provided: false,
	};
}

export interface BuildAtlasV3DocumentSourceInput {
	title: string;
	subtitle?: string | null;
	date?: string | null;
	language: SupportedLanguage;
	bank: AtlasV3EvidenceBank;
	verdict: AtlasV3VerifiedSentence[];
	sections: AtlasV3VerifiedSection[];
	limitations: AtlasV3Limitation[];
	/** True when the goal test failed; the report says so at the top. */
	abstained: boolean;
}

export interface AtlasV3RenderResult {
	documentSource: GeneratedDocumentSource;
	citations: AtlasV3Citations;
	/** The verdict as Markdown; becomes the assistant message content. */
	verdictMarkdown: string;
}

export function buildAtlasV3DocumentSource(
	input: BuildAtlasV3DocumentSourceInput,
): AtlasV3RenderResult {
	const chrome = CHROME[input.language];
	// Numbering follows the order the FINISHED report cites: the verdict first,
	// then each section's tables and prose. Minted here and nowhere else.
	const citedEvidenceIds: string[] = [];
	const take = (ids: readonly string[]) => {
		for (const id of ids) {
			if (!citedEvidenceIds.includes(id)) citedEvidenceIds.push(id);
		}
	};
	take(input.verdict.flatMap((sentence) => sentence.evidenceIds));
	for (const section of input.sections) {
		if (section.table) {
			for (const row of section.table.rows) {
				for (const column of section.table.columns) {
					take(row[column.key]?.evidenceIds ?? []);
				}
			}
		}
		take(
			section.paragraphs
				.flat()
				.flatMap((sentence) => sentence.evidenceIds),
		);
	}
	const citations = assignAtlasV3CitationNumbers({
		bank: input.bank,
		citedEvidenceIds,
	});

	const blocks: GeneratedDocumentBlock[] = [];
	if (input.abstained) {
		blocks.push({
			type: "callout",
			tone: "warning",
			title: null,
			text: chrome.abstained,
		});
	}
	if (input.verdict.length > 0) {
		blocks.push({ type: "heading", level: 2, text: chrome.verdict });
		blocks.push(paragraphBlock(input.verdict, citations));
	}
	for (const section of input.sections) {
		if (section.paragraphs.length === 0 && !section.table) continue;
		blocks.push({ type: "heading", level: 2, text: section.title });
		if (section.table) {
			blocks.push(
				...renderAtlasV3TableBlock({
					table: section.table,
					citations,
					language: input.language,
				}),
			);
		}
		for (const paragraph of section.paragraphs) {
			blocks.push(paragraphBlock(paragraph, citations));
		}
	}

	blocks.push({ type: "heading", level: 2, text: chrome.limitations });
	blocks.push({
		type: "list",
		style: "bullet",
		items:
			input.limitations.length > 0
				? input.limitations
						.slice(0, 8)
						.map((entry) => `${entry.subject} — ${entry.reason}`)
				: [chrome.noLimitations],
	});

	if (citations.sources.length > 0) {
		// The chips block carries its own heading: a level-2 heading here as well
		// is what produced "## Sources" followed by "### Sources" in v2.
		blocks.push({
			type: "sourceChips",
			title: chrome.sources,
			sources: citations.sources.map(sourceChip),
		});
	}

	return {
		documentSource: {
			version: 1,
			template: "alfyai_standard_report",
			title: input.title,
			subtitle: input.subtitle ?? null,
			date: input.date ?? null,
			language: input.language,
			blocks,
		},
		citations,
		verdictMarkdown: buildAtlasV3VerdictMarkdown({
			title: input.title,
			verdict: input.verdict,
			citations,
			language: input.language,
			abstained: input.abstained,
		}),
	};
}

export function buildAtlasV3VerdictMarkdown(input: {
	title: string;
	verdict: readonly AtlasV3VerifiedSentence[];
	citations: AtlasV3Citations;
	language: SupportedLanguage;
	abstained: boolean;
}): string {
	if (input.verdict.length === 0) return "";
	const chrome = CHROME[input.language];
	const body = input.verdict
		.map((sentence) =>
			renderAtlasV3SentenceMarkdown({ sentence, citations: input.citations }),
		)
		.join(" ");
	const sourceLines = input.citations.sources.map(
		(source, index) => `[${index + 1}] ${formatAtlasV3SourceLine(source)}`,
	);
	return [
		`## ${input.title}`,
		"",
		...(input.abstained ? [chrome.abstained, ""] : []),
		body,
		"",
		chrome.confidenceLegend,
		"",
		`**${chrome.sources}**`,
		...sourceLines,
	]
		.join("\n")
		.trim();
}
