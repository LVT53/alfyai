// Atlas v3 stage 7: ONE writer, section by section (ADR 0063).
//
// v2 wrote its sections in a concurrent wave, each blind to the others, which
// is why the same figure appeared in three sections and why cross-section
// dedup was impossible by construction. v3 writes sequentially with the whole
// report in view: retrieve → think → write → prune.
//
//   RETRIEVE  the section's own evidence ids, and only those;
//   THINK     the outline, the answer table, and the text already written;
//   WRITE     sentences that carry evidence ids, never numbers and never URLs;
//   PRUNE     the ids leave the context with the section.
//
// Three v2 mechanisms are kept because they earned it: thinking off on every
// call, an output cap sized to the section, and the runaway ladder — salvage
// the truncated JSON, retry once at a tighter bound, then a deterministic
// plain-text floor — so a section is never lost to a writer that will not close
// its braces.

import type { SupportedLanguage } from "$lib/server/services/language";
import { parseJsonFromText } from "../atlas/json-extract";
import { salvageTruncatedWriterJson } from "../atlas-v2/writer";
import {
	ATLAS_V3_MAX_EVIDENCE_PER_SENTENCE,
	ATLAS_V3_MAX_OUTPUT_TOKENS,
	ATLAS_V3_VERDICT_WINDOW_WORDS,
	type AtlasV3SectionBudget,
	atlasV3RunawayRetryMaxOutputTokens,
	atlasV3SectionMaxOutputTokens,
} from "./config";
import { atlasV3AlsoStatedBy } from "./evidence-bank";
import { atlasV3LanguageStandard } from "./language-standard";
import type { AtlasV3ModelCall } from "./model-call";
import {
	ATLAS_V3_SENTENCE_KINDS,
	type AtlasV3AnswerTable,
	type AtlasV3Ask,
	type AtlasV3EvidenceBank,
	type AtlasV3Memo,
	type AtlasV3Outline,
	type AtlasV3OutlineNode,
	type AtlasV3Sentence,
	type AtlasV3SentenceKind,
	type AtlasV3Usage,
	type AtlasV3VerifiedSection,
	type AtlasV3VerifiedSentence,
	type AtlasV3WrittenSection,
} from "./types";

const MAX_SENTENCES_PER_PARAGRAPH = 8;
/** Sentences of an already-written section the next section's prompt carries. */
const PREVIOUS_SECTION_SENTENCES = 10;

