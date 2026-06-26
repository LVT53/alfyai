import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupportedLanguage } from "$lib/server/services/language";
import { parseJsonFromText } from "./json-extract";
import {
	ATLAS_CLAIM_BASIS_SCHEMA_VERSION,
	ATLAS_CLAIM_SUPPORT_LEVELS,
	type AtlasClaimBasis,
	type AtlasClaimBasisDiagnostic,
	type AtlasClaimBasisLimitation,
	type AtlasClaimBasisResult,
	type AtlasClaimBasisSectionCoverage,
	type AtlasClaimLocator,
	type AtlasClaimSupportLevel,
	type AtlasCoverageReview,
	type AtlasEvidencePack,
	type AtlasEvidencePackDiagnostic,
	type AtlasEvidencePackSourceRef,
	type AtlasHonestyMarker,
	type AtlasSectionBrief,
	type AtlasWriterClaimBasisEntry,
} from "./types";

export { ATLAS_CLAIM_BASIS_SCHEMA_VERSION, ATLAS_CLAIM_SUPPORT_LEVELS };

const MAX_RATIONALE_LENGTH = 280;
const MAX_CLAIM_TEXT_LENGTH = 360;
const MAX_FALLBACK_SECTION_BASIS = 24;
const MAX_FALLBACK_SOURCE_REFS = 8;
const SOURCE_AUTHORITIES = [
	"explicit_local",
	"working_document",
	"automatic_local",
	"accepted_web",
	"parent_seed",
] as const;

const rawLocatorSchema = z.object({
	sectionTitle: z.string().trim().min(1).nullable().optional(),
	paragraphIndex: z.number().int().nonnegative().nullable().optional(),
	claimIndex: z.number().int().nonnegative().nullable().optional(),
	claimText: z.string().trim().min(1).optional(),
	quote: z.string().trim().min(1).nullable().optional(),
	startOffset: z.number().int().nonnegative().nullable().optional(),
	endOffset: z.number().int().nonnegative().nullable().optional(),
});

const rawSourceRefSchema = z.object({
	id: z.string().trim().min(1),
	kind: z.enum(["web", "local"]).optional(),
	title: z.string().trim().min(1).optional(),
	url: z.string().trim().nullable().optional(),
	authority: z.enum(SOURCE_AUTHORITIES).optional(),
});

const rawClaimBasisSchema = z.object({
	locator: rawLocatorSchema,
	supportLevel: z.enum(ATLAS_CLAIM_SUPPORT_LEVELS),
	evidencePackIds: z.array(z.string().trim().min(1)).optional(),
	sourceRefs: z.array(rawSourceRefSchema).optional(),
	supportRationale: z.string().trim().min(1),
	auditConcernCode: z.string().trim().min(1).nullable().optional(),
});

const rawLimitationSchema = z.object({
	code: z.string().trim().min(1),
	message: z.string().trim().min(1),
	basisIds: z.array(z.string().trim().min(1)).optional(),
	sectionTitle: z.string().trim().min(1).nullable().optional(),
});

const rawDiagnosticSchema = z.object({
	code: z.string().trim().min(1),
	severity: z.enum(["info", "warning"]).optional(),
	message: z.string().trim().min(1),
	sectionTitle: z.string().trim().min(1).nullable().optional(),
	basisId: z.string().trim().min(1).optional(),
});

export interface BuildAtlasClaimBasisPromptInput {
	language: SupportedLanguage;
	currentDate: string;
	assembledMarkdown: string;
	evidencePacks: AtlasEvidencePack[];
	evidencePackDiagnostics: AtlasEvidencePackDiagnostic[];
	sectionBriefs: AtlasSectionBrief[];
	sources: Array<{ title: string; url?: string | null }>;
	limitation?: { code: string; message: string } | null;
	coverageReview?: AtlasCoverageReview | null;
	maxChars?: number;
}

export interface ParseAtlasClaimBasisModelResultInput {
	modelText: string;
	evidencePacks: AtlasEvidencePack[];
	sectionBriefs: AtlasSectionBrief[];
	assembledMarkdown?: string;
}

export interface GenerateAtlasClaimBasisInput
	extends BuildAtlasClaimBasisPromptInput {
	runAuditModel: (prompt: string) => Promise<{
		text: string;
		usage?: unknown;
		warning?: string | null;
	}>;
}

export interface GenerateAtlasClaimBasisResult extends AtlasClaimBasisResult {
	usage?: unknown;
	warning?: string | null;
}

export function compactEvidencePacks(packs: AtlasEvidencePack[]): Array<{
	id: string;
	evidence: { summary: string };
	sourceRefs: Array<{
		id: string;
		title: string;
		url: string | null;
		authority: AtlasEvidencePackSourceRef["authority"];
	}>;
	authority: AtlasEvidencePack["authority"];
	limitations: string[];
	conflicts: string[];
	affectedSectionHint: string | null;
	freshness: { isCurrentEvidence: boolean };
}> {
	return packs.map((pack) => ({
		id: pack.id,
		evidence: { summary: pack.evidence.summary },
		sourceRefs: pack.sourceRefs.map((ref) => ({
			id: ref.id,
			title: ref.title,
			url: ref.url,
			authority: ref.authority,
		})),
		authority: pack.authority,
		limitations: pack.limitations.slice(0, 2),
		conflicts: pack.conflicts.slice(0, 2),
		affectedSectionHint: pack.affectedSectionHint,
		freshness: { isCurrentEvidence: pack.freshness.isCurrentEvidence },
	}));
}

