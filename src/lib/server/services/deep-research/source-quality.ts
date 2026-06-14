import type {
	DeepResearchClaimFit,
	DeepResearchClaimType,
	DeepResearchExtractionConfidence,
	DeepResearchSourceAuthoritySummary,
	DeepResearchSourceDirectness,
	DeepResearchSourceFreshness,
	DeepResearchSourceIndependence,
	DeepResearchSourceQualitySignals,
	DeepResearchSourceType,
} from "$lib/types";

export type EvaluateSourceQualitySignalsInput = {
	url: string;
	title?: string | null;
	snippet?: string | null;
	sourceText?: string | null;
	keyFindings?: string[];
	supportedKeyQuestions?: string[];
	relevanceScore?: number | null;
	publishedAt?: string | null;
	now?: Date;
};

export function evaluateSourceQualitySignals(
	input: EvaluateSourceQualitySignalsInput,
): DeepResearchSourceQualitySignals {
	const text = normalizeText(
		[
			input.title,
			input.snippet,
			input.sourceText,
			...(input.keyFindings ?? []),
			...(input.supportedKeyQuestions ?? []),
		]
			.filter(Boolean)
			.join(" "),
	);
	const sourceType = inferSourceType(input.url, text);
	const independence = inferIndependence(sourceType);
	const directness = inferDirectness({ sourceType, text });
	const extractionConfidence = inferExtractionConfidence({
		sourceText: input.sourceText,
		keyFindings: input.keyFindings ?? [],
		relevanceScore: input.relevanceScore,
	});

	return {
		sourceType,
		independence,
		freshness: inferFreshness(input.publishedAt, input.now ?? new Date()),
		directness,
		extractionConfidence,
		claimFit: inferClaimFit({
			directness,
			extractionConfidence,
			supportedKeyQuestions: input.supportedKeyQuestions ?? [],
			relevanceScore: input.relevanceScore,
		}),
	};
}

export function classifyDeepResearchClaimType(
	claimText: string,
): DeepResearchClaimType {
	const normalized = normalizeText(claimText).toLowerCase();
	if (isHighStakesClaim(normalized)) return "high_stakes";
	if (isOfficialSpecificationClaim(normalized)) {
		return "official_specification";
	}
	if (isPriceAvailabilityClaim(normalized)) return "price_availability";
	if (isReliabilityExperienceClaim(normalized)) {
		return "reliability_experience";
	}
	return "general";
}

export function deriveSourceAuthoritySummary(
	signals: DeepResearchSourceQualitySignals | null | undefined,
): DeepResearchSourceAuthoritySummary | null {
	if (!signals) return null;
	const score = scoreSourceQualitySignals(signals);
	const reasons: string[] = [
		humanizeSignal("type", signals.sourceType),
		humanizeSignal("independence", signals.independence),
		humanizeSignal("directness", signals.directness),
		humanizeSignal("claim fit", signals.claimFit),
	];

	return {
		label: authorityLabel(signals, score),
		score,
		reasons,
	};
}

export function scoreSourceQualitySignals(
	signals: DeepResearchSourceQualitySignals,
): number {
	let score = 0;

	score += valueScore(signals.sourceType, {
		official_government: 26,
		academic: 24,
		independent_analysis: 22,
		official_vendor: 18,
		news: 14,
		forum: 8,
		vendor_marketing: 6,
		unknown: 8,
	});
	score += valueScore(signals.independence, {
		independent: 24,
		primary: 20,
		community: 12,
		affiliated: 8,
		unknown: 8,
	});
	score += valueScore(signals.freshness, {
		current: 14,
		recent: 12,
		dated: 9,
		undated: 7,
		unknown: 6,
		stale: 2,
	});
	score += valueScore(signals.directness, {
		direct: 18,
		indirect: 9,
		anecdotal: 5,
		unknown: 6,
	});
	score += valueScore(signals.extractionConfidence, {
		high: 10,
		medium: 6,
		low: 2,
	});
	score += valueScore(signals.claimFit, {
		strong: 18,
		partial: 10,
		weak: 3,
		mismatch: 0,
		unknown: 4,
	});

	return Math.max(0, Math.min(100, score));
}

export function parseSourceQualitySignals(
	value: string | null,
): DeepResearchSourceQualitySignals | null {
	if (!value) return null;
	try {
		return normalizeSourceQualitySignals(JSON.parse(value) as unknown);
	} catch {
		return null;
	}
}

