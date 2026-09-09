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
/** The lead pass names figures; it does not need the whole page. */
const MAX_LEAD_EVIDENCE_CHARS_PER_SOURCE = 700;
const MAX_LEAD_CHARS = 240;

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
		"9. NEW MATERIAL ONLY: `sectionsAlreadyWritten` lists what the other sections of this report state. Do NOT restate a figure or finding that is already there — a repeated fact is deleted, so restating one makes the report SHORTER, not longer. Every sentence must add a figure, date, name or position the report does not have yet.",
		"10. If the evidence cannot fill `targetWords` with new facts, write fewer sentences. An honest short section beats a padded one.",
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
		"9. CSAK ÚJ ANYAG: a `sectionsAlreadyWritten` felsorolja, mit állítanak a jelentés többi szakaszai. NE mondd el újra az ott szereplő számot vagy megállapítást — az ismételt tényt töröljük, tehát az ismétléstől a jelentés RÖVIDEBB lesz, nem hosszabb. Minden mondat adjon új számot, dátumot, nevet vagy álláspontot.",
		"10. Ha a bizonyíték nem elég `targetWords` szó új tényhez, írj kevesebb mondatot. Az őszintén rövid szakasz jobb, mint a vizezett.",
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
	/**
	 * What the other sections state, one line each — the lead pass's gists. This
	 * is how a section knows not to restate a fact the report already carries.
	 */
	sectionsAlreadyWritten?: Array<{ title: string; gist: string }>;
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
		...(input.sectionsAlreadyWritten?.length
			? { sectionsAlreadyWritten: input.sectionsAlreadyWritten }
			: {}),
		...(input.targetWords ? { targetWords: input.targetWords } : {}),
		...(input.minSentences ? { minSentences: input.minSentences } : {}),
		maxSentences: input.maxSentences ?? MAX_SENTENCES_PER_SECTION,
		maxParagraphs: input.maxParagraphs ?? MAX_PARAGRAPHS_PER_SECTION,
		maxCitationsPerSentence: 2,
		evidence: input.evidence,
	});
}

// ---------------------------------------------------------------------------
// The section lead pass
// ---------------------------------------------------------------------------

/**
 * Before any section body is written, every section is asked for ONE line
 * naming the figures it will use. Those lines are handed to every body call as
 * `sectionsAlreadyWritten`, which is what stops three sections from stating the
 * same figure — the defect that made the second evaluation's reports both
 * repetitive and short.
 *
 * The lead pass is never published: it produces plain, uncited text used only as
 * context. It also costs less wall time than it saves, because it lets every
 * body call run in one concurrent wave instead of waiting for earlier sections.
 */
export const ATLAS_V2_SECTION_LEAD_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You are given one section of a research report and its evidence. Return ONE sentence of at most 30 words and nothing else — no JSON, no citation markers, no heading.",
		"The sentence names the specific figures, dates or named findings this section will state, so the report's other sections know not to repeat them.",
		"Name only what the evidence actually carries. If the evidence carries no figures, say in plain words what the section can state.",
	].join("\n"),
	hu: [
		"Egy kutatási jelentés egy szakaszát és annak bizonyítékait kapod. EGYETLEN, legfeljebb 30 szavas mondatot adj vissza, semmi mást — se JSON, se hivatkozásjel, se cím.",
		"A mondat nevezze meg azokat a konkrét számokat, dátumokat vagy megállapításokat, amelyeket ez a szakasz ki fog mondani, hogy a jelentés többi szakasza ne ismételje meg őket.",
		"Csak azt nevezd meg, ami a bizonyítékban tényleg benne van. Ha nincs benne szám, mondd el sima szavakkal, mit tud kimondani a szakasz.",
	].join("\n"),
};

export function buildAtlasV2SectionLeadPrompt(input: {
	query: string;
	language: SupportedLanguage;
	section: AtlasV2PlanSection;
	evidence: AtlasV2WriterEvidenceEntry[];
	/** Evidence chars per source; the lead needs far less than a body. */
	evidenceChars?: number;
}): string {
	const chars = input.evidenceChars ?? MAX_LEAD_EVIDENCE_CHARS_PER_SOURCE;
	return JSON.stringify({
		task: "write_section_lead",
		request: input.query,
		language: input.language,
		section: { title: input.section.title, brief: input.section.brief },
		evidence: input.evidence.map((entry) => ({
			n: entry.n,
			title: entry.title,
			text: entry.text.slice(0, chars),
		})),
	});
}

/** The one-line gist, or null when the call came back empty. */
export function parseAtlasV2SectionLead(text: string): string | null {
	const parsed = parseJsonFromText(text);
	const raw =
		typeof parsed === "string"
			? parsed
			: parsed && typeof parsed === "object"
				? firstStringField(parsed as Record<string, unknown>)
				: text;
	const cleaned = cleanSentenceText(raw ?? text);
	if (!cleaned) return null;
	return cleaned.slice(0, MAX_LEAD_CHARS);
}

function firstStringField(record: Record<string, unknown>): string | null {
	for (const key of ["gist", "lead", "sentence", "text", "summary"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return null;
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
 * Formats a verification failure the way the rewrite prompt hands it back to
 * the writer: the exact mismatch, never a vague "unsupported".
 */
export function describeFailureForWriter(failure: AtlasV2Failure): string {
	return failure.detail;
}
