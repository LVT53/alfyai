import { z } from "zod";
import type { SupportedLanguage } from "$lib/server/services/language";
import type { AtlasProfileRuntimeConfig } from "./config";
import {
	ATLAS_COVERAGE_REVIEW_SCHEMA_VERSION,
	ATLAS_GAP_PROPOSAL_PRIORITIES,
	type AtlasCoverageReview,
	type AtlasCoverageReviewDiagnostic,
	type AtlasCoverageReviewLimitation,
	type AtlasEvidencePack,
	type AtlasEvidencePackDiagnostic,
	type AtlasGapProposal,
} from "./types";

const gapProposalSchema = z.strictObject({
	missingQuestion: z.string().trim().min(1),
	whyCurrentEvidenceIsWeak: z.string().trim().min(1),
	targetSearchQuery: z.string().trim().min(1),
	desiredEvidenceType: z.string().trim().min(1),
	affectedSection: z.string().trim().min(1),
	priority: z.enum(ATLAS_GAP_PROPOSAL_PRIORITIES),
});

const coverageReviewSchema = z.strictObject({
	sufficient: z.boolean(),
	proposals: z.array(gapProposalSchema),
});

export interface BuildAtlasCoverageReviewPromptInput {
	language: SupportedLanguage;
	query: string;
	currentDate: string;
	intendedQuestions: string[];
	outline: string;
	evidencePacks: AtlasEvidencePack[];
	evidencePackDiagnostics: AtlasEvidencePackDiagnostic[];
}

export interface ParseAndApproveAtlasCoverageReviewInput {
	modelText: string;
	profileConfig: AtlasProfileRuntimeConfig;
	completedGapFillRounds: number;
}

export function buildAtlasCoverageReviewPrompt(
	input: BuildAtlasCoverageReviewPromptInput,
): string {
	const languageInstruction =
		input.language === "hu"
			? "A hiányjavaslatok magyarul legyenek, de a keresési lekérdezés maradhat azon a nyelven, amely a legjobb forrásokat találja."
			: "Write gap proposals in English, but the search query may use the language most likely to find the right sources.";
	return JSON.stringify({
		detectedLanguage: input.language,
		currentDate: input.currentDate,
		query: input.query,
		instructions: [
			"Compare intendedQuestions and outline against evidencePacks.",
			"Return strict JSON only.",
			"Set sufficient true only when the Evidence Packs can support the intended report without a high-value repair search.",
			"Only propose concrete, source-searchable gaps with evidence weakness tied to a report question or section.",
			"Do not include server-control fields; Atlas decides round approval separately.",
			languageInstruction,
		],
		expectedJsonShape: {
			sufficient: "boolean",
			proposals: "array",
			proposal: {
				missingQuestion: "string",
				whyCurrentEvidenceIsWeak: "string",
				targetSearchQuery: "string",
				desiredEvidenceType: "string",
				affectedSection: "string",
				priority: "critical | high | medium | low",
			},
		},
		intendedQuestions: input.intendedQuestions,
		outline: input.outline,
		evidencePacks: input.evidencePacks,
		evidencePackDiagnostics: input.evidencePackDiagnostics,
	});
}

export function parseAndApproveAtlasCoverageReview(
	input: ParseAndApproveAtlasCoverageReviewInput,
): AtlasCoverageReview {
	const parsed = parseCoverageReviewJson(input.modelText);
	if (!parsed.ok) {
		return invalidCoverageReview({
			code: parsed.code,
			message: parsed.message,
		});
	}

	const diagnostics: AtlasCoverageReviewDiagnostic[] = [];
	const approvedGapCandidates: AtlasGapProposal[] = [];
	const remainingRounds = Math.max(
		0,
		input.profileConfig.architecture.gapFillCaps.maxRounds -
			input.completedGapFillRounds,
	);

	if (parsed.review.sufficient) {
		diagnostics.push({
			code: "atlas_coverage_review_sufficient",
			severity: "info",
			message:
				"Coverage Review found the current Evidence Packs sufficient for the intended report.",
		});
		return {
			version: ATLAS_COVERAGE_REVIEW_SCHEMA_VERSION,
			sufficient: true,
			proposals: parsed.review.proposals,
			approvedGapCandidates,
			diagnostics,
			limitations: [],
		};
	}

	for (const proposal of parsed.review.proposals) {
		const actionableDiagnostic = proposalActionabilityDiagnostic(proposal);
		if (actionableDiagnostic) {
			diagnostics.push(actionableDiagnostic);
			continue;
		}
		if (proposal.priority !== "critical" && proposal.priority !== "high") {
			diagnostics.push({
				code: "atlas_gap_proposal_priority_too_low",
				severity: "info",
				message:
					"Coverage Review proposal was not approved because only critical or high gaps can spend profile budget.",
				proposal,
			});
			continue;
		}
		if (approvedGapCandidates.length >= remainingRounds) {
			diagnostics.push({
				code: "atlas_gap_fill_cap_exhausted",
				severity: "info",
				message:
					"Coverage Review proposal was not approved because the profile gap-fill cap is exhausted.",
				proposal,
			});
			continue;
		}
		approvedGapCandidates.push(proposal);
	}

	return {
		version: ATLAS_COVERAGE_REVIEW_SCHEMA_VERSION,
		sufficient: false,
		proposals: parsed.review.proposals,
		approvedGapCandidates,
		diagnostics,
		limitations: [],
	};
}