export interface AtlasV3WriterRunawayCounters {
	length: number;
	salvaged: number;
	retried: number;
	fallback: number;
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const WRITER_BASE: Record<SupportedLanguage, string[]> = {
	en: [
		"You write ONE section of a research report. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"paragraphs":[{"sentences":[{"text":"...","evidenceIds":["e3"],"kind":"claim","calcId":null}]}],"showAnswerTable":false}',
		"CITATIONS ARE IDS. Put evidence ids in `evidenceIds`. NEVER write a number in brackets, never write a URL, never name a source by its position. The report's numbering is added afterwards from the ids.",
		"`kind` is `claim` for a fact a quote states, `synthesis` for a conclusion spanning several quotes, `adjudication` for a sentence that names two measurements and says which to believe.",
		"A `synthesis` sentence MAY carry a figure — that is the point of it — but only a figure its own evidence ids state, or one from `answerTable.derived` named in `calcId`. Never compute a number yourself.",
		"Every sentence that states a figure, a date, a name or a quantity carries at least one evidence id. At most 3 ids per sentence.",
		'WRITE ACROSS SOURCES. "Three trackers put the figure between X and Y; the outlier uses a different denominator" beats one paragraph per source.',
		"`alsoStatedBy` on a quote lists OTHER publishers' quotes stating the same figure. Cite them alongside it: a figure two independent publishers state should say so and carry both ids.",
		"ADJUDICATE, DO NOT AVERAGE. When two quotes disagree, name the series or definition that differs and say which to believe, and why: methodology, recency, or proximity to the primary data. Two different measurements are not a disagreement.",
		'DATE VOLATILE FIGURES INLINE, in one clause: "65.1 GW (as of December 2025)".',
		"DO NOT REPEAT what the sections already written have said. You are shown them. A fact stated once is stated.",
		"NO HOLLOW SENTENCES. Every sentence carries a fact, a number, a comparison or a judgement. Never open with what the section is about.",
		'Set "showAnswerTable" to true in AT MOST ONE section — the one whose argument the table IS. Leave it false everywhere else.',
	],
	hu: [
		"EGY szakaszt írsz egy kutatási jelentésből. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"paragraphs":[{"sentences":[{"text":"...","evidenceIds":["e3"],"kind":"claim","calcId":null}]}],"showAnswerTable":false}',
		"A HIVATKOZÁS AZONOSÍTÓ. Az `evidenceIds` mezőbe kerül. SOHA ne írj szögletes zárójeles számot, se URL-t, se sorszám szerinti forráshivatkozást. A számozás utólag kerül be az azonosítókból.",
		"A `kind` értéke `claim`, ha egy idézet állítja a tényt; `synthesis`, ha több idézeten átívelő következtetés; `adjudication`, ha a mondat két mérést nevez meg, és megmondja, melyiket kell elhinni.",
		"A `synthesis` mondat TARTALMAZHAT számot — épp ez a lényege —, de csak olyat, amelyet a saját bizonyítékai kimondanak, vagy amely az `answerTable.derived` egyik eleme a `calcId` alapján. Te magad ne számolj.",
		"Minden mondat, amely számot, dátumot, nevet vagy mennyiséget állít, legalább egy bizonyítékazonosítót visel. Mondatonként legfeljebb 3.",
		"FORRÁSOKON ÁTÍVELVE ÍRJ. „Három adatszolgáltató X és Y közé teszi; a kilógó más nevezőt használ” jobb, mint forrásonként egy bekezdés.",
		"Az idézeten szereplő `alsoStatedBy` MÁS közzétevők ugyanazt a számot állító idézeteit sorolja fel. Hivatkozd őket együtt: ha két független közzétevő is kimondja a számot, mondd ki ezt, és vidd mindkét azonosítót.",
		"DÖNTS, NE ÁTLAGOLJ. Ha két idézet eltér, nevezd meg az eltérő adatsort vagy definíciót, és mondd meg, melyiket kell elhinni és miért: módszertan, frissesség, vagy az elsődleges adathoz való közelség. Két különböző mérés nem ellentmondás.",
		"A VÁLTOZÉKONY SZÁMOKAT DÁTUMOZD egyetlen tagmondatban: „65,1 GW (2025. decemberi adat)”.",
		"NE ISMÉTELD, amit a már megírt szakaszok kimondtak. Látod őket. Ami egyszer elhangzott, elhangzott.",
		"SEMMILYEN ÜRES MONDAT. Minden mondat tényt, számot, összevetést vagy ítéletet hordoz. Soha ne kezdd azzal, miről szól a szakasz.",
		'A "showAnswerTable" LEGFELJEBB EGY szakaszban legyen true — abban, amelynek az érvelése maga a táblázat. Máshol false.',
	],
};

export function atlasV3WriterSystem(input: {
	language: SupportedLanguage;
	hungarianStandardEnabled?: boolean;
}): string {
	const standard = atlasV3LanguageStandard({
		language: input.language,
		hungarianEnabled: input.hungarianStandardEnabled,
	});
	return [
		...WRITER_BASE[input.language],
		...(standard ? [standard.writerAddendum] : []),
	].join("\n");
}

/** Prefixed to the system prompt on the ONE retry after a runaway. */
export const ATLAS_V3_STRICT_JSON_PREFACE: Record<SupportedLanguage, string> = {
	en: "Return the JSON object and NOTHING else. Start with { and end with }. Be brief: fewer, denser sentences.",
	hu: "Csak a JSON objektumot add vissza, semmi mást. { jellel kezdd és } jellel zárd. Légy tömör: kevesebb, sűrűbb mondat.",
};

export const ATLAS_V3_PLAIN_TEXT_WRITER_SYSTEM: Record<
	SupportedLanguage,
	string
> = {
	en: [
		"You write ONE section of a research report as PLAIN TEXT. No JSON, no headings, no bullets, no code fence.",
		"One sentence per line. End each line with the evidence ids it rests on, in braces: {e3} or {e3,e7}.",
		"A sentence stating a figure, a date, a name or a quantity MUST end with at least one id. A sentence with no id must state a judgement, never a fact.",
		"Never write a bracketed number and never write a URL.",
	].join("\n"),
	hu: [
		"EGY szakaszt írsz egy kutatási jelentésből, SIMA SZÖVEGKÉNT. Se JSON, se cím, se felsorolás, se kódkerítés.",
		"Soronként egy mondat. Minden sor végén kapcsos zárójelben a bizonyítékazonosítók: {e3} vagy {e3,e7}.",
		"Számot, dátumot, nevet vagy mennyiséget állító mondat végén KÖTELEZŐ legalább egy azonosító. Azonosító nélküli mondat csak ítéletet mondhat ki, tényt soha.",
		"Soha ne írj szögletes zárójeles számot, és soha ne írj URL-t.",
	].join("\n"),
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface BuildAtlasV3SectionPromptInput {
	ask: AtlasV3Ask;
	node: AtlasV3OutlineNode;
	outline: AtlasV3Outline;
	answerTable: AtlasV3AnswerTable | null;
	/** Sections already written, in order, as flat sentences. */
	previousSections: Array<{ title: string; sentences: string[] }>;
	/** ONLY this section's quotes. The prune step is the caller not sending more. */
	evidence: Array<{
		id: string;
		text: string;
		publisher: string;
		tier: string;
		date: string | null;
		/** Ids of other publishers' quotes stating the same claim. */
		alsoStatedBy?: string[];
	}>;
	language: SupportedLanguage;
	currentDate: string;
	budget: AtlasV3SectionBudget;
	/** True when no section has claimed the answer table yet. */
	answerTableAvailable: boolean;
}

export function buildAtlasV3SectionPrompt(
	input: BuildAtlasV3SectionPromptInput,
): string {
	return JSON.stringify({
		task: "write_section",
		coreQuestion: input.ask.coreQuestion,
		decision: input.ask.decision,
		implicitRequirements: input.ask.implicitRequirements,
		perspectives: input.ask.perspectives,
		language: input.language,
		currentDate: input.currentDate,
		section: {
			id: input.node.id,
			title: input.node.title,
			claim: input.node.claim,
			// What this section still owes the reader. On a first write these are
			// the outline's own gaps; on a critic rewrite they are the findings
			// verbatim, which is how the instruction reaches the writer at all.
			...(input.node.needs.length > 0 ? { mustAddress: input.node.needs } : {}),
		},
		outline: input.outline.nodes.map((node) => ({
			id: node.id,
			title: node.title,
			claim: node.claim,
		})),
		answerTable: input.answerTable
			? {
					kind: input.answerTable.kind,
					title: input.answerTable.title,
					columns: input.answerTable.columns,
					rows: input.answerTable.rows,
					derived: input.answerTable.derived.map((entry) => ({
						id: entry.id,
						label: entry.label,
						value: entry.value,
						inputs: entry.inputs,
					})),
					available: input.answerTableAvailable,
				}
			: null,
		alreadyWritten: input.previousSections.map((section) => ({
			title: section.title,
			sentences: section.sentences.slice(0, PREVIOUS_SECTION_SENTENCES),
		})),
		evidence: input.evidence,
		budget: {
			targetWords: input.budget.targetWords,
			minSentences: input.budget.minSentences,
			maxSentences: input.budget.maxSentences,
			maxParagraphs: input.budget.maxParagraphs,
			maxEvidenceIdsPerSentence: ATLAS_V3_MAX_EVIDENCE_PER_SENTENCE,
		},
	});
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParseAtlasV3SectionOptions {
	nodeId: string;
	title: string;
	knownEvidenceIds: readonly string[];
	knownCalcIds?: readonly string[];
	maxSentences: number;
	maxParagraphs: number;
}

export interface ParsedAtlasV3Section {
	section: AtlasV3WrittenSection;
	showAnswerTable: boolean;
}

export function parseAtlasV3Section(
	text: string,
	options: ParseAtlasV3SectionOptions,
): ParsedAtlasV3Section | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	const rawParagraphs = Array.isArray(record.paragraphs)
		? record.paragraphs
		: [];
	const known = new Set(options.knownEvidenceIds);
	const knownCalcs = new Set(options.knownCalcIds ?? []);
	const paragraphs: AtlasV3Sentence[][] = [];
	let sentenceCount = 0;

	for (const rawParagraph of rawParagraphs) {
		const rawSentences = Array.isArray(rawParagraph)
			? rawParagraph
			: Array.isArray((rawParagraph as { sentences?: unknown })?.sentences)
				? (rawParagraph as { sentences: unknown[] }).sentences
				: [];
		const sentences: AtlasV3Sentence[] = [];
		for (const rawSentence of rawSentences) {
			if (sentenceCount >= options.maxSentences) break;
			const sentence = parseSentence(rawSentence, known, knownCalcs);
			if (!sentence) continue;
			sentences.push(sentence);
			sentenceCount += 1;
			if (sentences.length >= MAX_SENTENCES_PER_PARAGRAPH) break;
		}
		if (sentences.length > 0) paragraphs.push(sentences);
		if (paragraphs.length >= options.maxParagraphs) break;
		if (sentenceCount >= options.maxSentences) break;
	}
	if (paragraphs.length === 0) return null;
	return {
		section: {
			nodeId: options.nodeId,
			title: options.title,
			paragraphs,
			table: null,
		},
		showAnswerTable: record.showAnswerTable === true,
	};
}

function parseSentence(
	raw: unknown,
	known: Set<string>,
	knownCalcs: Set<string>,
): AtlasV3Sentence | null {
	const record =
		typeof raw === "string"
			? { text: raw }
			: ((raw ?? {}) as Record<string, unknown>);
	const text = cleanSentenceText(record.text);
	if (!text) return null;
	const evidenceIds: string[] = [];
	if (Array.isArray(record.evidenceIds)) {
		for (const entry of record.evidenceIds) {
			if (typeof entry !== "string") continue;
			const id = entry.trim();
			// An id the bank does not hold is a hallucinated citation; dropping it
			// here is what makes "every citation resolves" true by construction.
			if (!known.has(id) || evidenceIds.includes(id)) continue;
			evidenceIds.push(id);
			if (evidenceIds.length >= ATLAS_V3_MAX_EVIDENCE_PER_SENTENCE) break;
		}
	}
	const calcIdRaw =
		typeof record.calcId === "string"
			? record.calcId.replace(/[^A-Za-z0-9_-]/g, "")
			: "";
	return {
		text,
		evidenceIds,
		kind: parseKind(record.kind, evidenceIds.length),
		calcId: calcIdRaw && knownCalcs.has(calcIdRaw) ? calcIdRaw : null,
	};
}

function parseKind(value: unknown, evidenceCount: number): AtlasV3SentenceKind {
	if (
		typeof value === "string" &&
		(ATLAS_V3_SENTENCE_KINDS as readonly string[]).includes(value)
	) {
		return value as AtlasV3SentenceKind;
	}
	// A sentence with several ids is spanning sources whatever it called itself.
	return evidenceCount > 1 ? "synthesis" : "claim";
}

/**
 * Strips the two things a writer emitting ids must never produce: a bracketed
 * citation number and a bare URL. Both are removed rather than rejected — the
 * sentence is usually fine and the marker is the model reverting to v2's habit.
 */
export function cleanSentenceText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/\[\s*\d+(?:\s*[,;]\s*\d+)*\s*\]/g, "")
		.replace(/\bhttps?:\/\/\S+/gi, "")
		.replace(/\{\s*e\d+(?:\s*,\s*e\d+)*\s*\}/gi, "")
		.replace(/\s+/g, " ")
		.replace(/\s+([.,;:!?])/g, "$1")
		.trim()
		.slice(0, 600);
}

