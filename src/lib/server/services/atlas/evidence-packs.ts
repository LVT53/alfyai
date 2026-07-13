import { createHash } from "node:crypto";
import {
	ATLAS_EVIDENCE_PACK_SCHEMA_VERSION,
	type AtlasEvidencePack,
	type AtlasEvidencePackAuthority,
	type AtlasEvidencePackDiagnostic,
	type AtlasEvidencePackSourceKind,
	type AtlasEvidencePackSourceRef,
	type AtlasLifecycleSeed,
} from "./types";

export { ATLAS_EVIDENCE_PACK_SCHEMA_VERSION };

const EVIDENCE_PACK_VERSION_NOTE =
	"Built deterministically from accepted Atlas sources after curation; evidence excerpts are compacted and truncated for model-facing use.";

export interface BuildAtlasEvidencePacksInput {
	query: string;
	currentDate: string;
	curatedEvidence: string;
	localSources: Array<{
		id: string;
		title: string;
		authority: string;
		text: string;
	}>;
	webSources: Array<{
		id: string;
		title: string;
		url: string;
		snippet: string | null;
	}>;
	searchLimitation: { code: string; message: string } | null;
	parentSeed: AtlasLifecycleSeed | null;
}

export interface BuildAtlasEvidencePacksResult {
	version: typeof ATLAS_EVIDENCE_PACK_SCHEMA_VERSION;
	evidencePacks: AtlasEvidencePack[];
	diagnostics: AtlasEvidencePackDiagnostic[];
}

interface PendingEvidencePack {
	key: string;
	sourceKind: AtlasEvidencePackSourceKind;
	authority: AtlasEvidencePackAuthority;
	authorityRank: number;
	title: string;
	url: string | null;
	textFragments: string[];
	sourceRefs: AtlasEvidencePackSourceRef[];
	parentAtlasJobId: string | null;
}

export function buildAtlasEvidencePacks(
	input: BuildAtlasEvidencePacksInput,
): BuildAtlasEvidencePacksResult {
	const pending = new Map<string, PendingEvidencePack>();

	for (const source of input.localSources) {
		const text = normalizeEvidenceText(source.text);
		if (!text) continue;
		const authority = localAuthority(source);
		const isParentSeed = authority === "parent_seed";
		upsertPendingPack(pending, {
			key: `local:${source.id}`,
			sourceKind: "local",
			authority,
			authorityRank: authorityRank(authority),
			title: source.title,
			url: null,
			text,
			sourceRef: {
				id: source.id,
				title: source.title,
				kind: "local",
				url: null,
				authority,
			},
			parentAtlasJobId: isParentSeed
				? parentJobIdFromLocalSourceId(source.id)
				: null,
		});
	}

	for (const source of input.webSources) {
		const text = normalizeEvidenceText(
			source.snippet ||
				`${source.title}. Accepted web evidence: ${source.url}.`,
		);
		if (!text) continue;
		upsertPendingPack(pending, {
			key: `web:${normalizedUrlKey(source.url)}`,
			sourceKind: "web",
			authority: "accepted_web",
			authorityRank: authorityRank("accepted_web"),
			title: source.title,
			url: source.url,
			text,
			sourceRef: {
				id: source.id,
				title: source.title,
				kind: "web",
				url: source.url,
				authority: "accepted_web",
			},
			parentAtlasJobId: null,
		});
	}

	const parentSeedText = parentSeedEvidenceText(input.parentSeed);
	if (parentSeedText && input.parentSeed) {
		upsertPendingPack(pending, {
			key: `parent_seed:${input.parentSeed.parentAtlasJobId}:compressed-findings`,
			sourceKind: "local",
			authority: "parent_seed",
			authorityRank: authorityRank("parent_seed"),
			title: "Parent Atlas compressed findings",
			url: null,
			text: parentSeedText,
			sourceRef: {
				id: `parent:${input.parentSeed.parentAtlasJobId}:compressed-findings`,
				title: "Parent Atlas compressed findings",
				kind: "local",
				url: null,
				authority: "parent_seed",
			},
			parentAtlasJobId: input.parentSeed.parentAtlasJobId,
		});
	}

	const evidencePacks = Array.from(pending.values())
		.sort(
			(left, right) =>
				left.authorityRank - right.authorityRank ||
				left.key.localeCompare(right.key),
		)
		.map((pack) =>
			finalizeEvidencePack({
				pack,
				query: input.query,
				currentDate: input.currentDate,
				curatedEvidence: input.curatedEvidence,
			}),
		);

	const diagnostics: AtlasEvidencePackDiagnostic[] = [];
	if (evidencePacks.length === 0) {
		diagnostics.push({
			code: "atlas_evidence_packs_empty",
			severity: "warning",
			message:
				"No accepted Atlas sources or parent seed findings were available for Evidence Pack creation.",
		});
	}
	if (input.searchLimitation) {
		diagnostics.push({
			code: input.searchLimitation.code,
			severity: "warning",
			message: input.searchLimitation.message,
		});
	}

	return {
		version: ATLAS_EVIDENCE_PACK_SCHEMA_VERSION,
		evidencePacks,
		diagnostics,
	};
}

