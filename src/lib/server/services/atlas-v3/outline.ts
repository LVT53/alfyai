// Atlas v3 stage 4: the living outline (ADR 0063).
//
// v2's sections were evidence buckets: `targetSectionCount = ceil(questions/2)`
// and each section was written from its questions' sources, so two questions
// that retrieved the same pages produced two near-identical sections, and a
// "Warranty and Support Policies" section nobody asked for opened a report on
// the one topic it could not research.
//
// A v3 node is a CLAIM the report will defend, it lists the evidence it needs,
// it carries the evidence ids it has, and it is rewritten after every research
// round. Two nodes may not rest on the same evidence set — enforced
// deterministically, after the model answers, because it is the rule the model
// is least able to keep.

import type { SupportedLanguage } from "$lib/server/services/language";
import { parseJsonFromText } from "../atlas/json-extract";
import { ATLAS_V3_MAX_OUTPUT_TOKENS } from "./config";
import { atlasV3NormalizeWords } from "./evidence-bank";
import { isLabelShapedTitle } from "./language-standard";
import type { AtlasV3ModelCall } from "./model-call";
import type {
	AtlasV3Ask,
	AtlasV3Claim,
	AtlasV3EvidenceBank,
	AtlasV3Memo,
	AtlasV3Outline,
	AtlasV3OutlineNode,
	AtlasV3Usage,
} from "./types";

const MAX_NEEDS_PER_NODE = 4;
const MAX_TITLE_CHARS = 90;
const MAX_CLAIM_CHARS = 240;
/** Above this a "title" is a sentence; the claim's first clause reads better. */
const MAX_TITLE_WORDS = 14;

/**
 * A title cut to fit, at a WORD boundary, with trailing punctuation removed.
 *
 * `slice(0, 90)` shipped "…marking an incr" as a section heading. A heading is
 * the one string in the report a reader scans rather than reads, so a
 * half-written last word is the most visible defect the pipeline had.
 */
export function clampAtlasV3Title(
	value: string,
	maxChars = MAX_TITLE_CHARS,
): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	const trimTail = (text: string) => text.replace(/[\s,;:—–-]+$/u, "");
	if (normalized.length <= maxChars) return trimTail(normalized);
	const cut = normalized.slice(0, maxChars);
	const lastSpace = cut.lastIndexOf(" ");
	return trimTail(lastSpace > 0 ? cut.slice(0, lastSpace) : cut);
}

/** The first clause of a claim: up to the first comma, semicolon, colon or dash. */
export function atlasV3FirstClause(claim: string): string {
	const normalized = claim.replace(/\s+/g, " ").trim();
	const break_ = /[,;:]|\s[—–]\s/u.exec(normalized);
	return break_ ? normalized.slice(0, break_.index).trim() : normalized;
}

function wordCount(value: string): number {
	return value.split(/\s+/).filter(Boolean).length;
}

