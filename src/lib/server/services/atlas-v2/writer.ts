// Atlas v2 stage 4: write sections (ADR 0062).
//
// The writer's contract is SENTENCE-LEVEL and structured. v1 asked for a whole
// report as Markdown and then spent ~1,600 lines repairing it; v2 asks for
// paragraphs of sentences, each carrying the source numbers it rests on. That
// is what makes the verifier possible: the pipeline never has to guess where a
// claim starts or which source it came from, and heading levels are produced
// by the renderer rather than reconstructed from prose.

import type { SupportedLanguage } from "$lib/server/services/language";
import { parseJsonFromText } from "../atlas/json-extract";
import type { AtlasProfile } from "../atlas/types";
import { sourceEvidenceText } from "./evidence-index";
import type {
	AtlasV2Calculation,
	AtlasV2Failure,
	AtlasV2IndexedSource,
	AtlasV2PlanQuestion,
	AtlasV2PlanSection,
	AtlasV2WrittenParagraph,
	AtlasV2WrittenSection,
	AtlasV2WrittenSentence,
} from "./types";

const MAX_SENTENCE_CHARS = 600;
const MAX_SENTENCES_PER_PARAGRAPH = 8;
const MAX_PARAGRAPHS_PER_SECTION = 8;
const MAX_CALCULATIONS_PER_SECTION = 6;
const MAX_EVIDENCE_CHARS_PER_SOURCE = 2400;

export const ATLAS_V2_WRITER_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You write one section of a research report from numbered evidence. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"paragraphs":[{"sentences":[{"text":"...","citations":[3,7],"inferred":false}]}],"calculations":[{"id":"c1","expression":"8/12*100","inputs":[3]}]}',
		"RULES, in order of importance:",
		"1. Every figure, date, name, quantity or named position in a sentence MUST be stated by at least one source you cite for that sentence. Cite by source number in `citations`.",
		"2. Never write a figure you cannot find in the evidence. If the evidence does not have it, write about what the evidence does have.",
		"3. Do NOT put the citation marker in `text` — the renderer adds it. Write the sentence as plain prose.",
		'4. A sentence that synthesises across sources without any source stating it directly is allowed ONLY as hedged prose with "inferred": true, an empty `citations` list, and NO figure, date or quantity inside it.',
		"5. When independent sources disagree on a figure, write ONE sentence that states both figures and cite both sources.",
		"6. Arithmetic you perform yourself goes in `calculations` as a single Python expression over figures from the cited `inputs`; reference it from a sentence with `calcId`. Never compute in your head.",
		"7. No images. No source list. No section heading — the title is given. No mention of your own process, of confidence levels, or of the word 'basis'.",
		"Write in the report's language. Prefer short, factual sentences over long ones.",
	].join("\n"),
	hu: [
		"Egy kutatási jelentés egy szakaszát írod számozott bizonyítékokból. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"paragraphs":[{"sentences":[{"text":"...","citations":[3,7],"inferred":false}]}],"calculations":[{"id":"c1","expression":"8/12*100","inputs":[3]}]}',
		"SZABÁLYOK, fontossági sorrendben:",
		"1. Minden szám, dátum, név, mennyiség és megnevezett álláspont mögött legyen legalább egy forrás, amit az adott mondathoz hivatkozol. A hivatkozás forrásszám a `citations` mezőben.",
		"2. Soha ne írj olyan számot, amit nem találsz a bizonyítékban. Ha nincs benne, arról írj, ami benne van.",
		"3. A hivatkozásjelet NE írd a `text`-be — azt a megjelenítő teszi hozzá. A mondat legyen sima próza.",
		'4. Több forráson átnyúló szintézis mondat CSAK óvatos megfogalmazással, "inferred": true értékkel, üres `citations` listával és szám, dátum vagy mennyiség NÉLKÜL engedélyezett.',
		"5. Ha független források más számot adnak, EGY mondatban írd le mindkét számot, és mindkét forrást hivatkozd.",
		"6. Az általad végzett számítás a `calculations` mezőbe kerül egyetlen Python kifejezésként a hivatkozott `inputs` számaiból; a mondatból `calcId`-vel hivatkozz rá. Fejben soha ne számolj.",
		"7. Ne legyen kép, forráslista, szakaszcím — a címet megadjuk. Ne írj a saját folyamatodról, bizonyossági szintekről, és ne használd a „basis” szót.",
		"A jelentés nyelvén írj. A rövid, tényszerű mondatokat részesítsd előnyben.",
	].join("\n"),
};