export function compactSectionBriefs(briefs: AtlasSectionBrief[]): Array<{
	sectionTitle: string;
	brief: string;
	evidencePackIds: string[];
	sourceAssociations: Array<{ id: string; title: string | null }>;
}> {
	return briefs.map((brief) => ({
		sectionTitle: brief.sectionTitle,
		brief:
			brief.brief.length <= 200
				? brief.brief
				: `${brief.brief.slice(0, 200).trim()}...`,
		evidencePackIds: brief.evidencePackIds.slice(0, 8),
		sourceAssociations: brief.sourceAssociations
			.slice(0, 5)
			.map((sa) => ({ id: sa.sourceId, title: sa.sourceTitle })),
	}));
}

export function compactCoverageReview(
	review: AtlasCoverageReview | null | undefined,
): {
	sufficient: boolean;
	approvedGapCandidateCount: number;
	limitations: Array<{ code: string; message: string }>;
} | null {
	if (!review) return null;
	return {
		sufficient: review.sufficient,
		approvedGapCandidateCount: review.approvedGapCandidates.length,
		limitations: review.limitations.slice(0, 3).map((l) => ({
			code: l.code,
			message: l.message,
		})),
	};
}

export function compactSources(
	sources: Array<{ title: string; url?: string | null }>,
): Array<{ title: string; url: string | null }> {
	return sources.map((s) => ({ title: s.title, url: s.url ?? null }));
}

function trimReport(report: string, maxChars?: number): string {
	const limit = maxChars ?? 8000;
	if (report.length <= limit) return report;
	return `${report.slice(0, limit).trim()}\n\n(report truncated for audit context budget)`;
}

export function buildAtlasClaimBasisPrompt(
	input: BuildAtlasClaimBasisPromptInput,
): string {
	const languageParityCheck =
		input.language === "hu"
			? "Hungarian Parity Check: flag English slippage in generated headings, summaries, limitations, or body text unless it is an original source title, quoted source text, product name, or citation."
			: "Flag language drift away from English except original source titles, quoted source text, product names, or citations.";
	return JSON.stringify({
		task: "Generate Atlas Claim Basis audit data for factual claims in the report. Return strict JSON only.",
		expectedLanguage: input.language,
		languageParityCheck,
		currentDate: input.currentDate,
		instructions: [
			"Use only accepted Evidence Packs, source refs, section briefs, and explicit limitations as support.",
			"Support level must be exactly supported, partial, or unsupported.",
			"Use 'supported' when an accepted source directly states or clearly implies the claim. One credible source is sufficient — independent verification or multiple sources are not required for 'supported'.",
			"Use 'partial' only when evidence is indirect, partially relevant, or when the claim extrapolates beyond what sources state. Do not mark as 'partial' merely because evidence is from a single source or is not independently verified.",
			"Use 'unsupported' for hallucinated facts, invented logical links, or claims with no evidence at all.",
			"Thin or brief evidence is still 'supported' if it directly states the claim. Stale evidence is 'partial' only if the claim depends on timeliness.",
			"Contested or contradictory evidence is 'partial' only when sources disagree on the specific claim, not when sources discuss related but different aspects.",
			"Adjacent claims may share one Claim Basis only when both evidence and rationale match.",
			"A paragraph with distinct factual claims can receive multiple Claim Basis objects.",
			"Use quote plus startOffset and endOffset when an important fact appears mid-sentence.",
			'Write a reader-friendly supportRationale sentence that references specific source titles when possible (e.g., "Source X demonstrates this claim is verified" or "Source X confirms the general direction but precise data is lacking"). Keep it compact for end-user display.',
			"Do not include hidden chain-of-thought or model-certainty scores.",
			"If Claim Basis generation is not possible, return an empty claimBasis array plus diagnostics and limitations; do not invent support data.",
			"Do not generate Claim Basis entries for the Executive Summary section — it is descriptive, not a factual claim section.",
		],
		expectedJsonShape: {
			retryRequested: "boolean",
			supportLevel: "supported | partial | unsupported",
			claimBasis: "array",
			claim: {
				locator: {
					sectionTitle: "string | null",
					paragraphIndex: "number | null",
					claimIndex: "number | null",
					claimText: "string",
					quote: "string | null",
					startOffset: "number | null",
					endOffset: "number | null",
				},
				supportLevel: "supported | partial | unsupported",
				evidencePackIds: "string[]",
				sourceRefs:
					"accepted source refs, optional when evidencePackIds can hydrate them",
				supportRationale: "compact string",
				auditConcernCode: "string | null",
			},
			limitations: "array of { code, message, basisIds, sectionTitle }",
			diagnostics:
				"array of { code, severity, message, sectionTitle, basisId }",
		},
		report: trimReport(input.assembledMarkdown, input.maxChars),
		evidencePacks: compactEvidencePacks(input.evidencePacks),
		evidencePackDiagnostics: input.evidencePackDiagnostics,
		sectionBriefs: compactSectionBriefs(input.sectionBriefs),
		coverageReview: compactCoverageReview(input.coverageReview),
		sources: compactSources(input.sources),
		limitation: input.limitation ?? null,
	});
}

