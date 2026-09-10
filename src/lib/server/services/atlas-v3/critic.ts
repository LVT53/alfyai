// Atlas v3 stage 8: the critic (ADR 0063).
//
// A whole-report pass against a FAILURE TAXONOMY, not a "check your work"
// prompt. Generic self-verification recovers a fraction of what a taxonomy plus
// targeted re-search recovers, and the deterministic half of this taxonomy
// needs no model at all:
//
//   no_verdict          the opening does not state the answer  (deterministic)
//   repeated_claim      the same claim in two sections         (deterministic)
//   hollow_sentence     a sentence with nothing in it          (deterministic)
//   unsupported_figure  a figure no cited quote states         (deterministic)
//   averaged_conflict   "sources disagree" with no adjudication      (model)
//   thin_section        a section with too little to say       (deterministic)
//   missed_requirement  an implicit requirement never addressed      (model)
//   register            officialese, tautology, label titles   (both)
//
// Each finding becomes ONE instruction: rewrite, cut, or needs_evidence with a
// query. `needs_evidence` spends a small research budget and re-enters, which
// is the loop v2 never had — its verifier could only delete.

import type { SupportedLanguage } from "$lib/server/services/language";
import { parseJsonFromText } from "../atlas/json-extract";
import { extractFigures, isCheckableFigure } from "../atlas-v2/number-match";
import { ATLAS_V3_MAX_OUTPUT_TOKENS } from "./config";
import {
	atlasV3LanguageStandard,
	probeAtlasV3Register,
} from "./language-standard";
import type { AtlasV3ModelCall } from "./model-call";
import {
	ATLAS_V3_FAILURE_CODES,
	ATLAS_V3_INSTRUCTION_KINDS,
	type AtlasV3AnswerTable,
	type AtlasV3Ask,
	type AtlasV3EvidenceBank,
	type AtlasV3FailureCode,
	type AtlasV3Finding,
	type AtlasV3InstructionKind,
	type AtlasV3Sentence,
	type AtlasV3Usage,
	type AtlasV3WrittenSection,
} from "./types";

/** Content words shared before two sentences count as the same claim. */
const REPEAT_SHARED_WORDS = 4;
/** A section below this many sentences is thin whatever it says. */
export const ATLAS_V3_MIN_SECTION_SENTENCES = 3;

const STOPWORDS = new Set([
	"the","a","an","of","in","on","at","to","for","and","or","but","is","are",
	"was","were","be","been","has","have","had","that","this","these","those",
	"it","its","by","with","as","from","than","which","also","more","most",
	"a","az","és","hogy","nem","is","de","vagy","egy","ban","ben","ra","re",
	"val","vel","ról","ről","volt","lesz","mint","már","még","csak","meg",
]);

function contentWords(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s.,%-]/gu, " ")
			.split(/\s+/)
			.filter((word) => word.length > 2 && !STOPWORDS.has(word)),
	);
}

function sharedWordCount(left: Set<string>, right: Set<string>): number {
	let shared = 0;
	for (const word of left) if (right.has(word)) shared += 1;
	return shared;
}

// ---------------------------------------------------------------------------
// The deterministic half
// ---------------------------------------------------------------------------

export interface DeterministicCriticInput {
	ask: AtlasV3Ask;
	sections: AtlasV3WrittenSection[];
	verdict: AtlasV3Sentence[];
	bank: AtlasV3EvidenceBank;
	language: SupportedLanguage;
	minSectionSentences?: number;
	verdictAnswers: boolean;
}

/**
 * Every finding a rule can reach without a model call. Run FIRST, so the model
 * critic is spent on the judgements only it can make.
 */
