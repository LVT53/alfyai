import type { SupportedLanguage } from "$lib/server/services/language";
import {
	atlasClaimBasisToLegacyHonestyMarkers,
	buildAtlasClaimBasisPrompt,
	parseAtlasClaimBasisModelResult,
} from "./claim-basis";
import type {
	AtlasAssemblyMetadata,
	AtlasClaimBasis,
	AtlasClaimBasisDiagnostic,
	AtlasClaimBasisLimitation,
	AtlasClaimBasisResult,
	AtlasClaimBasisSectionCoverage,
	AtlasCoverageReview,
	AtlasEvidencePack,
	AtlasEvidencePackDiagnostic,
	AtlasHonestyMarker,
	AtlasSectionBrief,
} from "./types";

const RETRY_FAILURE_CODES = [
	"atlas_claim_basis_invalid_json",
	"atlas_claim_basis_missing_array",
] as const;

function shouldRetryBasis(basis: AtlasClaimBasisResult): boolean {
	return basis.diagnostics.some((diag) =>
		RETRY_FAILURE_CODES.includes(
			diag.code as (typeof RETRY_FAILURE_CODES)[number],
		),
	);
}

function buildMinimalRetryPrompt(input: {
	assembledMarkdown: string;
	sources: Array<{ title: string; url?: string | null }>;
	sectionBriefs: AtlasSectionBrief[];
	evidencePacks: AtlasEvidencePack[];
}): string {
	return JSON.stringify({
		task: "Return strict JSON with claimBasis array, retryRequested boolean, limitations array, and diagnostics array. The previous response could not be parsed as JSON. Return ONLY valid JSON, no markdown, no explanation.",
		report: input.assembledMarkdown.slice(0, 4000),
		evidencePackIds: input.evidencePacks.map((p) => p.id),
		sectionTitles: input.sectionBriefs.map((b) => b.sectionTitle),
		sources: input.sources.map((s) => ({ title: s.title, url: s.url })),
	});
}

export interface AtlasAuditUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsdMicros: number;
}

export interface AtlasAuditModelResult {
	text: string;
	usage?: AtlasAuditUsage | null;
	warning?: string | null;
}

export interface AtlasAuditBasisInput {
	assembledMarkdown: string;
	sources: Array<{ title: string; url?: string | null }>;
	limitation?: { code: string; message: string } | null;
	language?: SupportedLanguage;
	currentDate?: string;
	evidencePacks?: AtlasEvidencePack[];
	evidencePackDiagnostics?: AtlasEvidencePackDiagnostic[];
	coverageReview?: AtlasCoverageReview | null;
	sectionBriefs?: AtlasSectionBrief[];
	assemblyMetadata?: AtlasAssemblyMetadata;
	runAuditModel?: (prompt: string) => Promise<AtlasAuditModelResult>;
	auditModelWarning?: string | null;
}

export interface AtlasAuditBasisResult {
	passed: boolean;
	honestyMarkers: AtlasHonestyMarker[];
	retryRequested: boolean;
	usage?: AtlasAuditUsage | null;
	claimBasis: AtlasClaimBasis[];
	basisLimitations: AtlasClaimBasisLimitation[];
	basisDiagnostics: AtlasClaimBasisDiagnostic[];
	claimBasisCoverageBySection: AtlasClaimBasisSectionCoverage[];
	claimBasisStatus: AtlasClaimBasisResult["status"];
	claimBasisFailureReason: string | null;
}

function emptyClaimBasisResult(input: {
	code: string;
	message: string;
	sectionBriefs: AtlasSectionBrief[];
}): AtlasClaimBasisResult {
	return {
		version: "atlas.claim-basis.v1",
		claimBasis: [],
		limitations: [],
		diagnostics: [
			{
				code: input.code,
				severity: "warning",
				message: input.message,
			},
		],
		coverageBySection: input.sectionBriefs.map((brief) => ({
			sectionTitle: brief.sectionTitle,
			factualClaimCount: 0,
			basisCount: 0,
			supportedCount: 0,
			partialCount: 0,
			unsupportedCount: 0,
			density: 0,
		})),
		status: "failed",
		failureReason: input.message,
		retryRequested: false,
	};
}

function parseLegacyAuditMarkers(text: string): {
	markers: AtlasHonestyMarker[];
	retryRequested: boolean;
} {
	const trimmed = text.trim();
	if (!trimmed) return { markers: [], retryRequested: false };

	try {
		const parsed = JSON.parse(trimmed) as {
			markers?: unknown;
			retryRequested?: unknown;
		};
		const markers = Array.isArray(parsed.markers)
			? parsed.markers.flatMap((marker): AtlasHonestyMarker[] => {
					if (!marker || typeof marker !== "object") return [];
					const record = marker as Record<string, unknown>;
					const code =
						typeof record.code === "string" && record.code.trim()
							? record.code.trim()
							: "atlas_audit_marker";
					const message =
						typeof record.message === "string" && record.message.trim()
							? record.message.trim()
							: "The audit model flagged this report area.";
					const severity =
						record.severity === "critical" ||
						record.severity === "warning" ||
						record.severity === "info"
							? record.severity
							: "warning";
					return [{ code, message, severity }];
				})
			: [];
		return {
			markers,
			retryRequested: parsed.retryRequested === true,
		};
	} catch {
		return { markers: [], retryRequested: /retry/i.test(trimmed) };
	}
}