export function parseAtlasClaimBasisModelResult(
	input: ParseAtlasClaimBasisModelResultInput,
): AtlasClaimBasisResult {
	const parsed = parseJsonObject(input.modelText);
	if (!parsed) {
		return failedOrFallbackResult({
			code: "atlas_claim_basis_invalid_json",
			message:
				"Claim Basis generation did not return parseable strict JSON, so Atlas did not create fine-grained support data.",
			evidencePacks: input.evidencePacks,
			sectionBriefs: input.sectionBriefs,
			assembledMarkdown: input.assembledMarkdown,
		});
	}

	const rawClaimBasis = claimBasisArray(parsed);
	if (!rawClaimBasis) {
		return failedOrFallbackResult({
			code: "atlas_claim_basis_missing_array",
			message:
				"Claim Basis generation did not include a claimBasis array, so Atlas did not create fine-grained support data.",
			evidencePacks: input.evidencePacks,
			sectionBriefs: input.sectionBriefs,
			assembledMarkdown: input.assembledMarkdown,
		});
	}

	const diagnostics: AtlasClaimBasisDiagnostic[] = [];
	const evidencePacksById = new Map(
		input.evidencePacks.map((pack) => [pack.id, pack]),
	);
	const claimBasis: AtlasClaimBasis[] = [];
	const seenIds = new Set<string>();

	for (const [index, rawBasis] of rawClaimBasis.entries()) {
		const candidate = normalizeRawClaimBasisCandidate(rawBasis);
		const parsedBasis = rawClaimBasisSchema.safeParse(candidate);
		if (!parsedBasis.success) {
			diagnostics.push({
				code: "atlas_claim_basis_invalid_entry",
				severity: "warning",
				message: `Claim Basis entry ${index + 1} did not match the required schema.`,
			});
			continue;
		}
		const normalized = normalizeClaimBasis({
			raw: parsedBasis.data,
			evidencePacksById,
		});
		if (seenIds.has(normalized.id)) continue;
		seenIds.add(normalized.id);
		claimBasis.push(normalized);
	}

	const explicitLimitations = parseLimitations(parsed.limitations);
	const derivedLimitations = deriveBasisLimitations(claimBasis);
	const limitations = mergeLimitations([
		...explicitLimitations,
		...derivedLimitations,
	]);
	const parsedDiagnostics = parseDiagnostics(parsed.diagnostics);
	diagnostics.push(...parsedDiagnostics);
	if (claimBasis.length === 0) {
		const fallback = failedOrFallbackResult({
			code: "atlas_claim_basis_empty",
			message:
				"Claim Basis generation returned no usable claim support entries.",
			evidencePacks: input.evidencePacks,
			sectionBriefs: input.sectionBriefs,
			assembledMarkdown: input.assembledMarkdown,
		});
		fallback.diagnostics.unshift(...diagnostics);
		fallback.limitations.unshift(...explicitLimitations);
		return fallback;
	}

	const retryRequested =
		parsed.retryRequested === true || claimBasis.some(shouldRetryUnsupported);
	const coverageBySection = buildCoverageBySection({
		claimBasis,
		sectionBriefs: input.sectionBriefs,
	});
	return {
		version: ATLAS_CLAIM_BASIS_SCHEMA_VERSION,
		claimBasis,
		limitations,
		diagnostics,
		coverageBySection,
		status: claimBasis.length > 0 ? "succeeded" : "failed",
		failureReason:
			claimBasis.length > 0
				? null
				: "Claim Basis generation returned no usable claim support entries.",
		retryRequested,
	};
}

export async function generateAtlasClaimBasis(
	input: GenerateAtlasClaimBasisInput,
): Promise<GenerateAtlasClaimBasisResult> {
	const audit = await input.runAuditModel(buildAtlasClaimBasisPrompt(input));
	const parsed = parseAtlasClaimBasisModelResult({
		modelText: audit.text,
		evidencePacks: input.evidencePacks,
		sectionBriefs: input.sectionBriefs,
		assembledMarkdown: input.assembledMarkdown,
	});
	return {
		...parsed,
		usage: audit.usage,
		warning: audit.warning ?? null,
	};
}

export function atlasClaimBasisToLegacyHonestyMarkers(input: {
	claimBasis: AtlasClaimBasis[];
	limitations?: AtlasClaimBasisLimitation[];
}): AtlasHonestyMarker[] {
	const markers: AtlasHonestyMarker[] = [];
	const seen = new Set<string>();
	for (const limitation of input.limitations ?? []) {
		pushMarker(markers, seen, {
			code: limitation.code,
			message: limitation.message,
			severity: "warning",
		});
	}
	for (const basis of input.claimBasis) {
		if (basis.supportLevel === "supported") continue;
		pushMarker(markers, seen, {
			code: basis.auditConcernCode ?? `atlas_claim_${basis.supportLevel}`,
			message: legacyMarkerMessage(basis),
			severity:
				basis.supportLevel === "unsupported" && !isLimitationLocator(basis)
					? "critical"
					: "warning",
		});
	}
	return markers;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
	const parsed = parseJsonFromText(text);
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}
	if (Array.isArray(parsed)) return { claimBasis: parsed };
	return null;
}