export function normalizeSourceQualitySignals(
	value: unknown,
): DeepResearchSourceQualitySignals | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Partial<DeepResearchSourceQualitySignals>;
	const signals: DeepResearchSourceQualitySignals = {
		sourceType: sourceTypeValues.has(
			record.sourceType as DeepResearchSourceType,
		)
			? (record.sourceType as DeepResearchSourceType)
			: "unknown",
		independence: independenceValues.has(
			record.independence as DeepResearchSourceIndependence,
		)
			? (record.independence as DeepResearchSourceIndependence)
			: "unknown",
		freshness: freshnessValues.has(
			record.freshness as DeepResearchSourceFreshness,
		)
			? (record.freshness as DeepResearchSourceFreshness)
			: "unknown",
		directness: directnessValues.has(
			record.directness as DeepResearchSourceDirectness,
		)
			? (record.directness as DeepResearchSourceDirectness)
			: "unknown",
		extractionConfidence: extractionConfidenceValues.has(
			record.extractionConfidence as DeepResearchExtractionConfidence,
		)
			? (record.extractionConfidence as DeepResearchExtractionConfidence)
			: "low",
		claimFit: claimFitValues.has(record.claimFit as DeepResearchClaimFit)
			? (record.claimFit as DeepResearchClaimFit)
			: "unknown",
	};
	return signals;
}

function inferSourceType(url: string, text: string): DeepResearchSourceType {
	const hostname = safeHostname(url);
	if (hostname.endsWith(".gov") || hostname.includes(".gov.")) {
		return "official_government";
	}
	if (hostname.endsWith(".edu") || hostname.includes(".edu."))
		return "academic";
	if (/\b(peer reviewed|journal|doi|methodology|citations)\b/i.test(text)) {
		return "academic";
	}
	if (/\b(forum|reddit|community|owner report|user review)\b/i.test(text)) {
		return "forum";
	}
	if (
		/\b(independent|review|benchmark|consumer report|analyst)\b/i.test(text)
	) {
		return "independent_analysis";
	}
	if (/\b(news|press|reported)\b/i.test(text)) return "news";
	if (
		/\b(official|specification|specifications|manual|warranty)\b/i.test(text)
	) {
		return "official_vendor";
	}
	if (
		/\b(technical specs?|geometry|datasheet|product specs?|motor|battery|range|weight|frame|drivetrain)\b/i.test(
			text,
		) &&
		!/\b(review|forum|owner report|user review|commentary)\b/i.test(text)
	) {
		return "official_vendor";
	}
	if (/\b(best|leading|revolutionary|marketing|buy now)\b/i.test(text)) {
		return "vendor_marketing";
	}
	return "unknown";
}

function inferIndependence(
	sourceType: DeepResearchSourceType,
): DeepResearchSourceIndependence {
	if (sourceType === "official_government" || sourceType === "academic") {
		return "primary";
	}
	if (sourceType === "independent_analysis" || sourceType === "news") {
		return "independent";
	}
	if (sourceType === "official_vendor" || sourceType === "vendor_marketing") {
		return "affiliated";
	}
	if (sourceType === "forum") return "community";
	return "unknown";
}

function inferDirectness(input: {
	sourceType: DeepResearchSourceType;
	text: string;
}): DeepResearchSourceDirectness {
	if (input.sourceType === "forum") return "anecdotal";
	if (
		/\b(specification|specifications|specs|technical specs?|manual|datasheet|official|states|according to|geometry|component table|product page|manufacturer lists?)\b/i.test(
			input.text,
		)
	) {
		return "direct";
	}
	if (/\b(analysis|review|reported|summary|commentary)\b/i.test(input.text)) {
		return "indirect";
	}
	return "unknown";
}

function inferExtractionConfidence(input: {
	sourceText?: string | null;
	keyFindings: string[];
	relevanceScore?: number | null;
}): DeepResearchExtractionConfidence {
	const textLength = input.sourceText?.trim().length ?? 0;
	const relevanceScore = input.relevanceScore ?? 0;
	if (
		textLength >= 80 &&
		input.keyFindings.length > 0 &&
		relevanceScore >= 80
	) {
		return "high";
	}
	if (
		textLength >= 20 ||
		input.keyFindings.length > 0 ||
		relevanceScore >= 55
	) {
		return "medium";
	}
	return "low";
}