export function findAtlasV3DeterministicFindings(
	input: DeterministicCriticInput,
): AtlasV3Finding[] {
	const findings: AtlasV3Finding[] = [];
	const minSentences =
		input.minSectionSentences ?? ATLAS_V3_MIN_SECTION_SENTENCES;

	if (!input.verdictAnswers) {
		findings.push({
			code: "no_verdict",
			nodeId: null,
			quote: input.verdict[0]?.text ?? null,
			detail:
				"the opening does not state the answer with the figure it rests on inside the first 150 words",
			instruction: { kind: "rewrite" },
		});
	}

	// -- repeated claims across sections -------------------------------------
	const seen: Array<{ nodeId: string; text: string; words: Set<string> }> = [];
	for (const section of input.sections) {
		for (const sentence of section.paragraphs.flat()) {
			const words = contentWords(sentence.text);
			if (words.size < REPEAT_SHARED_WORDS) continue;
			const duplicate = seen.find(
				(entry) =>
					entry.nodeId !== section.nodeId &&
					sharedWordCount(entry.words, words) >= REPEAT_SHARED_WORDS,
			);
			if (duplicate) {
				findings.push({
					code: "repeated_claim",
					nodeId: section.nodeId,
					quote: sentence.text,
					detail: `this claim was already made in an earlier section: "${duplicate.text}"`,
					instruction: { kind: "cut" },
				});
				continue;
			}
			seen.push({ nodeId: section.nodeId, text: sentence.text, words });
		}
	}

	// -- hollow sentences and register ---------------------------------------
	for (const section of input.sections) {
		for (const sentence of section.paragraphs.flat()) {
			for (const probe of probeAtlasV3Register({
				text: sentence.text,
				language: input.language,
			})) {
				findings.push({
					code: probe.code === "hollow" ? "hollow_sentence" : "register",
					nodeId: section.nodeId,
					quote: sentence.text,
					detail: probe.detail,
					instruction: { kind: probe.code === "hollow" ? "cut" : "rewrite" },
				});
			}
		}
	}

	// -- unsupported figures -------------------------------------------------
	const quotesById = new Map(input.bank.quotes.map((quote) => [quote.id, quote]));
	for (const section of input.sections) {
		for (const sentence of section.paragraphs.flat()) {
			// A computed figure is checked against the sandbox in verify.ts; a
			// figure from the writer's own head is checked here.
			if (sentence.calcId) continue;
			const figures = extractFigures(sentence.text).filter(isCheckableFigure);
			if (figures.length === 0) continue;
			if (sentence.evidenceIds.length === 0) {
				findings.push({
					code: "unsupported_figure",
					nodeId: section.nodeId,
					quote: sentence.text,
					detail: `"${figures[0].text}" is stated with no evidence behind it`,
					instruction: {
						kind: "needs_evidence",
						query: `${figures[0].text} ${section.title}`.slice(0, 200),
					},
				});
			}
		}
	}

	// -- thin sections -------------------------------------------------------
	for (const section of input.sections) {
		const count = section.paragraphs.flat().length;
		if (count >= minSentences) continue;
		findings.push({
			code: "thin_section",
			nodeId: section.nodeId,
			quote: null,
			detail: `the section carries ${count} sentence(s); it needs at least ${minSentences}`,
			instruction: {
				kind: "needs_evidence",
				query: section.title.slice(0, 200),
			},
		});
	}

	return findings;
}

// ---------------------------------------------------------------------------
// The model half
// ---------------------------------------------------------------------------

const CRITIC_BASE: Record<SupportedLanguage, string[]> = {
	en: [
		"You review a finished research report against a fixed list of failures. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"findings":[{"code":"averaged_conflict","nodeId":"n2","quote":"...","detail":"...","instruction":{"kind":"rewrite"}}]}',
		"`code` is one of: averaged_conflict, missed_requirement, register, hollow_sentence, repeated_claim.",
		"averaged_conflict: the report says sources disagree, or reports a midpoint, without naming the series or definition that differs and saying which to believe.",
		"missed_requirement: an implicit requirement listed in the input is never addressed anywhere in the report.",
		"register: officialese, a tautology, a topic-sentence opener, a label-shaped section title, or an undated volatile figure.",
		"`quote` is the offending sentence VERBATIM from the report, or null for a whole-report finding.",
		'`instruction.kind` is "rewrite" when the sentence can be fixed from evidence already cited, "cut" when it says nothing, or "needs_evidence" with a short `query` when the fix needs a fact the report does not have.',
		"Report only what you can point at. At most 8 findings. If the report is sound, return an empty list.",
		"Never rewrite the report. Findings only.",
	],
	hu: [
		"Egy kész kutatási jelentést vizsgálsz egy rögzített hibalista alapján. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"findings":[{"code":"averaged_conflict","nodeId":"n2","quote":"...","detail":"...","instruction":{"kind":"rewrite"}}]}',
		"A `code` egyike: averaged_conflict, missed_requirement, register, hollow_sentence, repeated_claim.",
		"averaged_conflict: a jelentés azt írja, hogy a források nem egyeznek, vagy középértéket közöl, anélkül hogy megnevezné az eltérő adatsort vagy definíciót, és megmondaná, melyiket kell elhinni.",
		"missed_requirement: a bemenetben felsorolt kimondatlan elvárás sehol nem jelenik meg a jelentésben.",
		"register: hivatali nyelv, tautológia, témamegjelölő nyitómondat, adatcímke jellegű szakaszcím, vagy dátum nélküli változékony szám.",
		"A `quote` a kifogásolt mondat SZÓ SZERINT a jelentésből, vagy null, ha az egész jelentésre vonatkozik.",
		'Az `instruction.kind` „rewrite”, ha a mondat a már hivatkozott bizonyítékból javítható; „cut”, ha semmit nem mond; „needs_evidence” rövid `query` mezővel, ha a javításhoz hiányzó tény kell.',
		"Csak azt jelentsd, amire rá tudsz mutatni. Legfeljebb 8 megállapítás. Ha a jelentés rendben van, üres listát adj.",
		"Soha ne írd át a jelentést. Csak megállapítások.",
	],
};