export const ATLAS_V2_SUMMARY_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You write the executive summary of a research report from its finished sections. Return STRICT JSON only, in the same shape as a section.",
		"Every citation you use must already appear in the section sentence you are summarising — you may not introduce a source or a figure the sections do not carry.",
		"Answer the request in the first paragraph. Keep it to 3-6 sentences per paragraph and at most 3 paragraphs.",
		"No headings, no source list, no mention of your own process.",
	].join("\n"),
	hu: [
		"Egy kutatási jelentés vezetői összefoglalóját írod a kész szakaszaiból. KIZÁRÓLAG szigorú JSON-t adj vissza, ugyanabban az alakban, mint egy szakasz.",
		"Minden használt hivatkozás szerepeljen már abban a szakaszmondatban, amit összefoglalsz — új forrást vagy számot nem vezethetsz be.",
		"Az első bekezdésben válaszolj a kérdésre. Bekezdésenként 3-6 mondat, legfeljebb 3 bekezdés.",
		"Ne legyen cím, forráslista, és ne írj a saját folyamatodról.",
	].join("\n"),
};

export const ATLAS_V2_REWRITE_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You are given sentences from a report section that FAILED verification, with the exact reason for each. Return STRICT JSON only, in the same section shape.",
		"For each failed sentence, either rewrite it so the reason no longer applies — using only what the evidence states — or drop it.",
		"Do not restate a figure the evidence does not carry. Dropping a sentence is always better than keeping a wrong one.",
		"Return only the rewritten sentences, in the same paragraph structure. Omitting a sentence means you chose to drop it.",
	].join("\n"),
	hu: [
		"Olyan mondatokat kapsz egy jelentésszakaszból, amelyek NEM mentek át az ellenőrzésen, mindegyiknél a pontos okkal. KIZÁRÓLAG szigorú JSON-t adj vissza, ugyanabban a szakasz-alakban.",
		"Minden hibás mondatot vagy úgy írj át, hogy az ok többé ne álljon — csak azzal, amit a bizonyíték kimond —, vagy hagyd el.",
		"Ne írj le újra olyan számot, amit a bizonyíték nem tartalmaz. Egy mondat elhagyása mindig jobb, mint egy hibás megtartása.",
		"Csak az átírt mondatokat add vissza, ugyanabban a bekezdés-szerkezetben. Egy kihagyott mondat azt jelenti, hogy elhagytad.",
	].join("\n"),
};

/** The evidence for one source, as the writer prompt carries it. */
export interface AtlasV2WriterEvidenceEntry {
	n: number;
	title: string;
	host: string;
	date: string | null;
	text: string;
}

export function buildWriterEvidenceEntries(
	sources: AtlasV2IndexedSource[],
	limit: number,
): AtlasV2WriterEvidenceEntry[] {
	return sources.slice(0, limit).map((source) => ({
		n: source.n,
		title: source.title,
		host: source.host,
		date: source.date,
		text: sourceEvidenceText(source).slice(0, MAX_EVIDENCE_CHARS_PER_SOURCE),
	}));
}

export interface BuildAtlasV2SectionPromptInput {
	query: string;
	profile: AtlasProfile;
	language: SupportedLanguage;
	currentDate: string;
	section: AtlasV2PlanSection;
	/** The questions this section answers, for context. */
	questions: AtlasV2PlanQuestion[];
	/** The outline, so the writer does not repeat another section's material. */
	outline: Array<{ title: string; brief: string }>;
	evidence: AtlasV2WriterEvidenceEntry[];
}

export function buildAtlasV2SectionPrompt(
	input: BuildAtlasV2SectionPromptInput,
): string {
	return JSON.stringify({
		task: "write_section",
		request: input.query,
		profile: input.profile,
		language: input.language,
		currentDate: input.currentDate,
		section: {
			title: input.section.title,
			brief: input.section.brief,
			questions: input.questions.map((question) => question.question),
		},
		otherSections: input.outline.filter(
			(entry) => entry.title !== input.section.title,
		),
		evidence: input.evidence,
	});
}

export interface BuildAtlasV2SummaryPromptInput {
	query: string;
	language: SupportedLanguage;
	sections: Array<{
		title: string;
		sentences: Array<{ text: string; citations: number[] }>;
	}>;
}

export function buildAtlasV2SummaryPrompt(
	input: BuildAtlasV2SummaryPromptInput,
): string {
	return JSON.stringify({
		task: "write_executive_summary",
		request: input.query,
		language: input.language,
		sections: input.sections,
	});
}

export interface BuildAtlasV2RewritePromptInput {
	language: SupportedLanguage;
	section: { id: string; title: string };
	evidence: AtlasV2WriterEvidenceEntry[];
	failed: Array<{
		paragraphIndex: number;
		sentenceIndex: number;
		text: string;
		citations: number[];
		reasons: string[];
	}>;
}

export function buildAtlasV2RewritePrompt(
	input: BuildAtlasV2RewritePromptInput,
): string {
	return JSON.stringify({
		task: "rewrite_failed_sentences",
		language: input.language,
		section: input.section,
		evidence: input.evidence,
		failedSentences: input.failed,
	});
}