function upsertPendingPack(
	pending: Map<string, PendingEvidencePack>,
	input: {
		key: string;
		sourceKind: AtlasEvidencePackSourceKind;
		authority: AtlasEvidencePackAuthority;
		authorityRank: number;
		title: string;
		url: string | null;
		text: string;
		sourceRef: AtlasEvidencePackSourceRef;
		parentAtlasJobId: string | null;
	},
): void {
	const existing = pending.get(input.key);
	if (existing) {
		existing.textFragments.push(input.text);
		existing.sourceRefs.push(input.sourceRef);
		if (input.authorityRank < existing.authorityRank) {
			existing.authority = input.authority;
			existing.authorityRank = input.authorityRank;
		}
		return;
	}
	pending.set(input.key, {
		key: input.key,
		sourceKind: input.sourceKind,
		authority: input.authority,
		authorityRank: input.authorityRank,
		title: input.title,
		url: input.url,
		textFragments: [input.text],
		sourceRefs: [input.sourceRef],
		parentAtlasJobId: input.parentAtlasJobId,
	});
}

function finalizeEvidencePack(input: {
	pack: PendingEvidencePack;
	query: string;
	currentDate: string;
	curatedEvidence: string;
}): AtlasEvidencePack {
	const evidenceText = uniqueEvidenceFragments(input.pack.textFragments).join(
		" ",
	);
	const excerpt = selectEvidenceExcerpt(evidenceText);
	const summary = summarizeEvidence({
		title: input.pack.title,
		evidenceText,
		curatedEvidence: input.curatedEvidence,
	});
	const isParentSeed = input.pack.authority === "parent_seed";
	const asOfDate = extractAsOfDate(evidenceText);
	const limitations = inferLimitations({
		text: evidenceText,
		isParentSeed,
	});
	return {
		version: ATLAS_EVIDENCE_PACK_SCHEMA_VERSION,
		id: stableEvidencePackId(input.pack),
		sourceRefs: input.pack.sourceRefs,
		sourceKind: input.pack.sourceKind,
		authority: input.pack.authority,
		supportedFacets: deriveSupportedFacets({
			query: input.query,
			title: input.pack.title,
			text: evidenceText,
		}),
		supportedQuestions: input.query.trim() ? [input.query.trim()] : [],
		evidence: {
			summary,
			excerpt,
		},
		conflicts: inferConflicts(evidenceText),
		limitations,
		freshness: {
			asOfDate,
			retrievedAt: input.pack.sourceKind === "web" ? input.currentDate : null,
			isCurrentEvidence: !isParentSeed,
			parentAtlasJobId: input.pack.parentAtlasJobId,
			note: isParentSeed
				? "Parent seed evidence can guide revision but must not be treated as fresh current evidence."
				: null,
		},
		affectedSectionHint: inferAffectedSectionHint({
			query: input.query,
			text: evidenceText,
		}),
		versionNote: EVIDENCE_PACK_VERSION_NOTE,
	};
}

function localAuthority(source: {
	id: string;
	authority: string;
}): AtlasEvidencePackAuthority {
	if (source.id.startsWith("parent:")) return "parent_seed";
	if (source.authority === "explicit") return "explicit_local";
	if (source.authority === "working_document") return "working_document";
	return "automatic_local";
}

function authorityRank(authority: AtlasEvidencePackAuthority): number {
	switch (authority) {
		case "explicit_local":
			return 0;
		case "working_document":
			return 1;
		case "automatic_local":
			return 2;
		case "accepted_web":
			return 3;
		case "parent_seed":
			return 4;
	}
}

function parentJobIdFromLocalSourceId(id: string): string | null {
	const match = id.match(/^parent:([^:]+):/);
	return match?.[1] ?? null;
}

function parentSeedEvidenceText(seed: AtlasLifecycleSeed | null): string {
	if (!seed) return "";
	return normalizeEvidenceText(unknownText(seed.compressedFindings));
}

