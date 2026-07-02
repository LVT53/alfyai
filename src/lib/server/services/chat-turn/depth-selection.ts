import { performance } from "node:perf_hooks";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import { messageOrderDesc } from "$lib/server/services/message-ordering";
import type {
	DepthAppliedProfile,
	DepthMetadata,
	DepthSelectionSignals,
	DepthSelectionTimingMetadata,
	LinkedContextSource,
	ModelId,
	PendingSkillSelection,
	ReasoningDepth,
} from "$lib/types";

const SIMPLE_AUTO_FAST_PATH_MAX_CHARS = 180;
const SIMPLE_AUTO_FAST_PATH_MAX_WORDS = 24;
const SIMPLE_AUTO_FAST_PATH_CONSTRAINT_NOTE = "simple_auto_standard_fast_path";
const DETERMINISTIC_RULES_CONSTRAINT_NOTE = "cheap_auto_deterministic_rules";

const AUTO_FAST_PATH_AMBIGUITY_PATTERN =
	/\b(above|previous|earlier|last|same|again|continue|attached|attachment|file|document|source|sources|conversation|thread|draft|message|answer|response)\b/i;
const AUTO_FAST_PATH_REFERENTIAL_PATTERN =
	/\b(?:summari[sz]e|rewrite|explain|fix|update|use|check|look at)\s+(?:this|that|it|them|these|those)\b/i;
const AUTO_FAST_PATH_SHORT_FOLLOWUP_PATTERN =
	/^(?:why\??|how so\??|tell me more\.?|go on\.?|continue\.?|what about (?:this|that|it|them|these|those)\??)$/i;
const AUTO_FAST_PATH_COMPLEXITY_PATTERN =
	/\b(compare|analy[sz]e|analysis|multi[- ]?step|planning|plan|debug|evaluate|trade[- ]?off|review|assess|refactor|optimi[sz]e|migrate|design|architecture|strategy|recommend|comprehensive|exhaustive|edge cases?|failure modes?|critical|regulatory|compliance|security|audit|prove|verify|validate|guarantee|think hard|hard|deep|maximum|effort)\b/i;
const AUTO_FAST_PATH_GROUNDING_PATTERN =
	/\b(current|latest|recent|today|tomorrow|yesterday|news|weather|price|citation|citations|cite|web|internet|online|google|search|browse|look up|lookup|source-backed)\b/i;
const AUTO_FAST_PATH_BLOCKING_PATTERNS = [
	AUTO_FAST_PATH_AMBIGUITY_PATTERN,
	AUTO_FAST_PATH_REFERENTIAL_PATTERN,
	AUTO_FAST_PATH_SHORT_FOLLOWUP_PATTERN,
	AUTO_FAST_PATH_COMPLEXITY_PATTERN,
	AUTO_FAST_PATH_GROUNDING_PATTERN,
];
const FAST_PATH_EXTERNAL_RESOURCE_TERM =
	"(?:(?:external\\s+)?tools?|web\\s+search|web|internet|online\\s+sources?|sources?|files?|documents?)";
