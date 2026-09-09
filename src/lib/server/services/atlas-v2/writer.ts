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
/** Absolute bound when no profile budget is passed; see budget.ts. */
const MAX_SENTENCES_PER_SECTION = 28;
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
		"3a. Cite AT MOST TWO sources per sentence: the ones that actually state the claim. A third citation adds nothing a reader can use.",
		'3b. A sentence that carries no factual claim — a transition, or a line saying what the section covers — takes NO citations: give it an empty `citations` list and "inferred": true.',
		'4. A sentence that synthesises across sources without any source stating it directly is allowed ONLY as hedged prose with "inferred": true, an empty `citations` list, and NO figure, date or quantity inside it.',
		"5. When independent sources disagree on a figure, write ONE sentence that states both figures and cite both sources.",
		"6. Arithmetic you perform yourself goes in `calculations` as a single Python expression over figures from the cited `inputs`; reference it from a sentence with `calcId`. Never compute in your head.",
		"7. No images. No source list. No section heading — the title is given. No mention of your own process, of confidence levels, or of the word 'basis'.",
		"Write in the report's language. Prefer short, factual sentences over long ones.",
		"8. LENGTH: write about `targetWords` words, and at least `minSentences` sentences. Sentences past `maxSentences` are dropped rather than published, so stay between the two.",
		"9. Write YOUR section: `otherSections` names what the rest of the report covers, so leave those topics to them. Never return an empty `paragraphs` list — if the evidence is thin, write the few sentences it does support.",
	].join("\n"),
	hu: [
		"Egy kutatási jelentés egy szakaszát írod számozott bizonyítékokból. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"paragraphs":[{"sentences":[{"text":"...","citations":[3,7],"inferred":false}]}],"calculations":[{"id":"c1","expression":"8/12*100","inputs":[3]}]}',
		"SZABÁLYOK, fontossági sorrendben:",
		"1. Minden szám, dátum, név, mennyiség és megnevezett álláspont mögött legyen legalább egy forrás, amit az adott mondathoz hivatkozol. A hivatkozás forrásszám a `citations` mezőben.",
		"2. Soha ne írj olyan számot, amit nem találsz a bizonyítékban. Ha nincs benne, arról írj, ami benne van.",
		"3. A hivatkozásjelet NE írd a `text`-be — azt a megjelenítő teszi hozzá. A mondat legyen sima próza.",
		"3a. Mondatonként LEGFELJEBB KÉT forrást hivatkozz: azokat, amelyek tényleg kimondják az állítást. A harmadik hivatkozás semmit nem ad az olvasónak.",
		'3b. A tényállítást nem tartalmazó mondat — átvezetés vagy a szakasz tárgyát bemutató sor — NE kapjon hivatkozást: üres `citations` lista és "inferred": true.',
		'4. Több forráson átnyúló szintézis mondat CSAK óvatos megfogalmazással, "inferred": true értékkel, üres `citations` listával és szám, dátum vagy mennyiség NÉLKÜL engedélyezett.',
		"5. Ha független források más számot adnak, EGY mondatban írd le mindkét számot, és mindkét forrást hivatkozd.",
		"6. Az általad végzett számítás a `calculations` mezőbe kerül egyetlen Python kifejezésként a hivatkozott `inputs` számaiból; a mondatból `calcId`-vel hivatkozz rá. Fejben soha ne számolj.",
		"7. Ne legyen kép, forráslista, szakaszcím — a címet megadjuk. Ne írj a saját folyamatodról, bizonyossági szintekről, és ne használd a „basis” szót.",
		"A jelentés nyelvén írj. A rövid, tényszerű mondatokat részesítsd előnyben.",
		"8. HOSSZ: körülbelül `targetWords` szót írj, és legalább `minSentences` mondatot. A `maxSentences` feletti mondatok törlődnek, tehát a kettő között maradj.",
		"9. A SAJÁT szakaszodat írd: az `otherSections` megmondja, mivel foglalkozik a jelentés többi része, azokat hagyd rájuk. Soha ne adj vissza üres `paragraphs` listát — ha kevés a bizonyíték, írd meg azt a néhány mondatot, amit alátámaszt.",
	].join("\n"),
};