export function countAtlasV3Sentences(
	section: AtlasV3WrittenSection | null,
): number {
	if (!section) return 0;
	return section.paragraphs.reduce(
		(total, paragraph) => total + paragraph.length,
		0,
	);
}

/** v2's truncated-JSON repair, reused: a cut-off body is a body up to the cut. */
export function salvageAtlasV3Section(
	text: string,
	options: ParseAtlasV3SectionOptions,
): ParsedAtlasV3Section | null {
	const repaired = salvageTruncatedWriterJson(text);
	return repaired ? parseAtlasV3Section(repaired, options) : null;
}

/** Trailing `{e3}` or `{e3,e7}` evidence markers on a plain-text line. */
const TRAILING_EVIDENCE = /\{\s*(e\d+(?:\s*,\s*e\d+)*)\s*\}\s*$/i;

/**
 * The plain-text floor: one sentence per line, each ending in its ids. Parsed
 * deterministically, so a truncated answer still yields a section — the cut
 * line simply loses its marker and is dropped.
 */
export function parseAtlasV3PlainTextSection(
	text: string,
	options: ParseAtlasV3SectionOptions & { truncated?: boolean },
): AtlasV3WrittenSection | null {
	const known = new Set(options.knownEvidenceIds);
	const lines = text
		.split(/\r?\n/)
		.map((line) =>
			line
				.trim()
				.replace(/^(?:[-*•]|#{1,6}|\d+[.)])\s+/, "")
				.trim(),
		)
		.filter((line) => line.length > 0 && !/^(?:```|\{|\}|\[|\])/.test(line));
	if (lines.length === 0) return null;
	const usable = options.truncated ? lines.slice(0, -1) : lines;
	const sentences: AtlasV3Sentence[] = [];
	for (const line of usable) {
		const match = TRAILING_EVIDENCE.exec(line);
		const body = cleanSentenceText(
			match ? line.slice(0, match.index).trim() : line,
		);
		if (!body) continue;
		const evidenceIds = (match?.[1] ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter((id) => known.has(id))
			.slice(0, ATLAS_V3_MAX_EVIDENCE_PER_SENTENCE);
		sentences.push({
			text: body,
			evidenceIds,
			kind: evidenceIds.length > 1 ? "synthesis" : "claim",
			calcId: null,
		});
		if (sentences.length >= options.maxSentences) break;
	}
	if (sentences.length === 0) return null;
	// Paragraphs the plain-text path cannot know about: a fixed split keeps the
	// renderer's paragraph breaks sane without inventing structure.
	const perParagraph = Math.max(
		1,
		Math.ceil(sentences.length / Math.max(1, options.maxParagraphs)),
	);
	const paragraphs: AtlasV3Sentence[][] = [];
	for (let index = 0; index < sentences.length; index += perParagraph) {
		paragraphs.push(sentences.slice(index, index + perParagraph));
	}
	return {
		nodeId: options.nodeId,
		title: options.title,
		paragraphs,
		table: null,
	};
}

// ---------------------------------------------------------------------------
// Writing the report
// ---------------------------------------------------------------------------

export interface WriteAtlasV3ReportInput {
	ask: AtlasV3Ask;
	outline: AtlasV3Outline;
	answerTable: AtlasV3AnswerTable | null;
	bank: AtlasV3EvidenceBank;
	language: SupportedLanguage;
	currentDate: string;
	budget: AtlasV3SectionBudget;
	maxEvidencePerSection: number;
	hungarianStandardEnabled?: boolean;
	runModel: AtlasV3ModelCall;
	onUsage?: (usage: AtlasV3Usage) => void;
	onSectionDone?: (input: { nodeId: string }) => void | Promise<void>;
}

export interface WriteAtlasV3ReportResult {
	sections: AtlasV3WrittenSection[];
	runaways: AtlasV3WriterRunawayCounters;
	/** Nodes the writer lost, with why. A short report names its own cause. */
	dropped: Array<{ nodeId: string; reason: string }>;
}

export async function writeAtlasV3Report(
	input: WriteAtlasV3ReportInput,
): Promise<WriteAtlasV3ReportResult> {
	const quotesById = new Map(
		input.bank.quotes.map((quote) => [quote.id, quote]),
	);
	const sourcesById = new Map(
		input.bank.sources.map((source) => [source.id, source]),
	);
	const calcIds = (input.answerTable?.derived ?? []).map((entry) => entry.id);
	const maxOutputTokens = atlasV3SectionMaxOutputTokens(
		input.budget.targetWords,
	);
	const retryMaxOutputTokens =
		atlasV3RunawayRetryMaxOutputTokens(maxOutputTokens);
	const system = atlasV3WriterSystem({
		language: input.language,
		hungarianStandardEnabled: input.hungarianStandardEnabled,
	});

	const sections: AtlasV3WrittenSection[] = [];
	const dropped: WriteAtlasV3ReportResult["dropped"] = [];
	const runaways: AtlasV3WriterRunawayCounters = {
		length: 0,
		salvaged: 0,
		retried: 0,
		fallback: 0,
	};
	let answerTableAvailable = input.answerTable !== null;

	const writable = input.outline.nodes.filter((node) => node.status !== "cut");
	for (const node of writable) {
		const evidence = node.evidenceIds
			.map((id) => quotesById.get(id))
			.filter((quote): quote is NonNullable<typeof quote> => Boolean(quote))
			.slice(0, input.maxEvidencePerSection)
			.map((quote) => {
				const source = sourcesById.get(quote.sourceId);
				// The writer cannot see that a figure is corroborated unless it is
				// told; without this every sentence was written as if one publisher
				// had said it, and the confidence dots said so too.
				const alsoStatedBy = atlasV3AlsoStatedBy(input.bank, quote.id);
				return {
					id: quote.id,
					text: quote.text,
					publisher: source?.publisher ?? "",
					tier: source?.tier ?? "press",
					date: source?.date ?? null,
					...(alsoStatedBy.length > 0 ? { alsoStatedBy } : {}),
				};
			});
		if (evidence.length === 0) {
			dropped.push({ nodeId: node.id, reason: "no_evidence" });
			continue;
		}
		const options: ParseAtlasV3SectionOptions = {
			nodeId: node.id,
			title: node.title,
			knownEvidenceIds: evidence.map((entry) => entry.id),
			knownCalcIds: calcIds,
			maxSentences: input.budget.maxSentences,
			maxParagraphs: input.budget.maxParagraphs,
		};
		const prompt = () =>
			buildAtlasV3SectionPrompt({
				ask: input.ask,
				node,
				outline: input.outline,
				answerTable: input.answerTable,
				previousSections: sections.map((section) => ({
					title: section.title,
					sentences: section.paragraphs.flat().map((entry) => entry.text),
				})),
				evidence,
				language: input.language,
				currentDate: input.currentDate,
				budget: input.budget,
				answerTableAvailable,
			});

		let written: ParsedAtlasV3Section | null = null;
		let ranAway = false;
		let reason = "unparsable_body";
		for (let attempt = 0; attempt < 2 && !written; attempt += 1) {
			try {
				const call = await input.runModel({
					stage: `v3:write:${node.id}`,
					thinkingMode: "off",
					maxOutputTokens:
						attempt === 0 || !ranAway ? maxOutputTokens : retryMaxOutputTokens,
					system:
						attempt > 0 && ranAway
							? `${ATLAS_V3_STRICT_JSON_PREFACE[input.language]}\n${system}`
							: system,
					prompt: prompt(),
				});
				input.onUsage?.(call.usage);
				if (call.finishReason === "length") {
					runaways.length += 1;
					ranAway = true;
					reason = "writer_runaway";
				}
				written = parseAtlasV3Section(call.text, options);
				if (!written && call.finishReason === "length") {
					const salvaged = salvageAtlasV3Section(call.text, options);
					if (countAtlasV3Sentences(salvaged?.section ?? null) >= 2) {
						runaways.salvaged += 1;
						written = salvaged;
					}
				}
			} catch (error) {
				reason = `writer_call_failed: ${
					error instanceof Error ? error.message : String(error)
				}`;
			}
			if (!written && attempt === 0) runaways.retried += 1;
		}

		if (!written) {
			// The evidence is here, so the section is written in a shape no output
			// cap can break.
			try {
				const call = await input.runModel({
					stage: `v3:write:plain:${node.id}`,
					thinkingMode: "off",
					maxOutputTokens: retryMaxOutputTokens,
					system: ATLAS_V3_PLAIN_TEXT_WRITER_SYSTEM[input.language],
					prompt: prompt(),
				});
				input.onUsage?.(call.usage);
				const plain = parseAtlasV3PlainTextSection(call.text, {
					...options,
					truncated: call.finishReason === "length",
				});
				if (plain) {
					runaways.fallback += 1;
					written = { section: plain, showAnswerTable: false };
				}
			} catch (error) {
				reason = `${reason}, fallback_failed: ${
					error instanceof Error ? error.message : String(error)
				}`;
			}
		}

		if (!written) {
			dropped.push({ nodeId: node.id, reason });
			continue;
		}
		const section = written.section;
		if (written.showAnswerTable && answerTableAvailable && input.answerTable) {
			section.table = input.answerTable;
			answerTableAvailable = false;
		}
		sections.push(section);
		await input.onSectionDone?.({ nodeId: node.id });
	}

	// The table is the argument, not decoration: if no section claimed it, it
	// goes to the first section, where the reader meets it before the prose that
	// explains it.
	if (answerTableAvailable && input.answerTable && sections.length > 0) {
		sections[0].table = input.answerTable;
	}

	return { sections, runaways, dropped };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export const ATLAS_V3_VERDICT_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You write the VERDICT that opens a research report. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"sentences":[{"text":"...","evidenceIds":["e3"],"kind":"synthesis","calcId":null}]}',
		"The FIRST sentence answers the core question outright, with the number it rests on. Not what the report covers — what the answer IS.",
		"Then: the two or three figures the answer rests on, the one conflict worth naming and how it is resolved, and what would change the conclusion.",
		"At most six sentences. Every figure carries evidence ids. Never a bracketed number, never a URL.",
		"You may use a value from `answerTable.derived` by naming its id in `calcId`. Never compute a number yourself.",
		"If the report could NOT answer the question, say so in the first sentence and say what is missing. Do not pad.",
		"`doNotState`, when present, lists sentences a previous draft made whose figures no quote supports. Do not state them again, and do not refer back to them with `these`, `this` or `they`. Every sentence must stand on its own.",
	].join("\n"),
	hu: [
		"A kutatási jelentést nyitó ÍTÉLETET írod. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"sentences":[{"text":"...","evidenceIds":["e3"],"kind":"synthesis","calcId":null}]}',
		"Az ELSŐ mondat kereken megválaszolja a fő kérdést, a számmal, amin nyugszik. Nem azt, miről szól a jelentés — hanem hogy MI a válasz.",
		"Utána: az a két-három szám, amin a válasz nyugszik, az egy megnevezésre érdemes ellentmondás és annak feloldása, és hogy mi változtatná meg a következtetést.",
		"Legfeljebb hat mondat. Minden szám bizonyítékazonosítót visel. Soha szögletes zárójeles szám, soha URL.",
		"Az `answerTable.derived` egy értékét a `calcId` megnevezésével használhatod. Te magad ne számolj.",
		"Ha a jelentés NEM tudta megválaszolni a kérdést, az első mondat mondja ki ezt, és mondja meg, mi hiányzik. Ne tölts ki helyet.",
		"A `doNotState`, ha szerepel, egy korábbi változat olyan mondatait sorolja fel, amelyek számait egyetlen idézet sem támasztja alá. Ne mondd ki őket újra, és ne utalj vissza rájuk („ezek”, „ez”, „azok”). Minden mondat álljon meg önmagában.",
	].join("\n"),
};

export interface BuildAtlasV3VerdictPromptInput {
	ask: AtlasV3Ask;
	memo: AtlasV3Memo;
	answerTable: AtlasV3AnswerTable | null;
	sections: AtlasV3WrittenSection[];
	evidence: Array<{
		id: string;
		text: string;
		publisher: string;
		alsoStatedBy?: string[];
	}>;
	language: SupportedLanguage;
	currentDate: string;
	/** True when the goal test failed and the verdict must say so. */
	abstain: boolean;
	limitations: Array<{ subject: string; reason: string }>;
	/**
	 * Sentences a previous draft stated that verification could not support.
	 * Named so the regeneration does not simply write them again — and so the
	 * sentences that referred back to them are not orphaned a second time.
	 */
	doNotState?: string[];
}

export function buildAtlasV3VerdictPrompt(
	input: BuildAtlasV3VerdictPromptInput,
): string {
	return JSON.stringify({
		task: "write_verdict",
		coreQuestion: input.ask.coreQuestion,
		decision: input.ask.decision,
		language: input.language,
		currentDate: input.currentDate,
		abstain: input.abstain,
		answerSoFar: input.memo.answerSoFar,
		answerTable: input.answerTable
			? {
					columns: input.answerTable.columns,
					rows: input.answerTable.rows,
					derived: input.answerTable.derived,
				}
			: null,
		sections: input.sections.map((section) => ({
			title: section.title,
			sentences: section.paragraphs
				.flat()
				.slice(0, PREVIOUS_SECTION_SENTENCES)
				.map((sentence) => sentence.text),
		})),
		limitations: input.limitations,
		evidence: input.evidence,
		...(input.doNotState && input.doNotState.length > 0
			? { doNotState: input.doNotState }
			: {}),
		maxSentences: 6,
		verdictWindowWords: ATLAS_V3_VERDICT_WINDOW_WORDS,
	});
}

export function parseAtlasV3Verdict(
	text: string,
	options: {
		knownEvidenceIds: readonly string[];
		knownCalcIds?: readonly string[];
	},
): AtlasV3Sentence[] | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	const raw = Array.isArray(record.sentences)
		? record.sentences
		: Array.isArray(record.paragraphs)
			? (record.paragraphs as unknown[]).flatMap((paragraph) =>
					Array.isArray(paragraph)
						? paragraph
						: Array.isArray((paragraph as { sentences?: unknown })?.sentences)
							? (paragraph as { sentences: unknown[] }).sentences
							: [],
				)
			: [];
	const known = new Set(options.knownEvidenceIds);
	const knownCalcs = new Set(options.knownCalcIds ?? []);
	const sentences: AtlasV3Sentence[] = [];
	for (const entry of raw) {
		const sentence = parseSentence(entry, known, knownCalcs);
		if (!sentence) continue;
		sentences.push(sentence);
		if (sentences.length >= 6) break;
	}
	return sentences.length > 0 ? sentences : null;
}

/**
 * Prefixed to the system prompt on the ONE retry after a reply that did not
 * parse. The shape is restated because the failing replies were prose about the
 * answer rather than the answer's JSON.
 */
export const ATLAS_V3_VERDICT_RETRY_PREFACE: Record<SupportedLanguage, string> =
	{
		en: 'Your previous reply was not valid JSON of that shape. Return ONLY this object and nothing else: {"sentences":[{"text":"...","evidenceIds":["e3"],"kind":"synthesis","calcId":null}]}. Start with { and end with }.',
		hu: 'Az előző válaszod nem volt érvényes, ilyen alakú JSON. KIZÁRÓLAG ezt az objektumot add vissza, semmi mást: {"sentences":[{"text":"...","evidenceIds":["e3"],"kind":"synthesis","calcId":null}]}. { jellel kezdd és } jellel zárd.',
	};

export interface WriteAtlasV3VerdictInput
	extends BuildAtlasV3VerdictPromptInput {
	bank: AtlasV3EvidenceBank;
	runModel: AtlasV3ModelCall;
	onUsage?: (usage: AtlasV3Usage) => void;
	/** Named in the log when a reply does not parse. */
	jobId?: string;
}

/**
 * The verdict, with ONE retry when the reply is not JSON of the shape asked
 * for.
 *
 * A job died on staging because this returned `null` and nothing was logged: a
 * 166-token reply with `finishReason: "stop"` disappeared without a trace and
 * took a finished report with it. Every failure now says what came back, and a
 * `null` here is no longer fatal — the caller assembles a deterministic verdict
 * from the sections instead (`deterministicAtlasV3Verdict`).
 */
export async function writeAtlasV3Verdict(
	input: WriteAtlasV3VerdictInput,
): Promise<AtlasV3Sentence[] | null> {
	const options = {
		knownEvidenceIds: input.bank.quotes.map((quote) => quote.id),
		knownCalcIds: (input.answerTable?.derived ?? []).map((entry) => entry.id),
	};
	const attempt = async (retry: boolean): Promise<AtlasV3Sentence[] | null> => {
		try {
			const call = await input.runModel({
				stage: retry ? "v3:verdict:retry" : "v3:verdict",
				thinkingMode: "off",
				maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.verdict,
				system: retry
					? `${ATLAS_V3_VERDICT_RETRY_PREFACE[input.language]}\n${ATLAS_V3_VERDICT_SYSTEM[input.language]}`
					: ATLAS_V3_VERDICT_SYSTEM[input.language],
				prompt: buildAtlasV3VerdictPrompt(input),
			});
			input.onUsage?.(call.usage);
			const parsed = parseAtlasV3Verdict(call.text, options);
			if (parsed) return parsed;
			// Same repair the sections get: a verdict cut off at the cap is still a
			// verdict up to the cut, and losing it costs the report its opening.
			if (call.finishReason === "length") {
				const repaired = salvageTruncatedWriterJson(call.text);
				const salvaged = repaired
					? parseAtlasV3Verdict(repaired, options)
					: null;
				if (salvaged) return salvaged;
			}
			console.warn("[ATLAS v3] Verdict did not parse", {
				jobId: input.jobId ?? null,
				finishReason: call.finishReason,
				textHead: call.text.slice(0, 600),
			});
			return null;
		} catch (error) {
			console.warn("[ATLAS v3] Verdict did not parse", {
				jobId: input.jobId ?? null,
				finishReason: "error",
				textHead: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	};
	return (await attempt(false)) ?? (await attempt(true));
}

// ---------------------------------------------------------------------------
// The deterministic verdict, and keeping the verdict coherent
// ---------------------------------------------------------------------------

/** The opening sentence of a report that could not answer its question. */
export const ATLAS_V3_ABSTENTION_SENTENCE: Record<SupportedLanguage, string> = {
	en: "This report could not establish an answer to the question asked; what follows is only what the evidence read does support.",
	hu: "Ez a jelentés nem tudta megállapítani a feltett kérdésre a választ; az alábbi csak azt tartalmazza, amit az elolvasott bizonyíték alátámaszt.",
};

/** Sentences the fallback verdict may open with. Text plus its citations. */
interface AtlasV3VerdictCandidate {
	text: string;
	evidenceIds: string[];
	calcId?: string | null;
}

/**
 * One sentence per section, in section order: the first that carries a digit
 * AND rests on evidence or a computed value. A verdict assembled from the
 * report's own load-bearing sentences is worse than a written one and far
 * better than losing a finished report.
 */
export function atlasV3VerdictFallbackSentences<
	T extends AtlasV3VerdictCandidate,
>(input: {
	sections: ReadonlyArray<{ paragraphs: ReadonlyArray<readonly T[]> }>;
	limit?: number;
}): T[] {
	const limit = input.limit ?? 4;
	const picked: T[] = [];
	for (const section of input.sections) {
		const lead = section.paragraphs
			.flat()
			.find(
				(sentence) =>
					/\d/.test(sentence.text) &&
					(sentence.evidenceIds.length > 0 || Boolean(sentence.calcId)),
			);
		if (!lead) continue;
		picked.push(lead);
		if (picked.length >= limit) break;
	}
	return picked;
}

/** The fallback verdict, over sections the writer produced. */
export function deterministicAtlasV3Verdict(input: {
	sections: ReadonlyArray<AtlasV3WrittenSection>;
	language: SupportedLanguage;
	abstain: boolean;
	limit?: number;
}): AtlasV3Sentence[] {
	const picked = atlasV3VerdictFallbackSentences({
		sections: input.sections,
		limit: input.limit,
	});
	return [
		...(input.abstain
			? [
					{
						text: ATLAS_V3_ABSTENTION_SENTENCE[input.language],
						evidenceIds: [],
						kind: "synthesis" as const,
						calcId: null,
					},
				]
			: []),
		...picked.map((sentence) => ({ ...sentence })),
	];
}

/** The same fallback, over sections that already survived verification. */
export function deterministicAtlasV3VerifiedVerdict(input: {
	sections: ReadonlyArray<AtlasV3VerifiedSection>;
	language: SupportedLanguage;
	abstain: boolean;
	limit?: number;
}): AtlasV3VerifiedSentence[] {
	const picked = atlasV3VerdictFallbackSentences({
		sections: input.sections,
		limit: input.limit,
	});
	return [
		...(input.abstain
			? [
					{
						text: ATLAS_V3_ABSTENTION_SENTENCE[input.language],
						evidenceIds: [],
						kind: "synthesis" as const,
						confidence: "inferred" as const,
						outcome: "kept" as const,
						failures: [],
					},
				]
			: []),
		...picked.map((sentence) => ({ ...sentence })),
	];
}

/**
 * Words that make a sentence depend on the one before it. A shipped verdict
 * opened "These core duties include technical documentation..." because
 * verification cut the sentence those duties were named in.
 */
const ATLAS_V3_ANAPHORA: Record<SupportedLanguage, RegExp> = {
	en: /^\s*(these|this|that|those|it|they|such)\b/i,
	hu: /^\s*(ezek|ez|az|azok|ezen)\b/i,
};

/**
 * Drops a surviving sentence whose predecessor was cut and which opens with a
 * reference back to it. Never returns nothing: a dangling opener still beats no
 * verdict at all, and the caller treats an empty verdict as fatal.
 */
export function dropAtlasV3DanglingAnaphora<T extends { text: string }>(input: {
	/** The verdict as it was written, in order. */
	written: ReadonlyArray<{ text: string }>;
	/** What survived verification, in order. */
	kept: readonly T[];
	language: SupportedLanguage;
}): T[] {
	const keptTexts = new Set(input.kept.map((sentence) => sentence.text));
	const anaphora = ATLAS_V3_ANAPHORA[input.language];
	const drop = new Set<string>();
	input.written.forEach((sentence, index) => {
		if (!keptTexts.has(sentence.text)) return;
		const previous = input.written[index - 1];
		if (!previous || keptTexts.has(previous.text)) return;
		if (!anaphora.test(sentence.text)) return;
		drop.add(sentence.text);
	});
	if (drop.size === 0) return [...input.kept];
	const remaining = input.kept.filter(
		(sentence) => !drop.has(sentence.text),
	) as T[];
	return remaining.length > 0 ? remaining : [...input.kept];
}

/** Words before the verdict states an answer. The deterministic gate. */
export function atlasV3VerdictAnswersInWindow(input: {
	verdict: readonly AtlasV3Sentence[];
	windowWords?: number;
}): boolean {
	const window = input.windowWords ?? ATLAS_V3_VERDICT_WINDOW_WORDS;
	let words = 0;
	for (const sentence of input.verdict) {
		const count = sentence.text.split(/\s+/).filter(Boolean).length;
		if (words + count > window) break;
		// An answer is a sentence that carries a figure or a computed value and
		// rests on evidence — not a sentence about what the report examines.
		if (
			(/\d/.test(sentence.text) || sentence.calcId !== null) &&
			(sentence.evidenceIds.length > 0 || sentence.calcId !== null)
		) {
			return true;
		}
		words += count;
	}
	return false;
}