/** Capitalises the first letter without touching the rest. */
function capitalise(value: string): string {
	return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export const ATLAS_V3_OUTLINE_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You plan the sections of a research report. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"nodes":[{"id":"n1","title":"...","claim":"...","needs":["..."],"claimIds":["c1"]}],"cut":[{"id":"n4","reason":"..."}]}',
		"A section is a CLAIM the report will defend, not a topic. `claim` is one falsifiable sentence. `title` names that finding in the reader's words, in AT MOST TEN WORDS — never a data label, never a bare year, never `entity — metric`.",
		"Order the sections by the DECISION the reader faces: the answer first, then what drives it, then what would change it.",
		"`needs` is what this section still lacks, as searchable questions. Empty when the evidence shown already supports the claim.",
		"`claimIds` are the claims from the memo this section rests on. Two sections may NOT rest on the same set — if they would, merge them.",
		"Rewrite the outline you are shown: keep what still holds, expand what the new evidence justifies, MERGE sections that now say the same thing, and list in `cut` anything the evidence no longer supports, with the reason.",
		"Never plan a section the evidence cannot fill. A report with four defended sections beats one with eight, three of which admit they found nothing.",
	].join("\n"),
	hu: [
		"Egy kutatási jelentés szakaszait tervezed. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"nodes":[{"id":"n1","title":"...","claim":"...","needs":["..."],"claimIds":["c1"]}],"cut":[{"id":"n4","reason":"..."}]}',
		"A szakasz egy ÁLLÍTÁS, amelyet a jelentés megvéd, nem téma. A `claim` egy cáfolható mondat. A `title` ezt a megállapítást nevezi meg az olvasó szavaival, LEGFELJEBB TÍZ SZÓBAN — soha nem adatcímke, soha nem puszta évszám, soha nem „entitás — mérőszám”.",
		"A szakaszokat a DÖNTÉS szerint rendezd: előbb a válasz, aztán ami mozgatja, végül ami megváltoztatná.",
		"A `needs` az, ami a szakaszból még hiányzik, kereshető kérdésként. Üres, ha a bemutatott bizonyíték már alátámasztja az állítást.",
		"A `claimIds` a feljegyzés azon állításai, amelyeken a szakasz nyugszik. Két szakasz NEM nyugodhat ugyanazon a halmazon — ilyenkor vond össze őket.",
		"A kapott vázlatot írd újra: tartsd meg, ami áll, bővítsd, amit az új bizonyíték indokol, VOND ÖSSZE, ami ugyanazt mondja, és a `cut` alá sorold, amit a bizonyíték már nem támaszt alá, az okkal.",
		"Ne tervezz olyan szakaszt, amit a bizonyíték nem tud kitölteni. A négy megvédett szakaszos jelentés jobb, mint a nyolc szakaszos, amelyből három bevallja, hogy nem talált semmit.",
	].join("\n"),
};

export interface BuildAtlasV3OutlinePromptInput {
	ask: AtlasV3Ask;
	memo: AtlasV3Memo;
	bank: AtlasV3EvidenceBank;
	language: SupportedLanguage;
	currentDate: string;
	round: number;
	minSections: number;
	maxSections: number;
	previous: AtlasV3Outline | null;
}

export function buildAtlasV3OutlinePrompt(
	input: BuildAtlasV3OutlinePromptInput,
): string {
	const claimsById = new Map(
		input.bank.claims.map((claim) => [claim.id, claim]),
	);
	return JSON.stringify({
		task: "revise_outline",
		coreQuestion: input.ask.coreQuestion,
		decision: input.ask.decision,
		shape: input.ask.shape,
		implicitRequirements: input.ask.implicitRequirements,
		perspectives: input.ask.perspectives,
		language: input.language,
		currentDate: input.currentDate,
		round: input.round,
		sectionCount: { min: input.minSections, max: input.maxSections },
		answerSoFar: input.memo.answerSoFar,
		openQuestions: input.memo.openQuestions,
		deadEnds: input.memo.deadEnds,
		claims: input.memo.claimIds
			.map((id) => claimsById.get(id))
			.filter((claim): claim is NonNullable<typeof claim> => Boolean(claim))
			.map((claim) => ({
				id: claim.id,
				entity: claim.entity,
				metric: claim.metric,
				value: claim.value,
				unit: claim.unit,
				period: claim.period,
				series: claim.series,
				status: claim.status,
			})),
		previousOutline:
			input.previous?.nodes.map((node) => ({
				id: node.id,
				title: node.title,
				claim: node.claim,
				needs: node.needs,
				status: node.status,
			})) ?? null,
	});
}

export interface ParsedAtlasV3OutlineNode {
	id: string;
	title: string;
	claim: string;
	needs: string[];
	claimIds: string[];
}