export function atlasV3CriticSystem(input: {
	language: SupportedLanguage;
	hungarianStandardEnabled?: boolean;
}): string {
	const standard = atlasV3LanguageStandard({
		language: input.language,
		hungarianEnabled: input.hungarianStandardEnabled,
	});
	return [
		...CRITIC_BASE[input.language],
		...(standard ? [standard.criticAddendum] : []),
	].join("\n");
}

export interface BuildAtlasV3CriticPromptInput {
	ask: AtlasV3Ask;
	sections: AtlasV3WrittenSection[];
	verdict: AtlasV3Sentence[];
	answerTable: AtlasV3AnswerTable | null;
	language: SupportedLanguage;
	currentDate: string;
	round: number;
	/** Findings the deterministic pass already made, so the model adds rather than repeats. */
	alreadyFound: AtlasV3Finding[];
}

export function buildAtlasV3CriticPrompt(
	input: BuildAtlasV3CriticPromptInput,
): string {
	return JSON.stringify({
		task: "review_report",
		coreQuestion: input.ask.coreQuestion,
		decision: input.ask.decision,
		implicitRequirements: input.ask.implicitRequirements,
		perspectives: input.ask.perspectives,
		language: input.language,
		currentDate: input.currentDate,
		round: input.round,
		verdict: input.verdict.map((sentence) => sentence.text),
		hasAnswerTable: input.answerTable !== null,
		sections: input.sections.map((section) => ({
			nodeId: section.nodeId,
			title: section.title,
			sentences: section.paragraphs.flat().map((sentence) => sentence.text),
		})),
		alreadyReported: input.alreadyFound.map((finding) => ({
			code: finding.code,
			quote: finding.quote,
		})),
	});
}

export function parseAtlasV3Findings(
	text: string,
	options: { knownNodeIds: readonly string[]; limit?: number },
): AtlasV3Finding[] {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return [];
	const record = parsed as Record<string, unknown>;
	const raw = Array.isArray(record.findings) ? record.findings : [];
	const known = new Set(options.knownNodeIds);
	const findings: AtlasV3Finding[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const item = entry as Record<string, unknown>;
		const code = parseCode(item.code);
		if (!code) continue;
		const instruction =
			(item.instruction ?? {}) as Record<string, unknown> | undefined;
		const kind = parseKind(instruction?.kind);
		const query = clean(instruction?.query, 200);
		findings.push({
			code,
			nodeId:
				typeof item.nodeId === "string" && known.has(item.nodeId.trim())
					? item.nodeId.trim()
					: null,
			quote: clean(item.quote, 600) || null,
			detail: clean(item.detail, 300) || code,
			instruction:
				// `needs_evidence` without a query is not actionable; it degrades to
				// a rewrite rather than queuing a search for nothing.
				kind === "needs_evidence" && query
					? { kind, query }
					: { kind: kind === "needs_evidence" ? "rewrite" : kind },
		});
		if (findings.length >= (options.limit ?? 8)) break;
	}
	return findings;
}

function parseCode(value: unknown): AtlasV3FailureCode | null {
	return typeof value === "string" &&
		(ATLAS_V3_FAILURE_CODES as readonly string[]).includes(value)
		? (value as AtlasV3FailureCode)
		: null;
}

function parseKind(value: unknown): AtlasV3InstructionKind {
	return typeof value === "string" &&
		(ATLAS_V3_INSTRUCTION_KINDS as readonly string[]).includes(value)
		? (value as AtlasV3InstructionKind)
		: "rewrite";
}

function clean(value: unknown, maxChars: number): string {
	return typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, maxChars)
		: "";
}

export interface RunAtlasV3CriticInput extends BuildAtlasV3CriticPromptInput {
	bank: AtlasV3EvidenceBank;
	verdictAnswers: boolean;
	hungarianStandardEnabled?: boolean;
	runModel: AtlasV3ModelCall;
	onUsage?: (usage: AtlasV3Usage) => void;
}