const FAST_PATH_EXTERNAL_RESOURCE_LIST = `(?:the\\s+)?${FAST_PATH_EXTERNAL_RESOURCE_TERM}(?:(?:,?\\s*(?:or|and)\\s+|,\\s*|/\\s*)(?:the\\s+)?${FAST_PATH_EXTERNAL_RESOURCE_TERM})*`;
const NEGATED_EXTERNAL_RESOURCE_DIRECTIVE_PATTERNS = [
	new RegExp(
		`\\b(?:do not|don't|dont|never)\\s+(?:use|consult|access)\\s+${FAST_PATH_EXTERNAL_RESOURCE_LIST}\\b`,
		"gi",
	),
	/\b(?:do not|don't|dont|never)\s+(?:browse|search|browse\/search|search\/browse)(?:\s+(?:the\s+)?(?:web|internet))?\b/gi,
	new RegExp(
		`\\bwithout\\s+(?:using\\s+)?${FAST_PATH_EXTERNAL_RESOURCE_LIST}\\b`,
		"gi",
	),
	new RegExp(
		`\\bno\\s+${FAST_PATH_EXTERNAL_RESOURCE_LIST}(?:\\s+(?:needed|required|necessary))?\\b`,
		"gi",
	),
];

const MAX_DEFAULT_SIGNALS: DepthSelectionSignals = {
	groundingNeed: "useful",
	contextBreadth: "broad",
	outputRoom: "expanded",
	toolUse: "normal",
};

const EXTENDED_KEYWORDS = [
	"compare",
	"analyze",
	"multi-step",
	"planning",
	"debug",
	"evaluate",
	"tradeoff",
	"trade-off",
	"trade off",
	"review",
	"assess",
	"refactor",
	"optimize",
	"migrate",
	"design",
	"architecture",
	"strategy",
	"recommend",
];

const MAXIMUM_KEYWORDS = [
	"comprehensive",
	"exhaustive",
	"edge case",
	"edge cases",
	"failure mode",
	"failure modes",
	"critical",
	"production",
	"regulatory",
	"compliance",
	"security",
	"audit",
	"prove",
	"verify",
	"validate",
	"guarantee",
];

const EXPLICIT_MAXIMUM_PATTERNS = [
	/\b(?:maximum|max|highest|expert|deep)\s+(?:reasoning|thinking|effort|analysis)\b/i,
	/\bthink\s+(?:hard|deeply)\b/i,
	/\bdeep\s+research\b/i,
];

const GROUNDING_PATTERNS = [
	AUTO_FAST_PATH_GROUNDING_PATTERN,
	/\b(evidence|sources?|citations?|cite|source[- ]?backed)\b/i,
];

const REQUIRED_GROUNDING_PATTERN =
	/\b(?:must|need|needs|required|require|with)\s+(?:evidence|sources?|citations?|cites?)\b/i;

const EXPANDED_OUTPUT_PATTERN =
	/\b(comprehensive|exhaustive|long[- ]form|full report|roadmap|implementation plan|step[- ]by[- ]step)\b/i;

type DepthSelectionTurnInput = {
	normalizedMessage: string;
	reasoningDepth: ReasoningDepth;
	modelId?: ModelId;
	modelDisplayName?: string | null;
	providerDisplayName?: string | null;
	attachmentIds?: string[];
	linkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	activeDocumentArtifactId?: string;
	personalityProfileId?: string;
	forceWebSearch?: boolean;
};

export type DepthRecentMessage = {
	role: "user" | "assistant";
	content: string;
};

type ListRecentMessages = (params: {
	userId: string;
	conversationId: string;
}) => Promise<DepthRecentMessage[]>;

export type ResolveReasoningDepthSelectionParams = {
	userId: string;
	conversationId: string;
	request: DepthSelectionTurnInput;
	listRecentMessages?: ListRecentMessages;
};

export type ResolveReasoningDepthSelectionResult = {
	metadata: DepthMetadata;
};

export async function resolveReasoningDepthSelection(
	params: ResolveReasoningDepthSelectionParams,
): Promise<ResolveReasoningDepthSelectionResult> {
	const selectionStartedAt = nowDepthSelectionMs();
	const { request } = params;
	if (request.reasoningDepth === "off") {
		return {
			metadata: buildDepthMetadata({
				request,
				appliedProfile: "off",
				classifierSource: "deterministic_bypass",
				constraintNote: "explicit_off",
				timing: buildDepthSelectionTiming({
					selectionStartedAt,
					classifierSource: "deterministic_bypass",
					appliedProfile: "off",
					classifierAttempts: 0,
				}),
			}),
		};
	}
	if (request.reasoningDepth === "max") {
		const recentMessagesStartedAt = nowDepthSelectionMs();
		const maxSignals = await resolveMaxSignals(params);
		const recentMessagesMs = elapsedDepthSelectionMs(recentMessagesStartedAt);
		return {
			metadata: buildDepthMetadata({
				request,
				appliedProfile: "maximum",
				signals: maxSignals,
				classifierSource: "deterministic_bypass",
				constraintNote: "explicit_max",
				timing: buildDepthSelectionTiming({
					selectionStartedAt,
					classifierSource: "deterministic_bypass",
					appliedProfile: "maximum",
					classifierAttempts: 0,
					recentMessagesMs,
				}),
			}),
		};
	}
	const fastPathResult = runSafeStandardAutoFastPath(request);
	if (fastPathResult) {
		logClassifierResult({
			source: "deterministic_fast_path",
			appliedProfile: fastPathResult.appliedProfile,
			attemptCount: 0,
		});
		return {
			metadata: buildDepthMetadata({
				request,
				appliedProfile: fastPathResult.appliedProfile,
				signals: fastPathResult.signals,
				classifierSource: "deterministic_fast_path",
				constraintNote: SIMPLE_AUTO_FAST_PATH_CONSTRAINT_NOTE,
				timing: buildDepthSelectionTiming({
					selectionStartedAt,
					classifierSource: "deterministic_fast_path",
					appliedProfile: fastPathResult.appliedProfile,
					classifierAttempts: 0,
				}),
			}),
		};
	}
	const keywordResult = runDeterministicRulesClassifier(request);
	logClassifierResult({
		source: "deterministic_rules",
		appliedProfile: keywordResult.appliedProfile,
		attemptCount: 0,
	});
	return {
		metadata: buildDepthMetadata({
			request,
			appliedProfile: keywordResult.appliedProfile,
			signals: keywordResult.signals,
			classifierSource: "deterministic_rules",
			constraintNote: DETERMINISTIC_RULES_CONSTRAINT_NOTE,
			timing: buildDepthSelectionTiming({
				selectionStartedAt,
				classifierSource: "deterministic_rules",
				appliedProfile: keywordResult.appliedProfile,
				classifierAttempts: 0,
			}),
		}),
	};
}

function buildDepthMetadata(params: {
	request: DepthSelectionTurnInput;
	appliedProfile: DepthAppliedProfile;
	classifierSource: string;
	fallback?: boolean;
	fallbackReason?: string;
	constraintNote?: string;
	signals?: DepthSelectionSignals;
	timing?: DepthSelectionTimingMetadata;
}): DepthMetadata {
	const metadata: DepthMetadata = {
		requested: params.request.reasoningDepth,
		appliedProfile: params.appliedProfile,
		fallback: params.fallback ?? false,
		classifierSource: params.classifierSource,
	};
	if (params.fallbackReason) metadata.fallbackReason = params.fallbackReason;
	if (params.constraintNote) metadata.constraintNote = params.constraintNote;
	if (params.signals) metadata.signals = params.signals;
	if (params.timing) metadata.timing = params.timing;
	if (params.request.modelId) metadata.modelId = params.request.modelId;
	if (params.request.modelDisplayName) {
		metadata.modelDisplayName = params.request.modelDisplayName;
	}
	if (params.request.providerDisplayName) {
		metadata.providerDisplayName = params.request.providerDisplayName;
	}
	return metadata;
}

function buildDepthSelectionTiming(params: {
	selectionStartedAt: number;
	classifierSource: string;
	appliedProfile: DepthAppliedProfile;
	classifierAttempts: number;
	fallbackReason?: string;
	recentMessagesMs?: number;
	classificationContextMs?: number;
	classifierModelResolutionMs?: number;
	controlModelClassifierMs?: number;
}): DepthSelectionTimingMetadata {
	const classifierAttempts = Number.isFinite(params.classifierAttempts)
		? Math.max(0, Math.floor(params.classifierAttempts))
		: 0;
	const timing: DepthSelectionTimingMetadata = {
		totalMs: elapsedDepthSelectionMs(params.selectionStartedAt),
		classifierAttempts,
		classifierSource: params.classifierSource,
		appliedProfile: params.appliedProfile,
	};
	assignDepthSelectionDuration(
		timing,
		"recentMessagesMs",
		params.recentMessagesMs,
	);
	assignDepthSelectionDuration(
		timing,
		"classificationContextMs",
		params.classificationContextMs,
	);
	assignDepthSelectionDuration(
		timing,
		"classifierModelResolutionMs",
		params.classifierModelResolutionMs,
	);
	assignDepthSelectionDuration(
		timing,
		"controlModelClassifierMs",
		params.controlModelClassifierMs,
	);
	if (params.fallbackReason) {
		timing.fallbackReason = params.fallbackReason;
	}
	return timing;
}

function assignDepthSelectionDuration(
	timing: DepthSelectionTimingMetadata,
	key:
		| "recentMessagesMs"
		| "classificationContextMs"
		| "classifierModelResolutionMs"
		| "controlModelClassifierMs",
	value: number | undefined,
): void {
	if (value === undefined || !Number.isFinite(value) || value < 0) return;
	timing[key] = value;
}

function nowDepthSelectionMs(): number {
	return performance.now();
}

function elapsedDepthSelectionMs(startedAt: number): number {
	const elapsedMs = nowDepthSelectionMs() - startedAt;
	return Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
}

type ClassifierLogEntry = {
	source: "deterministic_rules" | "deterministic_fast_path";
	appliedProfile: DepthAppliedProfile;
	attemptCount: number;
	finishReason?: string;
	hadReasoningTokens?: boolean;
	fallbackReason?: string;
	error?: string;
};

function logClassifierResult(entry: ClassifierLogEntry): void {
	const parts = [
		`source=${entry.source}`,
		`profile=${entry.appliedProfile}`,
		`attempts=${entry.attemptCount}`,
	];
	if (entry.finishReason) {
		parts.push(`finish_reason=${entry.finishReason}`);
	}
	if (entry.hadReasoningTokens !== undefined) {
		parts.push(`reasoning_tokens=${entry.hadReasoningTokens}`);
	}
	if (entry.fallbackReason) {
		parts.push(`fallback_reason=${entry.fallbackReason}`);
	}
	if (entry.error) {
		parts.push(`error=${entry.error}`);
	}
	console.log(`[DEPTH_CLASSIFIER] ${parts.join(" ")}`);
}

function runSafeStandardAutoFastPath(request: DepthSelectionTurnInput): {
	appliedProfile: "standard";
	signals: DepthSelectionSignals;
} | null {
	const normalizedMessage = request.normalizedMessage.trim();
	const wordCount = normalizedMessage.split(/\s+/).filter(Boolean).length;
	const hasBlockingTurnState = [
		!normalizedMessage,
		normalizedMessage.length > SIMPLE_AUTO_FAST_PATH_MAX_CHARS,
		wordCount > SIMPLE_AUTO_FAST_PATH_MAX_WORDS,
		Boolean(request.attachmentIds?.length),
		Boolean(request.linkedSources?.length),
		request.forceWebSearch === true,
		Boolean(request.pendingSkill),
	].some(Boolean);
	if (hasBlockingTurnState) return null;
	const blockerMessage =
		removeNegatedExternalResourceDirectives(normalizedMessage);
	if (
		AUTO_FAST_PATH_BLOCKING_PATTERNS.some((pattern) =>
			pattern.test(blockerMessage),
		)
	) {
		return null;
	}

	const keywordResult = runDeterministicKeywordClassifier(normalizedMessage);
	if (keywordResult.appliedProfile !== "standard") return null;
	return {
		appliedProfile: "standard",
		signals: keywordResult.signals,
	};
}

function removeNegatedExternalResourceDirectives(message: string): string {
	return NEGATED_EXTERNAL_RESOURCE_DIRECTIVE_PATTERNS.reduce(
		(next, pattern) => next.replace(pattern, " "),
		message,
	);
}

function runDeterministicRulesClassifier(request: DepthSelectionTurnInput): {
	appliedProfile: DepthAppliedProfile;
	signals: DepthSelectionSignals;
} {
	const normalizedMessage = request.normalizedMessage.trim();
	const classifierMessage =
		removeNegatedExternalResourceDirectives(normalizedMessage).trim() ||
		normalizedMessage;
	const lower = classifierMessage.toLowerCase();
	const wordCount = classifierMessage.split(/\s+/).filter(Boolean).length;
	const keywordResult = runDeterministicKeywordClassifier(classifierMessage);
	const extendedScore = countKeywordMatches(lower, EXTENDED_KEYWORDS);
	const maximumScore = countKeywordMatches(lower, MAXIMUM_KEYWORDS);
	const hasExplicitMaximumRequest = EXPLICIT_MAXIMUM_PATTERNS.some((pattern) =>
		pattern.test(classifierMessage),
	);
	const hasAttachments = Boolean(request.attachmentIds?.length);
	const hasLinkedSources = Boolean(request.linkedSources?.length);
	const hasActiveDocument = Boolean(request.activeDocumentArtifactId);
	const hasContextResources =
		hasAttachments || hasLinkedSources || hasActiveDocument;
	const hasGroundingRequest =
		request.forceWebSearch === true ||
		hasLinkedSources ||
		GROUNDING_PATTERNS.some((pattern) => pattern.test(classifierMessage));
	const requiresGrounding =
		request.forceWebSearch === true ||
		REQUIRED_GROUNDING_PATTERN.test(classifierMessage);

	let appliedProfile = keywordResult.appliedProfile;
	if (hasExplicitMaximumRequest || maximumScore >= 3) {
		appliedProfile = "maximum";
	} else if (
		appliedProfile !== "maximum" &&
		(extendedScore >= 2 ||
			(hasContextResources && extendedScore >= 1) ||
			(Boolean(request.pendingSkill) && wordCount > 12))
	) {
		appliedProfile = "extended";
	} else if (appliedProfile === "maximum") {
		appliedProfile = "extended";
	}

	const groundingNeed = resolveDeterministicGroundingNeed({
		hasContextResources,
		hasGroundingRequest,
		requiresGrounding,
	});
	const contextBreadth = resolveDeterministicContextBreadth({
		appliedProfile,
		extendedScore,
		hasContextResources,
		wordCount,
	});
	const outputRoom = resolveDeterministicOutputRoom({
		appliedProfile,
		extendedScore,
		message: classifierMessage,
		wordCount,
	});
	const toolUse = resolveDeterministicToolUse({
		hasGroundingRequest,
		requiresGrounding,
		message: classifierMessage,
	});

	return {
		appliedProfile,
		signals: {
			groundingNeed,
			contextBreadth,
			outputRoom,
			toolUse,
		},
	};
}

function runDeterministicKeywordClassifier(normalizedMessage: string): {
	appliedProfile: DepthAppliedProfile;
	signals: DepthSelectionSignals;
} {
	const lower = normalizedMessage.toLowerCase();
	const wordCount = normalizedMessage.split(/\s+/).filter(Boolean).length;

	const extendedScore = countKeywordMatches(lower, EXTENDED_KEYWORDS);
	const maximumScore = countKeywordMatches(lower, MAXIMUM_KEYWORDS);

	let appliedProfile: DepthAppliedProfile = "standard";
	let groundingNeed: DepthSelectionSignals["groundingNeed"] = "none";
	let contextBreadth: DepthSelectionSignals["contextBreadth"] = "normal";
	let outputRoom: DepthSelectionSignals["outputRoom"] = "normal";
	const toolUse: DepthSelectionSignals["toolUse"] = "normal";

	if (maximumScore >= 3 || (maximumScore >= 2 && wordCount > 200)) {
		appliedProfile = "maximum";
		groundingNeed = "useful";
		contextBreadth = "broad";
		outputRoom = "expanded";
	} else if (extendedScore >= 2 || (extendedScore >= 1 && wordCount > 100)) {
		appliedProfile = "extended";
		groundingNeed = extendedScore >= 3 ? "useful" : "possible";
		contextBreadth = extendedScore >= 3 ? "broad" : "normal";
		outputRoom = wordCount > 150 ? "expanded" : "normal";
	}

	return {
		appliedProfile,
		signals: { groundingNeed, contextBreadth, outputRoom, toolUse },
	};
}

function resolveDeterministicGroundingNeed(params: {
	hasContextResources: boolean;
	hasGroundingRequest: boolean;
	requiresGrounding: boolean;
}): DepthSelectionSignals["groundingNeed"] {
	if (params.requiresGrounding) return "required";
	if (params.hasGroundingRequest) return "useful";
	if (params.hasContextResources) return "possible";
	return "none";
}

function resolveDeterministicContextBreadth(params: {
	appliedProfile: DepthAppliedProfile;
	extendedScore: number;
	hasContextResources: boolean;
	wordCount: number;
}): DepthSelectionSignals["contextBreadth"] {
	if (
		params.appliedProfile === "maximum" ||
		params.wordCount > 120 ||
		params.extendedScore >= 3 ||
		(params.hasContextResources && params.appliedProfile === "extended")
	) {
		return "broad";
	}
	if (params.hasContextResources) return "normal";
	return "normal";
}

function resolveDeterministicOutputRoom(params: {
	appliedProfile: DepthAppliedProfile;
	extendedScore: number;
	message: string;
	wordCount: number;
}): DepthSelectionSignals["outputRoom"] {
	if (params.appliedProfile === "maximum") return "expanded";
	if (
		params.appliedProfile === "extended" &&
		(params.extendedScore >= 4 ||
			params.wordCount > 120 ||
			EXPANDED_OUTPUT_PATTERN.test(params.message))
	) {
		return "expanded";
	}
	return "normal";
}

function resolveDeterministicToolUse(params: {
	hasGroundingRequest: boolean;
	requiresGrounding: boolean;
	message: string;
}): DepthSelectionSignals["toolUse"] {
	if (
		params.requiresGrounding ||
		(params.hasGroundingRequest &&
			/\b(web search|search|browse|sources?|citations?|cite|current|latest|recent|today)\b/i.test(
				params.message,
			))
	) {
		return "source_heavy";
	}
	return "normal";
}

function countKeywordMatches(lowerMessage: string, keywords: string[]): number {
	let score = 0;
	const matchedKeywords: string[] = [];
	for (const keyword of [...keywords].sort((a, b) => b.length - a.length)) {
		if (!lowerMessage.includes(keyword)) continue;
		if (
			matchedKeywords.some(
				(matched) => matched.includes(keyword) || keyword.includes(matched),
			)
		) {
			continue;
		}
		matchedKeywords.push(keyword);
		score++;
	}
	return score;
}

async function resolveMaxSignals(
	params: ResolveReasoningDepthSelectionParams,
): Promise<DepthSelectionSignals> {
	try {
		const rows = await db
			.select({
				metadataJson: messages.metadataJson,
			})
			.from(messages)
			.where(eq(messages.conversationId, params.conversationId))
			.orderBy(...messageOrderDesc())
			.limit(1);

		const lastRow = rows[0];
		if (lastRow?.metadataJson) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(lastRow.metadataJson);
			} catch (error) {
				console.warn(
					"[DEPTH_CLASSIFIER] Failed to parse previous message metadataJson",
					error,
				);
			}
			if (parsed && typeof parsed === "object") {
				const meta = parsed as Record<string, unknown>;
				const depthMeta = meta.depthMetadata as DepthMetadata | undefined;
				if (
					depthMeta?.signals &&
					(depthMeta.appliedProfile === "extended" ||
						depthMeta.appliedProfile === "maximum")
				) {
					return depthMeta.signals;
				}
			}
		}
	} catch (error) {
		console.warn(
			"[DEPTH_CLASSIFIER] Failed to read previous message depth metadata",
			error,
		);
	}

	return { ...MAX_DEFAULT_SIGNALS };
}