export function parseAtlasV3Outline(
	text: string,
	input: { knownClaimIds: readonly string[]; maxSections: number },
): {
	nodes: ParsedAtlasV3OutlineNode[];
	cut: Array<{ id: string; reason: string }>;
} | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	if (!Array.isArray(record.nodes)) return null;
	const known = new Set(input.knownClaimIds);
	const nodes: ParsedAtlasV3OutlineNode[] = [];
	for (const entry of record.nodes) {
		if (!entry || typeof entry !== "object") continue;
		const node = entry as Record<string, unknown>;
		const claim = clean(node.claim, MAX_CLAIM_CHARS);
		const rawTitle = clean(node.title, MAX_CLAIM_CHARS);
		if (!rawTitle && !claim) continue;
		// A "title" of twenty words is a sentence the model put in the wrong
		// field; the claim's first clause is the heading it meant to write.
		const title = clampAtlasV3Title(
			rawTitle && wordCount(rawTitle) <= MAX_TITLE_WORDS
				? rawTitle
				: claim
					? atlasV3FirstClause(claim)
					: rawTitle,
		);
		if (!title) continue;
		nodes.push({
			id: clean(node.id, 12) || `n${nodes.length + 1}`,
			title,
			claim: claim || title,
			needs: stringList(node.needs, MAX_NEEDS_PER_NODE),
			claimIds: Array.isArray(node.claimIds)
				? node.claimIds
						.filter(
							(id): id is string =>
								typeof id === "string" && known.has(id.trim()),
						)
						.map((id) => id.trim())
				: [],
		});
		if (nodes.length >= input.maxSections) break;
	}
	if (nodes.length === 0) return null;
	const cut: Array<{ id: string; reason: string }> = [];
	if (Array.isArray(record.cut)) {
		for (const entry of record.cut) {
			if (!entry || typeof entry !== "object") continue;
			const item = entry as Record<string, unknown>;
			const id = clean(item.id, 12);
			if (!id) continue;
			cut.push({
				id,
				reason: clean(item.reason, 200) || "no longer supported",
			});
		}
	}
	return { nodes, cut };
}

function clean(value: unknown, maxChars: number): string {
	return typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, maxChars)
		: "";
}

function stringList(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	const items: string[] = [];
	for (const entry of value) {
		const cleaned = clean(entry, 200);
		if (!cleaned) continue;
		if (items.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
			continue;
		}
		items.push(cleaned);
		if (items.length >= limit) break;
	}
	return items;
}

// ---------------------------------------------------------------------------
// Binding evidence to nodes
// ---------------------------------------------------------------------------

/** Every calendar year a string names. */
function yearsIn(value: string): Set<string> {
	const years = new Set<string>();
	for (const match of value.matchAll(/\b(?:19|20)\d{2}\b/gu))
		years.add(match[0]);
	return years;
}

/** True when both sides name years and the sets are not the same. */
function namesDifferentYears(left: Set<string>, right: Set<string>): boolean {
	if (left.size === 0 || right.size === 0) return false;
	if (left.size !== right.size) return true;
	for (const year of left) if (!right.has(year)) return true;
	return false;
}

/**
 * Merges outline nodes that are the same section twice.
 *
 * One staging report shipped both "Obligations for Providers of General-Purpose
 * AI Models — entry into force date" and "Providers of general-purpose AI
 * models — entry into application of obligations"; its cross-section repeat
 * count reached 22 sentences. The evidence-exclusivity rule below cannot catch
 * this, because the model gave the two nodes DIFFERENT claim ids.
 *
 * Two nodes are one when their title-plus-claim word sets overlap by half, or
 * when their claim-id SETS are half the same set. The earlier node wins and
 * takes the union; the loser is recorded in `cut` so Limitations can say what
 * happened to it.
 *
 * Two guards keep a comparison intact, because a report that compares things
 * says most of the same words in every section:
 *
 *  - nodes naming DIFFERENT years never merge. "2025 additions" and "2024
 *    additions" share every word but the one that matters.
 *  - the claim-id rule measures the two sets against their UNION, not against
 *    the smaller of them. "Half the smaller" merged a lead node resting on one
 *    claim into any section that also used it, and merged "price" into
 *    "repairability" the moment they shared one of two claims.
 */