/** The deterministic findings plus whatever the model adds, deduplicated. */
export async function runAtlasV3Critic(
	input: RunAtlasV3CriticInput,
): Promise<AtlasV3Finding[]> {
	const deterministic = findAtlasV3DeterministicFindings({
		ask: input.ask,
		sections: input.sections,
		verdict: input.verdict,
		bank: input.bank,
		language: input.language,
		verdictAnswers: input.verdictAnswers,
	});
	let modelFindings: AtlasV3Finding[] = [];
	try {
		const call = await input.runModel({
			stage: `v3:critic:${input.round}`,
			thinkingMode: "off",
			maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.critic,
			system: atlasV3CriticSystem({
				language: input.language,
				hungarianStandardEnabled: input.hungarianStandardEnabled,
			}),
			prompt: buildAtlasV3CriticPrompt({ ...input, alreadyFound: deterministic }),
		});
		input.onUsage?.(call.usage);
		modelFindings = parseAtlasV3Findings(call.text, {
			knownNodeIds: input.sections.map((section) => section.nodeId),
		});
	} catch {
		// A critic that will not answer must not fail the report: the
		// deterministic findings are the floor, and they are the ones that matter
		// most anyway.
		modelFindings = [];
	}
	return dedupeAtlasV3Findings([...deterministic, ...modelFindings]);
}

/** One finding per (code, quote): the two passes overlap by design. */
export function dedupeAtlasV3Findings(
	findings: readonly AtlasV3Finding[],
): AtlasV3Finding[] {
	const seen = new Set<string>();
	const unique: AtlasV3Finding[] = [];
	for (const finding of findings) {
		const key = `${finding.code}::${(finding.quote ?? finding.nodeId ?? "").toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(finding);
	}
	return unique;
}

// ---------------------------------------------------------------------------
// Applying the instructions
// ---------------------------------------------------------------------------

export interface ApplyAtlasV3CutsResult {
	sections: AtlasV3WrittenSection[];
	cutCount: number;
}

/**
 * Applies every `cut` instruction, matching a finding to its sentence by exact
 * text. Empty paragraphs are dropped; an emptied SECTION is kept as an empty
 * shell so the caller can see it lost its content rather than silently losing
 * the heading too.
 */
export function applyAtlasV3Cuts(input: {
	sections: AtlasV3WrittenSection[];
	findings: readonly AtlasV3Finding[];
}): ApplyAtlasV3CutsResult {
	const cuts = new Map<string, Set<string>>();
	for (const finding of input.findings) {
		if (finding.instruction.kind !== "cut" || !finding.quote) continue;
		const key = finding.nodeId ?? "*";
		const set = cuts.get(key) ?? new Set<string>();
		set.add(finding.quote.trim().toLowerCase());
		cuts.set(key, set);
	}
	if (cuts.size === 0) return { sections: input.sections, cutCount: 0 };
	let cutCount = 0;
	const sections = input.sections.map((section) => {
		const targets = new Set([
			...(cuts.get(section.nodeId) ?? []),
			...(cuts.get("*") ?? []),
		]);
		if (targets.size === 0) return section;
		const paragraphs = section.paragraphs
			.map((paragraph) =>
				paragraph.filter((sentence) => {
					const hit = targets.has(sentence.text.trim().toLowerCase());
					if (hit) cutCount += 1;
					return !hit;
				}),
			)
			.filter((paragraph) => paragraph.length > 0);
		return { ...section, paragraphs };
	});
	return { sections, cutCount };
}

/** The `needs_evidence` queries, deduplicated and capped. */
export function atlasV3EvidenceQueries(
	findings: readonly AtlasV3Finding[],
	limit = 4,
): string[] {
	const queries: string[] = [];
	for (const finding of findings) {
		if (finding.instruction.kind !== "needs_evidence") continue;
		const query = finding.instruction.query?.trim();
		if (!query) continue;
		if (queries.some((entry) => entry.toLowerCase() === query.toLowerCase())) {
			continue;
		}
		queries.push(query);
		if (queries.length >= limit) break;
	}
	return queries;
}

/** Node ids a `rewrite` instruction names, in report order. */
export function atlasV3RewriteNodeIds(
	findings: readonly AtlasV3Finding[],
): string[] {
	const ids: string[] = [];
	for (const finding of findings) {
		if (finding.instruction.kind !== "rewrite" || !finding.nodeId) continue;
		if (!ids.includes(finding.nodeId)) ids.push(finding.nodeId);
	}
	return ids;
}

/** True when the critic found nothing worth another round. */
export function atlasV3CriticSatisfied(
	findings: readonly AtlasV3Finding[],
): boolean {
	return findings.length === 0;
}