function claimBasisArray(parsed: Record<string, unknown>): unknown[] | null {
	if (Array.isArray(parsed.claimBasis)) return parsed.claimBasis;
	if (Array.isArray(parsed.claims)) return parsed.claims;
	if (Array.isArray(parsed.bases)) return parsed.bases;
	return null;
}

function normalizeRawClaimBasisCandidate(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const record = value as Record<string, unknown>;
	const locator =
		record.locator && typeof record.locator === "object"
			? record.locator
			: {
					sectionTitle: record.sectionTitle,
					paragraphIndex: record.paragraphIndex,
					claimIndex: record.claimIndex,
					claimText: record.claimText ?? record.claim,
					quote: record.quote,
					startOffset: record.startOffset,
					endOffset: record.endOffset,
				};
	return {
		locator,
		supportLevel:
			record.supportLevel ??
			record.support_level ??
			record.level ??
			record.state,
		evidencePackIds:
			record.evidencePackIds ?? record.evidencePacks ?? record.packIds,
		sourceRefs: record.sourceRefs ?? record.sources,
		supportRationale:
			record.supportRationale ?? record.rationale ?? record.reasoning,
		auditConcernCode: record.auditConcernCode ?? record.concernCode ?? null,
	};
}

function normalizeClaimBasis(input: {
	raw: z.infer<typeof rawClaimBasisSchema>;
	evidencePacksById: Map<string, AtlasEvidencePack>;
}): AtlasClaimBasis {
	const evidencePackIds = uniqueStrings(input.raw.evidencePackIds ?? []).slice(
		0,
		12,
	);
	const citedPacks = evidencePackIds
		.map((id) => input.evidencePacksById.get(id))
		.filter((pack): pack is AtlasEvidencePack => Boolean(pack));
	const sourceRefs = mergeSourceRefs([
		...citedPacks.flatMap((pack) => pack.sourceRefs),
		...(input.raw.sourceRefs ?? []).map(normalizeSourceRef),
	]);
	const auditConcernCode = normalizeCode(input.raw.auditConcernCode);
	const locator = normalizeLocator(input.raw.locator);
	const supportRationale = compactText(
		input.raw.supportRationale,
		MAX_RATIONALE_LENGTH,
	);
	const supportLevel = normalizeSupportLevel({
		declared: input.raw.supportLevel,
		auditConcernCode,
		citedPacks,
		sourceRefs,
	});
	const stableSeed = {
		version: ATLAS_CLAIM_BASIS_SCHEMA_VERSION,
		locator,
		supportLevel,
		evidencePackIds,
		sourceRefs: sourceRefs.map((ref) => ({
			id: ref.id,
			kind: ref.kind,
			url: ref.url,
		})),
		supportRationale,
		auditConcernCode,
	};
	return {
		version: ATLAS_CLAIM_BASIS_SCHEMA_VERSION,
		id: stableClaimBasisId(stableSeed),
		locator,
		supportLevel,
		evidencePackIds,
		sourceRefs,
		supportRationale,
		auditConcernCode,
	};
}

function normalizeLocator(
	raw: z.infer<typeof rawLocatorSchema>,
): AtlasClaimLocator {
	const claimText =
		compactText(
			raw.claimText ?? raw.quote ?? "Unspecified factual claim",
			MAX_CLAIM_TEXT_LENGTH,
		) || "Unspecified factual claim";
	const startOffset = integerOrNull(raw.startOffset);
	const endOffset = integerOrNull(raw.endOffset);
	const validOffsets =
		startOffset !== null && endOffset !== null && endOffset >= startOffset;
	return {
		sectionTitle: normalizeText(raw.sectionTitle) ?? null,
		paragraphIndex: integerOrNull(raw.paragraphIndex),
		claimIndex: integerOrNull(raw.claimIndex),
		claimText,
		quote: normalizeText(raw.quote) ?? null,
		startOffset: validOffsets ? startOffset : null,
		endOffset: validOffsets ? endOffset : null,
	};
}

function normalizeSourceRef(
	raw: z.infer<typeof rawSourceRefSchema>,
): AtlasEvidencePackSourceRef {
	const kind = raw.kind ?? "web";
	return {
		id: raw.id,
		kind,
		title: raw.title ?? raw.id,
		url: raw.url ?? null,
		authority:
			raw.authority ?? (kind === "web" ? "accepted_web" : "automatic_local"),
	};
}