export function mergeAtlasV3DuplicateNodes(
	nodes: readonly ParsedAtlasV3OutlineNode[],
): { nodes: ParsedAtlasV3OutlineNode[]; cut: AtlasV3Outline["cut"] } {
	const kept: ParsedAtlasV3OutlineNode[] = [];
	const cut: AtlasV3Outline["cut"] = [];
	const wordsOf = (node: ParsedAtlasV3OutlineNode) =>
		new Set(atlasV3NormalizeWords(`${node.title} ${node.claim}`));
	for (const node of nodes) {
		const words = wordsOf(node);
		const years = yearsIn(`${node.title} ${node.claim}`);
		const twin = kept.find((existing) => {
			if (
				namesDifferentYears(
					years,
					yearsIn(`${existing.title} ${existing.claim}`),
				)
			)
				return false;
			const existingWords = wordsOf(existing);
			let shared = 0;
			for (const word of words) if (existingWords.has(word)) shared += 1;
			const union = words.size + existingWords.size - shared;
			if (union > 0 && shared / union >= 0.5) return true;
			const ids = new Set([...node.claimIds, ...existing.claimIds]);
			if (ids.size === 0) return false;
			const overlap = node.claimIds.filter((id) =>
				existing.claimIds.includes(id),
			).length;
			return overlap / ids.size >= 0.5;
		});
		if (!twin) {
			kept.push({
				...node,
				claimIds: [...node.claimIds],
				needs: [...node.needs],
			});
			continue;
		}
		for (const claimId of node.claimIds) {
			if (!twin.claimIds.includes(claimId)) twin.claimIds.push(claimId);
		}
		for (const need of node.needs) {
			if (!twin.needs.includes(need)) twin.needs.push(need);
		}
		cut.push({
			id: node.id,
			title: node.title,
			reason: `merged into ${twin.title}`,
		});
	}
	return { nodes: kept, cut };
}

/**
 * Binds quote ids to nodes and enforces the rule the model cannot keep: **two
 * sections may not rest on the same evidence set.**
 *
 * A node's evidence is the quotes behind the claims it named. Where two nodes
 * would carry identical sets, the later one loses the overlap; if that leaves
 * it with nothing, it is marked `cut` with the reason, because a section whose
 * evidence another section already used is exactly the duplicate section v2
 * shipped three times per report.
 */
export function bindAtlasV3Evidence(input: {
	nodes: ParsedAtlasV3OutlineNode[];
	bank: AtlasV3EvidenceBank;
	minEvidencePerNode: number;
	/**
	 * Whether to run the duplicate-node merge first. On for a MODEL outline,
	 * which is where two names for one section come from. Off for the
	 * deterministic one, whose nodes are one per distinct `entity — metric` by
	 * construction: fuzzy-merging those threw away "EU AI Act: enforcement date"
	 * because it shared six words with "EU AI Act: obligations start date".
	 */
	mergeDuplicates?: boolean;
}): AtlasV3Outline {
	const claimsById = new Map(
		input.bank.claims.map((claim) => [claim.id, claim]),
	);
	const merged =
		input.mergeDuplicates === false
			? { nodes: input.nodes, cut: [] as AtlasV3Outline["cut"] }
			: mergeAtlasV3DuplicateNodes(input.nodes);
	const taken = new Set<string>();
	const nodes: AtlasV3OutlineNode[] = [];
	const cut: AtlasV3Outline["cut"] = [...merged.cut];

	for (const node of merged.nodes) {
		const wanted: string[] = [];
		for (const claimId of node.claimIds) {
			for (const evidenceId of claimsById.get(claimId)?.evidenceIds ?? []) {
				if (!wanted.includes(evidenceId)) wanted.push(evidenceId);
			}
		}
		const exclusive = wanted.filter((evidenceId) => !taken.has(evidenceId));
		if (wanted.length > 0 && exclusive.length === 0) {
			cut.push({
				id: node.id,
				title: node.title,
				reason:
					"every quote this section would rest on already belongs to an earlier section",
			});
			continue;
		}
		for (const evidenceId of exclusive) taken.add(evidenceId);
		nodes.push({
			id: node.id,
			title: node.title,
			claim: node.claim,
			needs: node.needs,
			evidenceIds: exclusive,
			status:
				exclusive.length >= input.minEvidencePerNode
					? "ready"
					: exclusive.length > 0
						? "thin"
						: "planned",
		});
	}
	return { nodes, cut };
}