function unknownText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value.map(unknownText).filter(Boolean).join(" ");
	}
	if (value && typeof value === "object") {
		return Object.values(value as Record<string, unknown>)
			.map(unknownText)
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

const SEARCH_ENGINE_ARTIFACT_PATTERNS: RegExp[] = [
	/\b(?:Naptár|Keresés|Beállítások)\s*·\s*/gu,
	/Nem tartalmazza:[^|]*\|\s*Tartalmaznia kell:[^|]*\|\s*/gi,
	/Nem tartalmazza:[^|]*\|\s*/gi,
	/Tartalmaznia kell:[^|]*\|\s*/gi,
	/Excluding:[^|]*\|\s*Must include:[^|]*\|\s*/gi,
	/Excluding:[^|]*\|\s*/gi,
	/Must include:[^|]*\|\s*/gi,
	/\bYouTube ·\s*/gu,
	/\b\d{4}\. (?:jan\.|febr\.|márc\.|ápr\.|máj\.|jún\.|júl\.|aug\.|szept\.|okt\.|nov\.|dec\.|január|február|március|április|május|június|július|augusztus|szeptember|október|november|december) \d{1,2}\. ·\s*/gu,
];

const YOUTUBE_FOOTER_PATTERNS: RegExp[] = [
	// English YouTube footer — uniquely identifiable multi-word phrases only
	/\bPolicy\s*&\s*Safety\b/gi,
	/How\s+YouTube\s+works/gi,
	/Test\s+new\s+features/gi,
	// Hungarian YouTube footer — uniquely UI words
	/Ismertető/giu,
	/Sajtó/giu,
	/Szerzői\s+jog/giu,
	/Kapcsolatfelvétel/giu,
	/Alkotók/giu,
	/Hirdetés/giu,
	/Fejlesztők/giu,
	/Feltételek/giu,
	/Adatvédelem/giu,
	/Irányelvek/giu,
	/YouTube\s+működése/giu,
	/Új\s+funkciók\s+tesztelése/giu,
];

const EVIDENCE_BOILERPLATE_PATTERNS: RegExp[] = [
	/\b(?:cookie|cookies|subscribe|sign in|privacy policy|advertisement|loading|navigation menu|copied from the fetched page)\b/i,
	/\bNem tartalmazza\b/i,
	/\bTartalmaznia kell\b/i,
	/\bKeresés\b/iu,
	/\bBeállítások\b/iu,
	/\bNaptár\b/iu,
	/\bExcluding:\s*/i,
	/\bMust include:\s*/i,
	/\bGoogle LLC\b/i,
	/©\s*\d{4}\s*Google\b/i,
	/\bIsmertető\b/iu,
	/\bSajtó\b/iu,
	/\bSzerzői\s+jog\b/iu,
	/\bKapcsolatfelvétel\b/iu,
	/\bAlkotók\b/iu,
	/\bHirdetés\b/iu,
	/\bFejlesztők\b/iu,
	/\bFeltételek\b/iu,
	/\bAdatvédelem\b/iu,
	/\bIrányelvek\b/iu,
	/\bYouTube\s+működése\b/iu,
	/\bÚj\s+funkciók\s+tesztelése\b/iu,
	/\bAbout\s+(?:Press|Copyright|Contact us|Creators|Advertise|Developers|Terms|Privacy)\b/i,
	/\bHow\s+YouTube\s+works\b/i,
	/\bTest\s+new\s+features\b/i,
];

export function normalizeEvidenceText(text: string): string {
	let result = text
		.replace(/\bSearch result snippet:\s*/gi, "")
		.replace(/\bFetched page excerpt:\s*/gi, "")
		.replace(/\bAccepted source excerpt:\s*/gi, "");
	for (const pattern of SEARCH_ENGINE_ARTIFACT_PATTERNS) {
		result = result.replace(pattern, "");
	}
	for (const pattern of YOUTUBE_FOOTER_PATTERNS) {
		result = result.replace(pattern, "");
	}
	return result.replace(/\s+/g, " ").trim();
}

function isBoilerplateSentence(sentence: string): boolean {
	for (const pattern of EVIDENCE_BOILERPLATE_PATTERNS) {
		if (pattern.test(sentence)) return true;
	}
	return false;
}

function uniqueEvidenceFragments(fragments: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const fragment of fragments) {
		const key = fragment.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(fragment);
	}
	return unique;
}