export const ATLAS_V2_SUMMARY_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You write the executive summary of a research report from its finished sections. Return STRICT JSON only, in the same shape as a section.",
		"Every citation you use must already appear in the section sentence you are summarising — you may not introduce a source or a figure the sections do not carry.",
		"THE FIRST SENTENCE ANSWERS `coreQuestion` DIRECTLY, with the figure or named finding that answers it and the citations that carry it. Not context, not what the report covers, not the most interesting detail — the answer.",
		"If the sections do not answer the core question, say so plainly in the first sentence instead of answering a different question.",
		"Then the rest: at most 3 paragraphs, 3-6 sentences each, at most two citations per sentence.",
		"No headings, no source list, no mention of your own process.",
	].join("\n"),
	hu: [
		"Egy kutatási jelentés vezetői összefoglalóját írod a kész szakaszaiból. KIZÁRÓLAG szigorú JSON-t adj vissza, ugyanabban az alakban, mint egy szakasz.",
		"Minden használt hivatkozás szerepeljen már abban a szakaszmondatban, amit összefoglalsz — új forrást vagy számot nem vezethetsz be.",
		"AZ ELSŐ MONDAT KÖZVETLENÜL MEGVÁLASZOLJA a `coreQuestion` kérdést: a választ adó számmal vagy megnevezett ténnyel és az azt hordozó hivatkozásokkal. Nem háttér, nem a jelentés tárgya, nem a legérdekesebb részlet — a válasz.",
		"Ha a szakaszok nem válaszolják meg a fő kérdést, ezt mondd ki az első mondatban, ne más kérdésre válaszolj.",
		"Utána a többi: legfeljebb 3 bekezdés, bekezdésenként 3-6 mondat, mondatonként legfeljebb két hivatkozás.",
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

/**
 * The preface the ONE runaway retry puts in front of the writer system prompt.
 * A model that ran to its output cap either never closed the JSON or wrote
 * reasoning ahead of it; both are answered by saying, first and plainly, that
 * the answer is the object and nothing else.
 */
export const ATLAS_V2_STRICT_JSON_PREFACE: Record<SupportedLanguage, string> = {
	en: "Output the JSON object only. Start with `{` and end with `}`. No prose, no reasoning.",
	hu: "KIZÁRÓLAG a JSON objektumot add ki. `{` jellel kezdj és `}` jellel fejezd be. Semmi próza, semmi gondolatmenet.",
};

/**
 * The last resort when the JSON writer keeps running away: plain text, one
 * sentence per line, each line ending in its `[n]` citations. A truncated
 * plain-text answer still parses — the cut line is simply dropped — which is
 * what makes this the floor under `unparsable_body`.
 */
export const ATLAS_V2_PLAIN_TEXT_WRITER_SYSTEM: Record<
	SupportedLanguage,
	string
> = {
	en: [
		"You write one section of a research report from numbered evidence. Return PLAIN TEXT only — no JSON, no code fence, no heading, no reasoning.",
		"Write ONE sentence per line. End every line with the source numbers it rests on, in square brackets: `... in 2025. [3]` or `... in 2025. [3][7]`.",
		"Every figure, date, name or quantity MUST be stated by a source you cite on that line. Never write a figure the evidence does not carry.",
		"Cite at most two sources per line. A line that carries no factual claim takes no brackets.",
		"No section heading, no source list, no mention of your own process. Write in the report's language.",
	].join("\n"),
	hu: [
		"Egy kutatási jelentés egy szakaszát írod számozott bizonyítékokból. KIZÁRÓLAG SIMA SZÖVEGET adj vissza — se JSON, se kódkerítés, se cím, se gondolatmenet.",
		"Soronként EGY mondatot írj. Minden sor végén szögletes zárójelben álljanak a forrásszámok: `... 2025-ben. [3]` vagy `... 2025-ben. [3][7]`.",
		"Minden szám, dátum, név és mennyiség mögött álljon egy azon a soron hivatkozott forrás. Soha ne írj olyan számot, amit a bizonyíték nem tartalmaz.",
		"Soronként legfeljebb két forrást hivatkozz. A tényállítást nem tartalmazó sor ne kapjon zárójelet.",
		"Ne legyen szakaszcím, forráslista, és ne írj a saját folyamatodról. A jelentés nyelvén írj.",
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
	/** Sentence budget for this section, from the profile's length budget. */
	maxSentences?: number;
	/** Sentences below which this section cannot carry its share of the band. */
	minSentences?: number;
	/** Words this section should aim at; the midpoint share of the band. */
	targetWords?: number;
	maxParagraphs?: number;
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
		...(input.targetWords ? { targetWords: input.targetWords } : {}),
		...(input.minSentences ? { minSentences: input.minSentences } : {}),
		maxSentences: input.maxSentences ?? MAX_SENTENCES_PER_SECTION,
		maxParagraphs: input.maxParagraphs ?? MAX_PARAGRAPHS_PER_SECTION,
		maxCitationsPerSentence: 2,
		evidence: input.evidence,
	});
}