/** The claim of a group a title should be built from: best supported first. */
function bestSupportedClaim(
	claims: ReadonlyArray<AtlasV3Claim | undefined>,
): AtlasV3Claim | null {
	const live = claims.filter((claim): claim is AtlasV3Claim => Boolean(claim));
	const rank: Record<AtlasV3Claim["status"], number> = {
		verified: 0,
		single: 1,
		contested: 2,
		open: 3,
	};
	return (
		[...live].sort(
			(left, right) =>
				rank[left.status] - rank[right.status] ||
				right.evidenceIds.length - left.evidenceIds.length,
		)[0] ?? null
	);
}

/**
 * A sentence-shaped heading from one claim: `Entity: metric value unit`. Same
 * word order in both report languages — the value is what the reader is
 * scanning for, and it belongs at the end where the eye stops.
 */
export function atlasV3ClaimTitle(claim: AtlasV3Claim | null): string {
	if (!claim) return "";
	const body = `${claim.entity}: ${claim.metric} ${claim.value}${
		claim.unit ? ` ${claim.unit}` : ""
	}`;
	return clampAtlasV3Title(capitalise(body.replace(/\s+/g, " ").trim()));
}

/**
 * The outline when the model gives nothing usable: one node per distinct metric
 * in the memo's claims, ordered best-supported first, plus a lead node for the
 * core question. Thin, honest, and never a topic list.
 */
export function deterministicAtlasV3Outline(input: {
	ask: AtlasV3Ask;
	memo: AtlasV3Memo;
	bank: AtlasV3EvidenceBank;
	minSections: number;
	maxSections: number;
	minEvidencePerNode: number;
}): AtlasV3Outline {
	const claimsById = new Map(
		input.bank.claims.map((claim) => [claim.id, claim]),
	);
	const byMetric = new Map<string, string[]>();
	for (const claimId of input.memo.claimIds) {
		const claim = claimsById.get(claimId);
		if (!claim) continue;
		const key = `${claim.entity} — ${claim.metric}`;
		byMetric.set(key, [...(byMetric.get(key) ?? []), claimId]);
	}
	const parsed: ParsedAtlasV3OutlineNode[] = [...byMetric.entries()]
		.slice(0, input.maxSections)
		.map(([key, claimIds], position) => {
			// `entity — metric` is a database label, and eight of them opened one
			// staging report. The best-supported claim of the group states the
			// finding instead: "Commission: enforcement powers entry into
			// application 2 August 2026".
			const title = atlasV3ClaimTitle(
				bestSupportedClaim(claimIds.map((id) => claimsById.get(id))),
			);
			return {
				id: `n${position + 1}`,
				title: title || clampAtlasV3Title(key),
				claim: title || key,
				needs: [],
				claimIds,
			};
		});
	if (parsed.length === 0) {
		parsed.push({
			id: "n1",
			title: clampAtlasV3Title(input.ask.coreQuestion),
			claim: input.ask.coreQuestion.slice(0, MAX_CLAIM_CHARS),
			needs: input.memo.openQuestions.slice(0, MAX_NEEDS_PER_NODE),
			claimIds: input.memo.claimIds,
		});
	}
	return bindAtlasV3Evidence({
		nodes: parsed,
		bank: input.bank,
		minEvidencePerNode: input.minEvidencePerNode,
		mergeDuplicates: false,
	});
}