function mergeSourceRefs(
	sourceRefs: AtlasEvidencePackSourceRef[],
): AtlasEvidencePackSourceRef[] {
	const merged: AtlasEvidencePackSourceRef[] = [];
	const seen = new Set<string>();
	for (const sourceRef of sourceRefs) {
		const key = `${sourceRef.kind}:${sourceRef.id}:${sourceRef.url ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(sourceRef);
	}
	return merged.slice(0, 12);
}

function normalizeSupportLevel(input: {
	declared: AtlasClaimSupportLevel;
	auditConcernCode: string | null;
	citedPacks: AtlasEvidencePack[];
	sourceRefs: AtlasEvidencePackSourceRef[];
}): AtlasClaimSupportLevel {
	if (input.auditConcernCode && isUnsupportedConcern(input.auditConcernCode)) {
		return "unsupported";
	}
	if (input.citedPacks.length === 0 && input.sourceRefs.length === 0) {
		return "unsupported";
	}
	if (input.declared === "unsupported") return "unsupported";
	if (input.auditConcernCode && isPartialConcern(input.auditConcernCode)) {
		return "partial";
	}
	if (
		input.declared === "supported" &&
		input.citedPacks.some((pack) => pack.conflicts.length > 0)
	) {
		return "partial";
	}
	return input.declared;
}

function parseLimitations(value: unknown): AtlasClaimBasisLimitation[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry): AtlasClaimBasisLimitation[] => {
		const parsed = rawLimitationSchema.safeParse(entry);
		if (!parsed.success) return [];
		return [
			{
				code: normalizeCode(parsed.data.code) ?? "atlas_basis_limitation",
				message: compactText(parsed.data.message, MAX_RATIONALE_LENGTH),
				basisIds: uniqueStrings(parsed.data.basisIds ?? []),
				sectionTitle: normalizeText(parsed.data.sectionTitle) ?? null,
			},
		];
	});
}

function parseDiagnostics(value: unknown): AtlasClaimBasisDiagnostic[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry): AtlasClaimBasisDiagnostic[] => {
		const parsed = rawDiagnosticSchema.safeParse(entry);
		if (!parsed.success) return [];
		return [
			{
				code: normalizeCode(parsed.data.code) ?? "atlas_claim_basis_diagnostic",
				severity: parsed.data.severity ?? "warning",
				message: compactText(parsed.data.message, MAX_RATIONALE_LENGTH),
				sectionTitle: normalizeText(parsed.data.sectionTitle) ?? null,
				basisId: normalizeText(parsed.data.basisId) ?? undefined,
			},
		];
	});
}

function deriveBasisLimitations(
	claimBasis: AtlasClaimBasis[],
): AtlasClaimBasisLimitation[] {
	return claimBasis
		.filter((basis) => basis.supportLevel !== "supported")
		.filter((basis) => basis.auditConcernCode)
		.map((basis) => ({
			code: basis.auditConcernCode ?? "atlas_basis_limitation",
			message: `${basis.locator.sectionTitle ?? "Atlas report"}: ${basis.supportRationale}`,
			basisIds: [basis.id],
			sectionTitle: basis.locator.sectionTitle,
		}));
}

function mergeLimitations(
	limitations: AtlasClaimBasisLimitation[],
): AtlasClaimBasisLimitation[] {
	const merged: AtlasClaimBasisLimitation[] = [];
	const seen = new Set<string>();
	for (const limitation of limitations) {
		const key = `${limitation.code}:${limitation.message}:${limitation.sectionTitle ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(limitation);
	}
	return merged.slice(0, 24);
}

function buildCoverageBySection(input: {
	claimBasis: AtlasClaimBasis[];
	sectionBriefs: AtlasSectionBrief[];
}): AtlasClaimBasisSectionCoverage[] {
	const sectionTitles = uniqueStrings([
		...input.sectionBriefs.map((brief) => brief.sectionTitle),
		...input.claimBasis.map(
			(basis) => basis.locator.sectionTitle ?? "Unsectioned claims",
		),
	]);
	return sectionTitles.map((sectionTitle) => {
		const bases = input.claimBasis.filter(
			(basis) =>
				(basis.locator.sectionTitle ?? "Unsectioned claims") === sectionTitle,
		);
		const supportedCount = bases.filter(
			(basis) => basis.supportLevel === "supported",
		).length;
		const partialCount = bases.filter(
			(basis) => basis.supportLevel === "partial",
		).length;
		const unsupportedCount = bases.filter(
			(basis) => basis.supportLevel === "unsupported",
		).length;
		const factualClaimCount = bases.length;
		return {
			sectionTitle,
			factualClaimCount,
			basisCount: bases.length,
			supportedCount,
			partialCount,
			unsupportedCount,
			density:
				factualClaimCount === 0
					? 0
					: Number((bases.length / factualClaimCount).toFixed(3)),
		};
	});
}

function failedResult(input: {
	code: string;
	message: string;
	sectionBriefs: AtlasSectionBrief[];
}): AtlasClaimBasisResult {
	return {
		version: ATLAS_CLAIM_BASIS_SCHEMA_VERSION,
		claimBasis: [],
		limitations: [],
		diagnostics: [
			{
				code: input.code,
				severity: "warning",
				message: input.message,
			},
		],
		coverageBySection: buildCoverageBySection({
			claimBasis: [],
			sectionBriefs: input.sectionBriefs,
		}),
		status: "failed",
		failureReason: input.message,
		retryRequested: false,
	};
}

function failedOrFallbackResult(input: {
	code: string;
	message: string;
	evidencePacks: AtlasEvidencePack[];
	sectionBriefs: AtlasSectionBrief[];
	assembledMarkdown?: string;
}): AtlasClaimBasisResult {
	const claimBasis = fallbackSectionClaimBasis(input);
	if (claimBasis.length === 0) {
		return failedResult({
			code: input.code,
			message: input.message,
			sectionBriefs: input.sectionBriefs,
		});
	}
	return {
		version: ATLAS_CLAIM_BASIS_SCHEMA_VERSION,
		claimBasis,
		limitations: [
			{
				code: "atlas_claim_basis_section_fallback",
				message:
					"Fine-grained Claim Basis generation was unavailable; Basis Markers show evidence coverage rather than claim-by-claim verification.",
				basisIds: claimBasis.map((basis) => basis.id),
				sectionTitle: null,
			},
		],
		diagnostics: [
			{
				code: input.code,
				severity: "warning",
				message: input.message,
			},
			{
				code: "atlas_claim_basis_section_fallback",
				severity: "warning",
				message:
					"Atlas created partial paragraph-level Basis Markers from accepted Evidence Packs because fine-grained Claim Basis JSON was unavailable.",
			},
		],
		coverageBySection: buildCoverageBySection({
			claimBasis,
			sectionBriefs: input.sectionBriefs,
		}),
		status: "succeeded",
		failureReason: null,
		retryRequested: false,
	};
}

function fallbackSectionClaimBasis(input: {
	evidencePacks: AtlasEvidencePack[];
	sectionBriefs: AtlasSectionBrief[];
	assembledMarkdown?: string;
}): AtlasClaimBasis[] {
	const evidencePacksById = new Map(
		input.evidencePacks.map((pack) => [pack.id, pack]),
	);
	const defaultPacks = input.evidencePacks
		.filter((pack) => pack.sourceRefs.length > 0)
		.slice(0, MAX_FALLBACK_SOURCE_REFS);
	if (defaultPacks.length === 0) return [];

	const sections = fallbackSections(input);
	const paragraphs = parseParagraphsBySection(
		input.assembledMarkdown ?? "",
		sections,
	);
	const hasParagraphs = paragraphs.some((s) => s.paragraphs.length > 0);
	const claimBasis: AtlasClaimBasis[] = [];
	const seen = new Set<string>();

	if (!hasParagraphs) {
		for (const [index, section] of sections.entries()) {
			if (claimBasis.length >= MAX_FALLBACK_SECTION_BASIS) break;
			const packs = fallbackPacksForSection({
				section,
				evidencePacks: input.evidencePacks,
				evidencePacksById,
				defaultPacks,
				index,
			});
			if (packs.length === 0) continue;
			const raw = {
				locator: {
					sectionTitle: section.title,
					paragraphIndex: null,
					claimIndex: null,
					claimText: `Section-level evidence coverage for ${section.title}`,
					quote: null,
					startOffset: null,
					endOffset: null,
				},
				supportLevel: "partial" as const,
				evidencePackIds: packs.map((pack) => pack.id),
				sourceRefs: packs.flatMap((pack) => pack.sourceRefs),
				supportRationale: fallbackBasisRationale({
					sectionTitle: section.title,
					packs,
				}),
				auditConcernCode: "atlas_claim_basis_section_fallback",
			};
			const normalized = normalizeClaimBasis({ raw, evidencePacksById });
			if (seen.has(normalized.id)) continue;
			seen.add(normalized.id);
			claimBasis.push(normalized);
		}
		return claimBasis;
	}

	for (const secParagraphs of paragraphs) {
		if (claimBasis.length >= MAX_FALLBACK_SECTION_BASIS) break;
		for (const [paraIndex, paraText] of secParagraphs.paragraphs.entries()) {
			if (claimBasis.length >= MAX_FALLBACK_SECTION_BASIS) break;
			if (!paraText) continue;
			const sectionIndex = sections.findIndex(
				(s) => s.title === secParagraphs.sectionTitle,
			);
			const packs = fallbackPacksForSection({
				section: {
					title: secParagraphs.sectionTitle,
					evidencePackIds:
						sectionIndex >= 0
							? (sections[sectionIndex]?.evidencePackIds ?? [])
							: [],
				},
				evidencePacks: input.evidencePacks,
				evidencePacksById,
				defaultPacks,
				index: sectionIndex >= 0 ? sectionIndex : 0,
			});
			if (packs.length === 0) continue;
			const claimText = compactText(paraText, 160);
			const raw = {
				locator: {
					sectionTitle: secParagraphs.sectionTitle,
					paragraphIndex: paraIndex,
					claimIndex: null,
					claimText,
					quote: null,
					startOffset: null,
					endOffset: null,
				},
				supportLevel: "partial" as const,
				evidencePackIds: packs.map((pack) => pack.id),
				sourceRefs: packs.flatMap((pack) => pack.sourceRefs),
				supportRationale: fallbackBasisRationale({
					sectionTitle: secParagraphs.sectionTitle,
					packs,
					paragraphIndex: paraIndex,
				}),
				auditConcernCode: "atlas_claim_basis_section_fallback",
			};
			const normalized = normalizeClaimBasis({ raw, evidencePacksById });
			if (seen.has(normalized.id)) continue;
			seen.add(normalized.id);
			claimBasis.push(normalized);
		}
	}
	return claimBasis;
}

interface ParagraphSection {
	sectionTitle: string;
	paragraphs: string[];
}

function parseParagraphsBySection(
	markdown: string,
	sections: Array<{ title: string }>,
): ParagraphSection[] {
	const lines = markdown.split(/\r?\n/);
	const result: ParagraphSection[] = [];
	let currentSection: ParagraphSection | null = null;
	let currentBuf: string[] = [];

	function flushParagraph(): void {
		const text = currentBuf.join("\n").trim();
		if (text) {
			const sec = currentSection ?? result[result.length - 1];
			if (sec) {
				sec.paragraphs.push(text);
			}
		}
		currentBuf = [];
	}

	for (const line of lines) {
		const headingMatch = line.match(/^#{2,3}\s+(.+?)\s*#*\s*$/);
		if (headingMatch) {
			flushParagraph();
			const title = headingMatch[1].replace(/^["']|["']$/g, "").trim();
			const matchedSection = sections.find(
				(s) =>
					normalizeText(s.title)?.toLowerCase() ===
					normalizeText(title)?.toLowerCase(),
			);
			currentSection = {
				sectionTitle: matchedSection?.title ?? title,
				paragraphs: [],
			};
			result.push(currentSection);
			continue;
		}
		if (line === "") {
			flushParagraph();
			continue;
		}
		currentBuf.push(line);
	}
	flushParagraph();

	if (result.length === 0) {
		const fallbackSectionTitle = sections[0]?.title ?? "Atlas report";
		const paras = markdown
			.split(/\n\s*\n/)
			.map((p) => p.trim())
			.filter(Boolean);
		if (paras.length > 0) {
			result.push({
				sectionTitle: fallbackSectionTitle,
				paragraphs: paras,
			});
		}
	}

	return result;
}

function fallbackSections(input: {
	sectionBriefs: AtlasSectionBrief[];
	assembledMarkdown?: string;
}): Array<{ title: string; evidencePackIds: string[] }> {
	const fromBriefs = input.sectionBriefs.map((brief) => ({
		title: brief.sectionTitle,
		evidencePackIds: uniqueStrings([
			...brief.evidencePackIds,
			...brief.sourceAssociations.flatMap((association) =>
				association.evidencePackId ? [association.evidencePackId] : [],
			),
		]),
	}));
	const fromMarkdown = markdownSectionTitles(input.assembledMarkdown ?? "").map(
		(title) => ({
			title,
			evidencePackIds: [],
		}),
	);
	const sections: Array<{ title: string; evidencePackIds: string[] }> = [];
	const seen = new Set<string>();
	for (const section of [...fromBriefs, ...fromMarkdown]) {
		if (isSourceSectionTitle(section.title)) continue;
		const key = normalizeText(section.title)?.toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		sections.push(section);
	}
	return sections.length > 0
		? sections
		: [{ title: "Atlas report", evidencePackIds: [] }];
}

function markdownSectionTitles(markdown: string): string[] {
	return markdown
		.split(/\r?\n/)
		.flatMap((line): string[] => {
			const match = line.match(/^#{2,3}\s+(.+?)\s*#*\s*$/);
			return match?.[1] ? [match[1]] : [];
		})
		.map((title) => title.replace(/^["']|["']$/g, "").trim())
		.filter(Boolean)
		.slice(0, 12);
}

function isSourceSectionTitle(title: string): boolean {
	return /^(sources|source list|references|bibliography|forrasok|források|hivatkozasok|hivatkozások)$/i.test(
		title.trim(),
	);
}

function fallbackPacksForSection(input: {
	section: { title: string; evidencePackIds: string[] };
	evidencePacks: AtlasEvidencePack[];
	evidencePacksById: Map<string, AtlasEvidencePack>;
	defaultPacks: AtlasEvidencePack[];
	index: number;
}): AtlasEvidencePack[] {
	const explicit = input.section.evidencePackIds
		.map((id) => input.evidencePacksById.get(id))
		.filter((pack): pack is AtlasEvidencePack => Boolean(pack));
	if (explicit.length > 0) return explicit.slice(0, MAX_FALLBACK_SOURCE_REFS);

	const normalizedSection = normalizeText(input.section.title)?.toLowerCase();
	const hinted = input.evidencePacks.filter(
		(pack) =>
			pack.sourceRefs.length > 0 &&
			normalizeText(pack.affectedSectionHint)?.toLowerCase() ===
				normalizedSection,
	);
	if (hinted.length > 0) return hinted.slice(0, MAX_FALLBACK_SOURCE_REFS);

	if (/limitations?|korlatok|korlátok/i.test(input.section.title)) {
		const limited = input.evidencePacks.filter(
			(pack) =>
				pack.sourceRefs.length > 0 &&
				(pack.limitations.length > 0 ||
					pack.conflicts.length > 0 ||
					!pack.freshness.isCurrentEvidence),
		);
		if (limited.length > 0) return limited.slice(0, MAX_FALLBACK_SOURCE_REFS);
	}

	const offset = input.index % Math.max(input.defaultPacks.length, 1);
	return [
		...input.defaultPacks.slice(offset),
		...input.defaultPacks.slice(0, offset),
	].slice(0, Math.min(4, MAX_FALLBACK_SOURCE_REFS));
}

function fallbackBasisRationale(input: {
	sectionTitle: string;
	packs: AtlasEvidencePack[];
	paragraphIndex?: number;
}): string {
	const sourceTitles = uniqueStrings(
		input.packs.flatMap((pack) =>
			pack.sourceRefs.map((sourceRef) => sourceRef.title),
		),
	);
	const leadSource = sourceTitles[0] ?? "accepted Atlas evidence";
	const extra = Math.max(sourceTitles.length - 1, 0);
	const sourcePhrase =
		extra > 0
			? `"${leadSource}" and ${extra} other source(s)`
			: `"${leadSource}"`;
	const paraLabel =
		input.paragraphIndex != null
			? `paragraph ${input.paragraphIndex + 1} of `
			: "";
	return compactText(
		`${sourcePhrase} provide paragraph-level evidence for ${paraLabel}${input.sectionTitle}.`,
		MAX_RATIONALE_LENGTH,
	);
}

function stableClaimBasisId(input: unknown): string {
	const hash = createHash("sha256")
		.update(JSON.stringify(input))
		.digest("base64url")
		.slice(0, 18);
	return `atlas-claim-v1-${hash}`;
}

function shouldRetryUnsupported(basis: AtlasClaimBasis): boolean {
	return basis.supportLevel === "unsupported" && !isLimitationLocator(basis);
}

function isLimitationLocator(basis: AtlasClaimBasis): boolean {
	return /\b(limitations?|korlátok|korlatok)\b/i.test(
		basis.locator.sectionTitle ?? "",
	);
}

function legacyMarkerMessage(basis: AtlasClaimBasis): string {
	return `${basis.locator.sectionTitle ? `${basis.locator.sectionTitle}: ` : ""}${basis.supportRationale}`;
}

function pushMarker(
	markers: AtlasHonestyMarker[],
	seen: Set<string>,
	marker: AtlasHonestyMarker,
): void {
	const key = `${marker.code}:${marker.message}:${marker.severity}`;
	if (seen.has(key)) return;
	seen.add(key);
	markers.push(marker);
}

function isUnsupportedConcern(code: string): boolean {
	return /(hallucinated|invented|made_up|fabricated|unsupported_fact|unsupported_connection|logical_connection)/i.test(
		code,
	);
}

function isPartialConcern(code: string): boolean {
	return /(stale|contested|contradict|conflict|ambiguous)/i.test(code);
}

function normalizeCode(value: unknown): string | null {
	const text = normalizeText(value);
	if (!text) return null;
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
}

function normalizeText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized || null;
}

function compactText(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized
		.slice(0, maxLength)
		.replace(/\s+\S*$/, "")
		.trim()}...`;
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(
		new Set(
			values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean),
		),
	);
}

function integerOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

export function mergeWriterAndAuditClaimBasis(
	writerBasis: AtlasWriterClaimBasisEntry[] | null | undefined,
	auditBasis: AtlasClaimBasis[],
): AtlasClaimBasis[] {
	if (!writerBasis || writerBasis.length === 0) return auditBasis;

	const result: AtlasClaimBasis[] = [...auditBasis];
	const matchedWriterClaimTexts = new Set<string>();

	for (const writerEntry of writerBasis) {
		const normalizedWriter = normalizeClaimTextForMatch(writerEntry.claimText);
		if (!normalizedWriter) continue;

		const matched = auditBasis.some((auditEntry) => {
			const normalizedAudit = normalizeClaimTextForMatch(
				auditEntry.locator.claimText,
			);
			if (!normalizedAudit) return false;
			return (
				normalizedAudit === normalizedWriter ||
				normalizedAudit.includes(normalizedWriter) ||
				normalizedWriter.includes(normalizedAudit)
			);
		});
		if (matched) {
			matchedWriterClaimTexts.add(normalizedWriter);
			continue;
		}

		// Unmatched writer entry: create a basic AtlasClaimBasis
		const writerId = stableClaimBasisId({
			version: ATLAS_CLAIM_BASIS_SCHEMA_VERSION,
			locator: {
				claimText: writerEntry.claimText,
				sectionTitle: writerEntry.sectionTitle,
			},
			supportLevel: writerEntry.supportLevel,
			supportRationale: writerEntry.rationale,
			auditConcernCode: "atlas_writer_claim_unverified",
		});
		result.push({
			version: ATLAS_CLAIM_BASIS_SCHEMA_VERSION,
			id: writerId,
			locator: {
				sectionTitle: writerEntry.sectionTitle,
				paragraphIndex: null,
				claimIndex: null,
				claimText: writerEntry.claimText,
				quote: null,
				startOffset: null,
				endOffset: null,
			},
			supportLevel: writerEntry.supportLevel,
			evidencePackIds: [],
			sourceRefs: [],
			supportRationale: writerEntry.rationale,
			auditConcernCode: "atlas_writer_claim_unverified",
		});
	}

	return result;
}

function normalizeClaimTextForMatch(text: string): string | null {
	const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
	return normalized || null;
}