/**
 * The plain-text fallback's prompt. Same material as the JSON prompt, minus the
 * envelope knobs the plain-text shape has no use for.
 */
export function buildAtlasV2PlainTextSectionPrompt(
	input: BuildAtlasV2SectionPromptInput,
): string {
	return JSON.stringify({
		task: "write_section_plain_text",
		request: input.query,
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
		...(input.targetWords ? { targetWords: input.targetWords } : {}),
		maxSentences: input.maxSentences ?? MAX_SENTENCES_PER_SECTION,
		maxCitationsPerSentence: 2,
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
	/** The request as one question; the first sentence must answer it. */
	coreQuestion?: string;
	/** Citations carrying the core question's evidence, for the retry. */
	coreCitations?: number[];
	/**
	 * Set on the ONE retry the pipeline allows when the first summary answered
	 * something else. It names the sources that carry the answer.
	 */
	insistOnCoreAnswer?: boolean;
}

export function buildAtlasV2SummaryPrompt(
	input: BuildAtlasV2SummaryPromptInput,
): string {
	return JSON.stringify({
		task: "write_executive_summary",
		request: input.query,
		...(input.coreQuestion ? { coreQuestion: input.coreQuestion } : {}),
		...(input.coreCitations?.length
			? { citationsThatAnswerTheCoreQuestion: input.coreCitations }
			: {}),
		...(input.insistOnCoreAnswer
			? {
					retryReason:
						"Your previous summary did not answer the core question. Open with one sentence that answers it using the evidence behind `citationsThatAnswerTheCoreQuestion`, or state plainly that the evidence does not answer it.",
				}
			: {}),
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
		/** Sentence budget for this section; extra sentences are discarded. */
		maxSentences?: number;
		maxParagraphs?: number;
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

	const sentenceBudget = Math.max(
		1,
		options.maxSentences ?? MAX_SENTENCES_PER_SECTION,
	);
	const paragraphBudget = Math.max(
		1,
		Math.min(
			MAX_PARAGRAPHS_PER_SECTION,
			options.maxParagraphs ?? MAX_PARAGRAPHS_PER_SECTION,
		),
	);
	let sentenceCount = 0;

	const paragraphs: AtlasV2WrittenParagraph[] = [];
	for (const rawParagraph of rawParagraphs) {
		const rawSentences = Array.isArray(rawParagraph)
			? rawParagraph
			: Array.isArray((rawParagraph as { sentences?: unknown })?.sentences)
				? (rawParagraph as { sentences: unknown[] }).sentences
				: [];
		const sentences: AtlasV2WrittenSentence[] = [];
		for (const rawSentence of rawSentences) {
			if (sentenceCount >= sentenceBudget) break;
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
			sentenceCount += 1;
			if (sentences.length >= MAX_SENTENCES_PER_PARAGRAPH) break;
		}
		if (sentences.length > 0) paragraphs.push({ sentences });
		if (paragraphs.length >= paragraphBudget) break;
		if (sentenceCount >= sentenceBudget) break;
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
 * Repairs a writer answer the model never finished.
 *
 * A `finishReason: "length"` body is valid JSON up to the point the cap cut it
 * and rubble after: half a key, half a string, an unclosed array. This walks
 * the text once, remembers the last position at which a NESTED value closed
 * cleanly — the end of a complete sentence object, of a `citations` array — and
 * rebuilds the document from that prefix plus the closers the open stack still
 * needs. Everything after the cut point is discarded, so a half-written
 * sentence is never published as a whole one.
 *
 * Returns null when nothing closed cleanly, and returns the object as-is when
 * the text was complete after all.
 */
export function salvageTruncatedWriterJson(text: string): string | null {
	const start = text.indexOf("{");
	if (start < 0) return null;
	const body = text.slice(start);
	const stack: Array<"{" | "["> = [];
	let inString = false;
	let escaped = false;
	let safeCut = -1;
	let safeStack: Array<"{" | "["> = [];
	for (let index = 0; index < body.length; index += 1) {
		const character = body[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{" || character === "[") {
			stack.push(character);
			continue;
		}
		if (character !== "}" && character !== "]") continue;
		stack.pop();
		// The root object closed: the answer was complete, cap or no cap.
		if (stack.length === 0) return body.slice(0, index + 1);
		safeCut = index + 1;
		safeStack = [...stack];
	}
	if (safeCut < 0) return null;
	const closers = [...safeStack]
		.reverse()
		.map((opener) => (opener === "{" ? "}" : "]"))
		.join("");
	return `${body.slice(0, safeCut)}${closers}`;
}

/** Sentences in a written section, for the "did the salvage buy anything" test. */
export function countAtlasV2SectionSentences(
	section: AtlasV2WrittenSection | null,
): number {
	if (!section) return 0;
	return section.paragraphs.reduce(
		(total, paragraph) => total + paragraph.sentences.length,
		0,
	);
}

/**
 * Parses a truncated writer answer, or null when nothing survives the repair.
 * Same options as `parseAtlasV2WrittenSection`, because the repaired text goes
 * through exactly that parser.
 */
export function salvageAtlasV2WrittenSection(
	text: string,
	options: Parameters<typeof parseAtlasV2WrittenSection>[1],
): AtlasV2WrittenSection | null {
	const repaired = salvageTruncatedWriterJson(text);
	if (!repaired) return null;
	return parseAtlasV2WrittenSection(repaired, options);
}

/** Trailing `[3]`, `[3][7]` or `[3, 7]` citation markers on a plain-text line. */
const TRAILING_CITATIONS = /(?:\s*\[[\d\s,;]+\])+\s*$/;

/**
 * Parses the plain-text fallback: one sentence per line, each line ending in
 * its citation markers. Deterministic and truncation-proof — a line the cap cut
 * in half simply loses its markers and, with `truncated`, is dropped.
 */
export function parseAtlasV2PlainTextSection(
	text: string,
	options: {
		sectionId: string;
		title: string;
		maxSourceNumber: number;
		maxSentences?: number;
		/** The answer ended at the output cap; the last line may be a fragment. */
		truncated?: boolean;
	},
): AtlasV2WrittenSection | null {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		// Headings, bullets and stray fences are chrome the prompt asked for
		// none of; a line that is only punctuation carries no sentence.
		.map((line) => line.replace(/^(?:[-*•]|#{1,6}|\d+[.)])\s+/, "").trim())
		.filter((line) => line.length > 0 && !/^(?:```|\{|\}|\[|\])/.test(line));
	if (lines.length === 0) return null;
	// A truncated answer's last line is whatever the cap left behind.
	const usable =
		options.truncated && lines.length > 1 ? lines.slice(0, -1) : lines;

	const budget = Math.max(1, options.maxSentences ?? MAX_SENTENCES_PER_SECTION);
	const sentences: AtlasV2WrittenSentence[] = [];
	for (const line of usable) {
		if (sentences.length >= budget) break;
		const markers = line.match(TRAILING_CITATIONS)?.[0] ?? "";
		const citations = citationNumbers(
			markers.match(/\d+/g) ?? [],
			options.maxSourceNumber,
		).slice(0, 2);
		const sentenceText = cleanSentenceText(
			markers ? line.slice(0, line.length - markers.length) : line,
		);
		if (!sentenceText) continue;
		sentences.push({
			text: sentenceText,
			citations,
			inferred: citations.length === 0,
			calcId: null,
		});
	}
	if (sentences.length === 0) return null;

	// One paragraph per `MAX_SENTENCES_PER_PARAGRAPH`: the plain-text shape
	// carries no paragraph breaks, and a single wall of sentences reads worse
	// than the same sentences in the paragraphs the renderer expects.
	const paragraphs: AtlasV2WrittenParagraph[] = [];
	for (
		let start = 0;
		start < sentences.length;
		start += MAX_SENTENCES_PER_PARAGRAPH
	) {
		paragraphs.push({
			sentences: sentences.slice(start, start + MAX_SENTENCES_PER_PARAGRAPH),
		});
	}
	return {
		sectionId: options.sectionId,
		title: options.title,
		paragraphs,
		calculations: [],
	};
}

/**
 * Formats a verification failure the way the rewrite prompt hands it back to
 * the writer: the exact mismatch, never a vague "unsupported".
 */
export function describeFailureForWriter(failure: AtlasV2Failure): string {
	return failure.detail;
}