function cleanSentenceText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value
		.replace(/\s+/g, " ")
		.trim()
		// The writer is told not to write citation markers; strip any it wrote
		// anyway so the renderer is the only thing that places them.
		.replace(/\s*\[(?:source|forr[aá]s)?\s*\d{1,3}\]/gi, "")
		.replace(/\s*\[(?:inferred|calc(?::[A-Za-z0-9_-]+)?)\]/gi, "")
		.replace(/\s+([.,;:!?])/g, "$1")
		.trim();
	return normalized ? normalized.slice(0, MAX_SENTENCE_CHARS) : null;
}

function citationNumbers(value: unknown, maxSourceNumber: number): number[] {
	if (!Array.isArray(value)) return [];
	const numbers: number[] = [];
	for (const entry of value) {
		const parsed =
			typeof entry === "number"
				? entry
				: typeof entry === "string"
					? Number.parseInt(entry.replace(/[^\d]/g, ""), 10)
					: Number.NaN;
		if (!Number.isInteger(parsed) || parsed < 1) continue;
		if (parsed > maxSourceNumber) continue;
		if (!numbers.includes(parsed)) numbers.push(parsed);
	}
	return numbers;
}

function parseCalculations(
	value: unknown,
	maxSourceNumber: number,
): {
	calculations: AtlasV2Calculation[];
} {
	if (!Array.isArray(value)) return { calculations: [] };
	const calculations: AtlasV2Calculation[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as {
			id?: unknown;
			expression?: unknown;
			inputs?: unknown;
		};
		const id =
			typeof record.id === "string"
				? record.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)
				: "";
		const expression =
			typeof record.expression === "string"
				? record.expression.replace(/\s+/g, " ").trim().slice(0, 200)
				: "";
		if (!id || !expression) continue;
		if (calculations.some((existing) => existing.id === id)) continue;
		calculations.push({
			id,
			expression,
			inputs: citationNumbers(record.inputs, maxSourceNumber),
		});
		if (calculations.length >= MAX_CALCULATIONS_PER_SECTION) break;
	}
	return { calculations };
}

/**
 * Parses a writer call. Returns null when nothing usable came back, which the
 * pipeline records as a lost section rather than a failed job.
 */
export function parseAtlasV2WrittenSection(
	text: string,
	options: {
		sectionId: string;
		title: string;
		maxSourceNumber: number;
	},
): AtlasV2WrittenSection | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as { paragraphs?: unknown; calculations?: unknown };
	const rawParagraphs = Array.isArray(record.paragraphs)
		? record.paragraphs
		: [];
	const { calculations } = parseCalculations(
		record.calculations,
		options.maxSourceNumber,
	);
	const calculationIds = new Set(calculations.map((entry) => entry.id));

	const paragraphs: AtlasV2WrittenParagraph[] = [];
	for (const rawParagraph of rawParagraphs) {
		const rawSentences = Array.isArray(rawParagraph)
			? rawParagraph
			: Array.isArray((rawParagraph as { sentences?: unknown })?.sentences)
				? (rawParagraph as { sentences: unknown[] }).sentences
				: [];
		const sentences: AtlasV2WrittenSentence[] = [];
		for (const rawSentence of rawSentences) {
			const sentenceRecord =
				typeof rawSentence === "string"
					? { text: rawSentence }
					: ((rawSentence ?? {}) as {
							text?: unknown;
							citations?: unknown;
							inferred?: unknown;
							calcId?: unknown;
						});
			const sentenceText = cleanSentenceText(sentenceRecord.text);
			if (!sentenceText) continue;
			const citations = citationNumbers(
				sentenceRecord.citations,
				options.maxSourceNumber,
			);
			const calcIdRaw =
				typeof sentenceRecord.calcId === "string"
					? sentenceRecord.calcId.replace(/[^A-Za-z0-9_-]/g, "")
					: "";
			sentences.push({
				text: sentenceText,
				citations,
				// A sentence with citations is a sourced claim whatever the model
				// labelled it; `inferred` only means "no source states this".
				inferred: citations.length === 0 && sentenceRecord.inferred === true,
				calcId: calcIdRaw && calculationIds.has(calcIdRaw) ? calcIdRaw : null,
			});
			if (sentences.length >= MAX_SENTENCES_PER_PARAGRAPH) break;
		}
		if (sentences.length > 0) paragraphs.push({ sentences });
		if (paragraphs.length >= MAX_PARAGRAPHS_PER_SECTION) break;
	}

	if (paragraphs.length === 0) return null;
	return {
		sectionId: options.sectionId,
		title: options.title,
		paragraphs,
		calculations,
	};
}

/**
 * Formats a verification failure the way the rewrite prompt hands it back to
 * the writer: the exact mismatch, never a vague "unsupported".
 */
export function describeFailureForWriter(failure: AtlasV2Failure): string {
	return failure.detail;
}