function appendStaticAuditFindings(input: {
	honestyMarkers: AtlasHonestyMarker[];
	basisDiagnostics: AtlasClaimBasisDiagnostic[];
	basisLimitations: AtlasClaimBasisLimitation[];
	auditModelWarning?: string | null;
	limitation?: { code: string; message: string } | null;
	sourceCount: number;
}): void {
	if (input.auditModelWarning) {
		input.honestyMarkers.push({
			code: "atlas_audit_model_fallback",
			message: input.auditModelWarning,
			severity: "warning",
		});
		input.basisDiagnostics.push({
			code: "atlas_audit_model_fallback",
			severity: "warning",
			message: input.auditModelWarning,
		});
	}
	if (input.limitation) {
		input.honestyMarkers.push({
			code: input.limitation.code,
			message: input.limitation.message,
			severity: "warning",
		});
		input.basisLimitations.push({
			code: input.limitation.code,
			message: input.limitation.message,
			basisIds: [],
			sectionTitle: null,
		});
	}
	if (input.sourceCount === 0) {
		input.honestyMarkers.push({
			code: "atlas_no_sources",
			message: "Atlas could not attach external sources to this report.",
			severity: "critical",
		});
		input.basisDiagnostics.push({
			code: "atlas_no_sources",
			severity: "warning",
			message:
				"Atlas could not attach accepted sources, so Claim Basis support could not be established.",
		});
	}
}

function resultFromBasis(input: {
	basis: AtlasClaimBasisResult;
	honestyMarkers: AtlasHonestyMarker[];
	usage?: AtlasAuditUsage | null;
}): AtlasAuditBasisResult {
	const retryRequested = input.basis.retryRequested;
	if (retryRequested) {
		input.honestyMarkers.push({
			code: "atlas_audit_retry_requested",
			message: "The audit model requested another Atlas revision.",
			severity: "warning",
		});
	}
	const honestyMarkers = uniqueHonestyMarkers(input.honestyMarkers);
	const hasCriticalMarker = honestyMarkers.some(
		(marker) => marker.severity === "critical",
	);
	return {
		passed: !hasCriticalMarker,
		honestyMarkers,
		retryRequested,
		usage: input.usage ?? null,
		claimBasis: input.basis.claimBasis,
		basisLimitations: input.basis.limitations,
		basisDiagnostics: input.basis.diagnostics,
		claimBasisCoverageBySection: input.basis.coverageBySection,
		claimBasisStatus: input.basis.status,
		claimBasisFailureReason: input.basis.failureReason,
	};
}

export async function auditAtlasBasis(
	input: AtlasAuditBasisInput,
): Promise<AtlasAuditBasisResult> {
	const evidencePacks = input.evidencePacks ?? [];
	const evidencePackDiagnostics = input.evidencePackDiagnostics ?? [];
	const sectionBriefs =
		input.sectionBriefs ?? input.assemblyMetadata?.sectionBriefs ?? [];
	const honestyMarkers: AtlasHonestyMarker[] = [];
	const staticBasisDiagnostics: AtlasClaimBasisDiagnostic[] = [];
	const staticBasisLimitations: AtlasClaimBasisLimitation[] = [];

	appendStaticAuditFindings({
		honestyMarkers,
		basisDiagnostics: staticBasisDiagnostics,
		basisLimitations: staticBasisLimitations,
		auditModelWarning: input.auditModelWarning,
		limitation: input.limitation,
		sourceCount: input.sources.length,
	});

	if (!input.runAuditModel) {
		const basis = emptyClaimBasisResult({
			code: "atlas_claim_basis_not_generated",
			message:
				"Atlas did not receive an audit model response, so it did not create fine-grained Claim Basis data.",
			sectionBriefs,
		});
		basis.diagnostics.unshift(...staticBasisDiagnostics);
		basis.limitations.unshift(...staticBasisLimitations);
		return resultFromBasis({ basis, honestyMarkers, usage: null });
	}

	const audit = await input.runAuditModel(
		buildAtlasClaimBasisPrompt({
			language: input.language ?? "en",
			currentDate: input.currentDate ?? new Date().toISOString().slice(0, 10),
			assembledMarkdown: input.assembledMarkdown,
			evidencePacks,
			evidencePackDiagnostics,
			sectionBriefs,
			coverageReview: input.coverageReview ?? null,
			sources: input.sources,
			limitation: input.limitation ?? null,
		}),
	);
	let basis = parseAtlasClaimBasisModelResult({
		modelText: audit.text,
		evidencePacks,
		sectionBriefs,
	});

	if (shouldRetryBasis(basis)) {
		const retryAudit = await input.runAuditModel(
			buildMinimalRetryPrompt({
				assembledMarkdown: input.assembledMarkdown,
				sources: input.sources,
				sectionBriefs,
				evidencePacks,
			}),
		);
		basis = parseAtlasClaimBasisModelResult({
			modelText: retryAudit.text,
			evidencePacks,
			sectionBriefs,
		});
		basis.diagnostics.unshift({
			code: "atlas_claim_basis_retry_attempted",
			severity: "info",
			message:
				"Atlas retried claim basis generation with a simplified prompt after JSON parse failure.",
		});
	}
	basis.diagnostics.unshift(...staticBasisDiagnostics);
	basis.limitations.unshift(...staticBasisLimitations);
	honestyMarkers.push(
		...atlasClaimBasisToLegacyHonestyMarkers({
			claimBasis: basis.claimBasis,
			limitations: basis.limitations,
		}),
	);

	const legacy = parseLegacyAuditMarkers(audit.text);
	honestyMarkers.push(...legacy.markers);
	if (legacy.retryRequested && !basis.retryRequested) {
		basis.retryRequested = true;
	}

	return resultFromBasis({
		basis,
		honestyMarkers,
		usage: audit.usage ?? null,
	});
}

function uniqueHonestyMarkers(
	markers: AtlasHonestyMarker[],
): AtlasHonestyMarker[] {
	const seen = new Set<string>();
	return markers.filter((marker) => {
		const key = `${marker.code}:${marker.message}:${marker.severity}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