function inferFreshness(
	publishedAt: string | null | undefined,
	now: Date,
): DeepResearchSourceFreshness {
	if (!publishedAt) return "undated";
	const publishedTime = new Date(publishedAt).getTime();
	if (!Number.isFinite(publishedTime)) return "unknown";
	const ageDays = Math.max(0, (now.getTime() - publishedTime) / 86_400_000);
	if (ageDays <= 120) return "current";
	if (ageDays <= 730) return "recent";
	if (ageDays <= 1825) return "dated";
	return "stale";
}

function inferClaimFit(input: {
	directness: DeepResearchSourceDirectness;
	extractionConfidence: DeepResearchExtractionConfidence;
	supportedKeyQuestions: string[];
	relevanceScore?: number | null;
}): DeepResearchClaimFit {
	const relevanceScore = input.relevanceScore ?? 0;
	if (
		input.directness === "direct" &&
		input.extractionConfidence === "high" &&
		relevanceScore >= 80
	) {
		return "strong";
	}
	if (
		input.supportedKeyQuestions.length === 0 &&
		input.directness === "direct" &&
		input.extractionConfidence !== "low" &&
		relevanceScore >= 55
	) {
		return "partial";
	}
	if (input.supportedKeyQuestions.length === 0) return "mismatch";
	if (relevanceScore >= 55) return "partial";
	return "weak";
}

function authorityLabel(
	signals: DeepResearchSourceQualitySignals,
	score: number,
): string {
	if (signals.claimFit === "weak" || signals.claimFit === "mismatch") {
		return "Weak source fit";
	}
	if (
		signals.sourceType === "official_vendor" &&
		signals.directness === "direct" &&
		signals.claimFit === "strong"
	) {
		return "Strong for official details";
	}
	if (signals.independence === "independent" && score >= 70) {
		return "Strong independent support";
	}
	if (score >= 70) return "Strong source fit";
	if (score >= 45) return "Mixed source fit";
	return "Weak source fit";
}

function valueScore<T extends string>(
	value: T,
	scores: Partial<Record<T, number>>,
): number {
	return scores[value] ?? 0;
}

function humanizeSignal(label: string, value: string): string {
	return `${label}: ${value.replaceAll("_", " ")}`;
}

function safeHostname(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function isOfficialSpecificationClaim(normalized: string): boolean {
	return (
		/\b(official|officially|specification|specifications|manual|datasheet|vendor)\b/.test(
			normalized,
		) &&
		/\b(includes|supports|rated|capacity|storage|memory|battery|warranty|dimensions|weight|feature|features)\b/.test(
			normalized,
		)
	);
}

function isPriceAvailabilityClaim(normalized: string): boolean {
	return (
		/\b(price|prices|pricing|cost|costs|msrp|discount|available|availability|stock|in stock|sold out|shipping|delivery)\b/.test(
			normalized,
		) || /[$€£]\s?\d/.test(normalized)
	);
}

function isReliabilityExperienceClaim(normalized: string): boolean {
	return /\b(reliable|reliability|long[- ]term|owner|owners|failure|failures|durability|review|reviews|forum|experience|experiences)\b/.test(
		normalized,
	);
}

function isHighStakesClaim(normalized: string): boolean {
	return /\b(medical|medicine|diagnosis|diagnostic|treatment|legal|law|safety[- ]critical|financial advice|investment|investing|clinical|regulated health)\b/.test(
		normalized,
	);
}

const sourceTypeValues = new Set<DeepResearchSourceType>([
	"official_vendor",
	"official_government",
	"academic",
	"independent_analysis",
	"news",
	"forum",
	"vendor_marketing",
	"unknown",
]);
const independenceValues = new Set<DeepResearchSourceIndependence>([
	"primary",
	"independent",
	"affiliated",
	"community",
	"unknown",
]);
const freshnessValues = new Set<DeepResearchSourceFreshness>([
	"current",
	"recent",
	"dated",
	"stale",
	"undated",
	"unknown",
]);
const directnessValues = new Set<DeepResearchSourceDirectness>([
	"direct",
	"indirect",
	"anecdotal",
	"unknown",
]);
const extractionConfidenceValues = new Set<DeepResearchExtractionConfidence>([
	"high",
	"medium",
	"low",
]);
const claimFitValues = new Set<DeepResearchClaimFit>([
	"strong",
	"partial",
	"weak",
	"mismatch",
	"unknown",
]);