function parseCoverageReviewJson(text: string):
	| {
			ok: true;
			review: {
				sufficient: boolean;
				proposals: AtlasGapProposal[];
			};
	  }
	| { ok: false; code: string; message: string } {
	const candidates = jsonCandidates(text);
	for (const candidate of candidates) {
		try {
			const raw = JSON.parse(candidate) as unknown;
			const parsed = coverageReviewSchema.safeParse(raw);
			if (parsed.success) {
				return { ok: true, review: parsed.data };
			}
			return {
				ok: false,
				code: "atlas_coverage_review_invalid_schema",
				message: `Coverage Review output did not match the required strict schema: ${parsed.error.issues
					.map((issue) => issue.path.join(".") || issue.code)
					.join(", ")}`,
			};
		} catch {
			// Try the next candidate, usually a fenced JSON body.
		}
	}
	return {
		ok: false,
		code: "atlas_coverage_review_invalid_json",
		message:
			"Coverage Review did not return parseable strict JSON, so Atlas skipped gap-fill approval.",
	};
}

function jsonCandidates(text: string): string[] {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	return [trimmed, fenced].filter((candidate): candidate is string =>
		Boolean(candidate),
	);
}

function invalidCoverageReview(input: {
	code: string;
	message: string;
}): AtlasCoverageReview {
	const limitation: AtlasCoverageReviewLimitation = {
		code: input.code,
		message: input.message,
	};
	return {
		version: ATLAS_COVERAGE_REVIEW_SCHEMA_VERSION,
		sufficient: false,
		proposals: [],
		approvedGapCandidates: [],
		diagnostics: [
			{
				code: input.code,
				severity: "warning",
				message: input.message,
			},
		],
		limitations: [limitation],
	};
}

function proposalActionabilityDiagnostic(
	proposal: AtlasGapProposal,
): AtlasCoverageReviewDiagnostic | null {
	if (
		!targetLooksConcrete(proposal.targetSearchQuery) ||
		!desiredEvidenceTypeLooksSpecific(proposal.desiredEvidenceType)
	) {
		return {
			code: "atlas_gap_proposal_not_actionable",
			severity: "warning",
			message:
				"Coverage Review proposal was rejected because it did not provide a concrete, searchable evidence target.",
			proposal,
		};
	}
	if (!weaknessIsTiedToReportSurface(proposal)) {
		return {
			code: "atlas_gap_proposal_weakness_not_tied",
			severity: "warning",
			message:
				"Coverage Review proposal was rejected because its evidence weakness was not tied to a report question or section.",
			proposal,
		};
	}
	return null;
}

function targetLooksConcrete(query: string): boolean {
	const normalized = normalizeForHeuristic(query);
	if (
		/^(research|search|find|look up|investigate)\s+more\b/.test(normalized) ||
		/\b(more|additional|better)\s+(sources|evidence|information|details|context|data|competitors)\b/.test(
			normalized,
		)
	) {
		return false;
	}
	const tokens = significantTokens(query);
	if (tokens.length < 4) return false;
	const genericTokenCount = tokens.filter((token) =>
		GENERIC_SEARCH_TOKENS.has(token),
	).length;
	return genericTokenCount < tokens.length - 1;
}

function desiredEvidenceTypeLooksSpecific(value: string): boolean {
	const normalized = normalizeForHeuristic(value);
	return !GENERIC_EVIDENCE_TYPES.has(normalized);
}

function weaknessIsTiedToReportSurface(proposal: AtlasGapProposal): boolean {
	const weakness = normalizeForHeuristic(proposal.whyCurrentEvidenceIsWeak);
	if (weakness.length < 45) return false;
	if (
		!/\b(evidence|source|sources|pack|packs|accepted|current|stale|conflict|conflicting|missing|weak|thin|does not|do not|no)\b/.test(
			weakness,
		)
	) {
		return false;
	}
	return (
		proposal.missingQuestion.trim().length >= 20 &&
		proposal.affectedSection.trim().length >= 3
	);
}

function normalizeForHeuristic(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function significantTokens(value: string): string[] {
	return normalizeForHeuristic(value)
		.split(" ")
		.filter((token) => token.length >= 3)
		.filter((token) => !GENERIC_SEARCH_TOKENS.has(token));
}

const GENERIC_SEARCH_TOKENS = new Set([
	"about",
	"additional",
	"better",
	"competitors",
	"context",
	"data",
	"details",
	"evidence",
	"find",
	"information",
	"investigate",
	"look",
	"more",
	"research",
	"search",
	"sources",
]);

const GENERIC_EVIDENCE_TYPES = new Set([
	"data",
	"evidence",
	"information",
	"more data",
	"more evidence",
	"more information",
	"sources",
]);