// ---------------------------------------------------------------------------
// Trial write: score a thin node before committing to it
// ---------------------------------------------------------------------------

export const ATLAS_V3_TRIAL_SYSTEM: Record<SupportedLanguage, string> = {
	en: [
		"You test whether a section can be written from the quotes shown. Return STRICT JSON only, no prose and no code fence.",
		'Shape: {"lead":"...","supportable":true}',
		"`lead` is the ONE sentence this section would open with, written only from the quotes. It must contain a figure, a date or a named position.",
		'Set "supportable" to false when the quotes cannot carry that sentence — when the lead would have to hedge, generalise, or say that the sources do not address the topic.',
		"Do not write the section. One sentence, then the verdict.",
	].join("\n"),
	hu: [
		"Azt vizsgálod, megírható-e egy szakasz a bemutatott idézetekből. KIZÁRÓLAG szigorú JSON-t adj vissza, próza és kódkerítés nélkül.",
		'Alak: {"lead":"...","supportable":true}',
		"A `lead` az az EGY mondat, amellyel a szakasz kezdődne, kizárólag az idézetekből. Legyen benne szám, dátum vagy megnevezett álláspont.",
		'A "supportable" akkor false, ha az idézetek nem bírják el ezt a mondatot — ha a nyitómondatnak mentegetőznie, általánosítania kellene, vagy azt kellene mondania, hogy a források nem foglalkoznak a témával.',
		"Ne írd meg a szakaszt. Egy mondat, aztán az ítélet.",
	].join("\n"),
};

export interface AtlasV3TrialResult {
	nodeId: string;
	lead: string;
	supportable: boolean;
}

export function parseAtlasV3Trial(
	text: string,
	nodeId: string,
): AtlasV3TrialResult | null {
	const parsed = parseJsonFromText(text);
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	const lead = clean(record.lead, 300);
	if (!lead) return null;
	// A lead with no figure, date or named position is exactly v2's hollow
	// opener, whatever the model says about supportability.
	const carriesSubstance = /\d/.test(lead);
	return {
		nodeId,
		lead,
		supportable: record.supportable === true && carriesSubstance,
	};
}

export interface TrialWriteAtlasV3NodesInput {
	outline: AtlasV3Outline;
	bank: AtlasV3EvidenceBank;
	language: SupportedLanguage;
	runModel: AtlasV3ModelCall;
	onUsage?: (usage: AtlasV3Usage) => void;
}

/**
 * Trial-writes every `thin` node and cuts the ones that cannot carry a lead.
 *
 * This is the cheapest possible version of ScaffoldAgent's trial-write step:
 * one sentence, one small call, per node the binding already flagged as thin.
 * A node that survives is promoted to `ready`; one that does not is cut with a
 * reason, and the reason reaches Limitations.
 */