function selectEvidenceExcerpt(text: string): string {
	const sentences = splitSentences(text)
		.filter((sentence) => sentence.length >= 20)
		.slice(0, 3);
	const excerpt = sentences.length > 0 ? sentences.join(" ") : text;
	return truncateText(excerpt, 760);
}

function summarizeEvidence(input: {
	title: string;
	evidenceText: string;
	curatedEvidence: string;
}): string {
	const curated = normalizeEvidenceText(input.curatedEvidence);
	const preferred = input.evidenceText || curated;
	const sentences = splitSentences(preferred).filter(
		(s) => !isBoilerplateSentence(s),
	);
	if (sentences.length === 0) {
		return truncateText(`Accepted evidence from "${input.title}".`, 360);
	}
	const excerpt = selectEvidenceExcerpt(sentences.join(" "));
	return truncateText(
		excerpt || `Accepted evidence from "${input.title}".`,
		360,
	);
}

function splitSentences(text: string): string[] {
	const sentences = text
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	return sentences.length > 0 ? sentences : [text.trim()].filter(Boolean);
}

function truncateText(text: string, maxLength: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxLength) return ensureTerminalPunctuation(trimmed);
	const truncated = trimmed
		.slice(0, maxLength)
		.replace(/\s+\S*$/, "")
		.trim();
	return ensureTerminalPunctuation(`${truncated}...`);
}

function ensureTerminalPunctuation(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function stableEvidencePackId(pack: PendingEvidencePack): string {
	const hash = createHash("sha256")
		.update(
			JSON.stringify({
				version: ATLAS_EVIDENCE_PACK_SCHEMA_VERSION,
				key: pack.key,
				kind: pack.sourceKind,
				authority: pack.authority,
			}),
		)
		.digest("base64url")
		.slice(0, 16);
	return `atlas-pack-v1-${hash}`;
}

function normalizedUrlKey(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		parsed.searchParams.sort();
		return parsed.toString().replace(/\/+$/, "").toLowerCase();
	} catch {
		return url.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
	}
}

function extractAsOfDate(text: string): string | null {
	return text.match(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/)?.[0] ?? null;
}

function inferConflicts(text: string): string[] {
	if (
		!/\b(conflict|conflicting|contradict|contradiction|disputed|mixed)\b/i.test(
			text,
		)
	) {
		return [];
	}
	return [truncateText(selectEvidenceExcerpt(text), 220)];
}

function inferLimitations(input: {
	text: string;
	isParentSeed: boolean;
}): string[] {
	const limitations: string[] = [];
	if (input.isParentSeed) {
		limitations.push(
			"Parent Atlas seed evidence is context, not fresh current evidence.",
		);
	}
	if (
		/\b(limited|limitation|uncertain|stale|outdated|representative|not exhaustive)\b/i.test(
			input.text,
		)
	) {
		limitations.push(truncateText(selectEvidenceExcerpt(input.text), 220));
	}
	return limitations;
}

function inferAffectedSectionHint(input: {
	query: string;
	text: string;
}): string | null {
	const haystack = `${input.query} ${input.text}`;
	if (
		/\b(limitation|risk|constraint|uncertain|stale|outdated)\b/i.test(haystack)
	) {
		return "Limitations";
	}
	if (/\b(recommend|should|roadmap|implementation)\b/i.test(haystack)) {
		return "Recommendations";
	}
	if (
		/\b(compare|versus|tradeoff|architecture|retrieval|evidence|finding)\b/i.test(
			haystack,
		)
	) {
		return "Findings";
	}
	return null;
}

function deriveSupportedFacets(input: {
	query: string;
	title: string;
	text: string;
}): string[] {
	const candidates = [
		input.title,
		...keywordFacets(input.query),
		...keywordFacets(input.text).slice(0, 3),
	]
		.map((facet) => facet.replace(/\s+/g, " ").trim())
		.filter((facet) => facet.length >= 4);
	const seen = new Set<string>();
	const facets: string[] = [];
	for (const candidate of candidates) {
		const key = candidate.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		facets.push(candidate);
		if (facets.length >= 6) break;
	}
	return facets.length > 0 ? facets : ["accepted evidence"];
}

function keywordFacets(text: string): string[] {
	const stopwords = new Set([
		"about",
		"accepted",
		"after",
		"compare",
		"current",
		"evidence",
		"from",
		"into",
		"that",
		"their",
		"this",
		"with",
	]);
	return text
		.split(/[^\p{L}\p{N}]+/u)
		.map((token) => token.trim())
		.filter((token) => token.length >= 5)
		.filter((token) => !stopwords.has(token.toLowerCase()))
		.slice(0, 8);
}