export async function trialWriteAtlasV3Nodes(
	input: TrialWriteAtlasV3NodesInput,
): Promise<AtlasV3Outline> {
	const nodes: AtlasV3OutlineNode[] = [];
	const cut = [...input.outline.cut];
	for (const node of input.outline.nodes) {
		if (node.status !== "thin") {
			nodes.push(node);
			continue;
		}
		const quotes = input.bank.quotes.filter((quote) =>
			node.evidenceIds.includes(quote.id),
		);
		let trial: AtlasV3TrialResult | null = null;
		try {
			const call = await input.runModel({
				stage: `v3:trial:${node.id}`,
				thinkingMode: "off",
				maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.trialWrite,
				system: ATLAS_V3_TRIAL_SYSTEM[input.language],
				prompt: JSON.stringify({
					task: "trial_write",
					title: node.title,
					claim: node.claim,
					language: input.language,
					quotes: quotes.map((quote) => ({ id: quote.id, text: quote.text })),
				}),
			});
			input.onUsage?.(call.usage);
			trial = parseAtlasV3Trial(call.text, node.id);
		} catch {
			trial = null;
		}
		if (trial?.supportable) {
			nodes.push({ ...node, status: "ready" });
			continue;
		}
		cut.push({
			id: node.id,
			title: node.title,
			reason:
				"the evidence found could not support an opening claim for this section",
		});
	}
	return { nodes, cut };
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export interface ReviseAtlasV3OutlineInput
	extends BuildAtlasV3OutlinePromptInput {
	minEvidencePerNode: number;
	runModel: AtlasV3ModelCall;
	onUsage?: (usage: AtlasV3Usage) => void;
}

export async function reviseAtlasV3Outline(
	input: ReviseAtlasV3OutlineInput,
): Promise<AtlasV3Outline> {
	const fallback = () =>
		deterministicAtlasV3Outline({
			ask: input.ask,
			memo: input.memo,
			bank: input.bank,
			minSections: input.minSections,
			maxSections: input.maxSections,
			minEvidencePerNode: input.minEvidencePerNode,
		});
	let parsed: ReturnType<typeof parseAtlasV3Outline> = null;
	try {
		const call = await input.runModel({
			stage: `v3:outline:${input.round}`,
			thinkingMode: "off",
			maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.outline,
			system: ATLAS_V3_OUTLINE_SYSTEM[input.language],
			prompt: buildAtlasV3OutlinePrompt(input),
		});
		input.onUsage?.(call.usage);
		parsed = parseAtlasV3Outline(call.text, {
			knownClaimIds: input.bank.claims.map((claim) => claim.id),
			maxSections: input.maxSections,
		});
	} catch {
		parsed = null;
	}
	if (!parsed) return fallback();
	// A label-shaped title is a v2 defect with a name; it is repaired from the
	// node's own claim rather than sent back for another call.
	const nodes = parsed.nodes.map((node) => ({
		...node,
		title: isLabelShapedTitle(node.title)
			? clampAtlasV3Title(atlasV3FirstClause(node.claim))
			: node.title,
	}));
	const bound = bindAtlasV3Evidence({
		nodes,
		bank: input.bank,
		minEvidencePerNode: input.minEvidencePerNode,
	});
	// A `cut` id the model invented — often a CLAIM id, `c2` — has no title, and
	// the fallback published the raw id: "c2 — Redundant with c1" appeared in a
	// shipped Limitations list. A cut entry is only meaningful for a node that
	// existed.
	const knownNodeIds = new Set([
		...(input.previous?.nodes.map((node) => node.id) ?? []),
		...parsed.nodes.map((node) => node.id),
	]);
	const cutFromModel = parsed.cut
		.filter((entry) => knownNodeIds.has(entry.id))
		.map((entry) => ({
			id: entry.id,
			title:
				input.previous?.nodes.find((node) => node.id === entry.id)?.title ??
				parsed.nodes.find((node) => node.id === entry.id)?.title ??
				entry.id,
			reason: entry.reason,
		}));
	const outline: AtlasV3Outline = {
		nodes: bound.nodes,
		cut: [...bound.cut, ...cutFromModel],
	};
	// An outline with nothing left is not an outline; the deterministic one at
	// least names what the evidence actually holds. An outline whose every node
	// bound ZERO quotes is the same failure wearing titles: it is what the
	// staging run's thin-evidence query produced, and the writer then wrote
	// nothing and the job died.
	const anyEvidenceBound = outline.nodes.some(
		(node) => node.evidenceIds.length > 0,
	);
	if (outline.nodes.length > 0 && anyEvidenceBound) return outline;
	const deterministic = fallback();
	return deterministic.nodes.length > 0 ? deterministic : outline;
}

/** Node ids that still need evidence, with what they need. */
export function atlasV3OutlineGaps(outline: AtlasV3Outline): string[] {
	return outline.nodes
		.filter((node) => node.status !== "ready")
		.flatMap((node) => (node.needs.length > 0 ? node.needs : [node.claim]));
}
