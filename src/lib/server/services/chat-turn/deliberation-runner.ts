import type { RuntimeConfig } from "$lib/server/config-store";
import type { ReasoningDepthEffort } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import {
	buildReasoningDepthProviderOptions,
	withReasoningDepthPreparedBudget,
} from "$lib/server/services/chat-turn/reasoning-depth-effort";
import type {
	NormalChatModelRunProvider,
	NormalChatModelRunUsage,
	PlainNormalChatModelRunResult,
} from "$lib/server/services/normal-chat-model";
import { runPlainNormalChatModelRun } from "$lib/server/services/normal-chat-model";
import type { ToolCallRecorder } from "$lib/server/services/normal-chat-tools";
import {
	createNormalChatTools,
	createToolCallRecorder,
} from "$lib/server/services/normal-chat-tools";
import type {
	DepthMetadata,
	ModelId,
	ResponseActivityEntry,
	ToolCallEntry,
} from "$lib/types";
import type { AuthenticatedPromptUser } from "../normal-chat-context";
import {
	type DeliberationPassKind,
	deliberationPassCount,
	type PlannedDeliberationPass,
	planDeliberationPasses,
	selectDeliberationStatusLabel,
	shouldRunDeliberationPasses,
} from "./deliberation-pass-catalogue";

const MAX_LIST_ITEMS = 4;

type EvidenceNeedStatus =
	| "not_needed"
	| "satisfied"
	| "unavailable"
	| "still_needed";

export type DeliberationFirstPassBrief = {
	assumptions: string[];
	userIntent: string;
	missingContextQuestions: string[];
	evidenceNeeds: Array<{
		need: string;
		status: EvidenceNeedStatus;
	}>;
	relevantFindings: string[];
	edgeCases: string[];
	finalAnswerGuidance: string[];
};

export type DeliberationSecondPassBrief = {
	answerRisks: string[];
	contradictionsOrTensions: string[];
	missedUserNeeds: string[];
	formatRequirements: string[];
	mustInclude: string[];
	shouldAvoid: string[];
	finalAnswerGuidance: string[];
};

export type DeliberationGenericPassBrief = {
	focusAreas: string[];
	findings: string[];
	risks: string[];
	openQuestions: string[];
	finalAnswerGuidance: string[];
};

export type DeliberationAlternativesPassBrief = {
	viableAlternatives: string[];
	dismissedAlternatives: string[];
	recommendationBalance: string[];
	exitCriteria: string[];
	finalAnswerGuidance: string[];
};

type GenericDeliberationPassKind = Exclude<
	DeliberationPassKind,
	| "context_source_gap_review"
	| "answer_plan_critique"
	| "viable_alternatives_preservation"
>;

export type DeliberationWorkspaceReport = {
	intent: string;
	mustInclude: string[];
	evidenceNeeds: string[];
	recommendationGuidance: string[];
	viableAlternatives: string[];
	risks: string[];
	languageRequirements: string[];
	finalStyle: string[];
	openQuestions: string[];
};

export type NormalChatDeliberationBrief =
	| {
			pass: number;
			kind: "context_source_gap_review";
			brief: DeliberationFirstPassBrief;
	  }
	| {
			pass: number;
			kind: "answer_plan_critique";
			brief: DeliberationSecondPassBrief;
	  }
	| {
			pass: number;
			kind: GenericDeliberationPassKind;
			brief: DeliberationGenericPassBrief;
	  }
	| {
			pass: number;
			kind: "viable_alternatives_preservation";
			brief: DeliberationAlternativesPassBrief;
	  };

export type NormalChatDeliberationResult = {
	briefs: NormalChatDeliberationBrief[];
	usage: NormalChatModelRunUsage;
	depthMetadata?: DepthMetadata;
	toolCalls: ToolCallEntry[];
};

export type DeliberatedFinalAnswerQualityResult = {
	text: string;
	usage: NormalChatModelRunUsage;
	repaired: boolean;
	issues: string[];
};

export type NormalChatDeliberationParams = {
	userId: string;
	conversationId: string;
	modelId: ModelId;
	runtimeConfig: RuntimeConfig;
	provider: NormalChatModelRunProvider;
	depthEffort: ReasoningDepthEffort | null;
	preparedInputValue: string;
	preparedSystemPrompt: string;
	user?: AuthenticatedPromptUser;
	language: "en" | "hu";
	turnId: string;
	recorder: ToolCallRecorder;
	onStatus?: (entry: ResponseActivityEntry) => void;
	abortSignal?: AbortSignal;
};

type RunPassResult = {
	brief: NormalChatDeliberationBrief | null;
	usage: NormalChatModelRunUsage;
	constrained: boolean;
	degraded?: boolean;
};

export {
	deliberationPassCount,
	planDeliberationPasses,
	shouldRunDeliberationPasses,
};

export async function runNormalChatDeliberationPasses(
	params: NormalChatDeliberationParams,
): Promise<NormalChatDeliberationResult> {
	const passPlan = planDeliberationPasses(params.depthEffort);
	if (passPlan.length === 0 || !params.depthEffort) {
		return {
			briefs: [],
			usage: emptyUsage(),
			depthMetadata: params.depthEffort?.depthMetadata,
			toolCalls: [],
		};
	}

	const deliberationRecorder = createToolCallRecorder();
	const tools = createDeliberationTools({
		...params,
		recorder: deliberationRecorder,
	});
	const briefs: NormalChatDeliberationBrief[] = [];
	let workspaceReport = emptyWorkspaceReport();
	let usage = emptyUsage();
	const constraints: string[] = [];

	for (const passSpec of passPlan) {
		if (params.abortSignal?.aborted) {
			break;
		}
		params.onStatus?.(
			deliberationStatusEntry({
				passSpec,
				passTotal: passPlan.length,
				status: "running",
				language: params.language,
			}),
		);
		const result = await runDeliberationPass({
			...params,
			passSpec,
			previousBriefs: briefs,
			workspaceReport,
			tools,
		});
		params.onStatus?.(
			deliberationStatusEntry({
				passSpec,
				passTotal: passPlan.length,
				status: result.constrained ? "error" : "done",
				language: params.language,
			}),
		);
		usage = sumUsage(usage, result.usage);
		if (result.brief) {
			briefs.push(result.brief);
			workspaceReport = reduceWorkspaceReport(workspaceReport, result.brief);
		}
		if (result.constrained) {
			constraints.push(`deliberation_pass_${passSpec.pass}_constrained`);
		}
		if (result.degraded) {
			constraints.push(`deliberation_pass_${passSpec.pass}_degraded`);
		}
	}

	return {
		briefs,
		usage,
		depthMetadata: withDeliberationMetadata({
			effort: params.depthEffort,
			attemptedPasses: passPlan.length,
			completedPasses: briefs.length,
			constraints,
		}),
		toolCalls: deliberationRecorder.getEntries(),
	};
}

function deliberationStatusEntry(params: {
	passSpec: PlannedDeliberationPass;
	passTotal: number;
	status: ResponseActivityEntry["status"];
	language: "en" | "hu";
}): ResponseActivityEntry {
	const occurredAt = Date.now();
	return {
		id: `deliberation-pass-${params.passSpec.pass}`,
		kind: "deliberation",
		status: params.status,
		label: selectDeliberationStatusLabel({
			passSpec: params.passSpec,
			status: params.status,
			language: params.language,
			seed: occurredAt + params.passSpec.pass * 17,
		}),
		passIndex: params.passSpec.pass,
		passTotal: params.passTotal,
		passKind: params.passSpec.kind,
		occurredAt,
	};
}

function createFocusedWorkspaceBrief(
	passSpec: PlannedDeliberationPass,
	params: Pick<NormalChatDeliberationParams, "preparedInputValue">,
): NormalChatDeliberationBrief {
	const userMessage =
		extractMarkdownSection(params.preparedInputValue, "Current User Message") ??
		params.preparedInputValue;
	const normalizedRequest = normalizeWhitespace(userMessage);
	const salientConstraints = selectSalientSentences(normalizedRequest, [
		"constraint",
		"must",
		"support",
		"avoid",
		"cost",
		"latency",
		"hungarian",
		"gdpr",
		"privacy",
		"citation",
		"evidence",
		"uploaded",
		"document",
		"risk",
		"reliability",
		"failover",
		"switching",
		"criteria",
		"deadline",
		"fastest",
		"duplicate",
	]);
	const edgeCases = selectSalientSentences(normalizedRequest, [
		"risk",
		"avoid",
		"uncertain",
		"privacy",
		"gdpr",
		"hungarian",
		"latency",
		"cost",
		"failover",
		"fabricated",
		"overclaiming",
		"switching",
		"fastest",
		"duplicate",
	]);
	const finalAnswerGuidance = finalAnswerGuidanceFromRequest(normalizedRequest);

	return {
		pass: passSpec.pass,
		kind: "context_source_gap_review",
		brief: {
			assumptions: assumptionsFromRequest(normalizedRequest),
			userIntent: stringValue(normalizedRequest),
			missingContextQuestions: [],
			evidenceNeeds: evidenceNeedsFromRequest(normalizedRequest),
			relevantFindings: salientConstraints,
			edgeCases,
			finalAnswerGuidance,
		},
	};
}

function emptyWorkspaceReport(): DeliberationWorkspaceReport {
	return {
		intent: "",
		mustInclude: [],
		evidenceNeeds: [],
		recommendationGuidance: [],
		viableAlternatives: [],
		risks: [],
		languageRequirements: [],
		finalStyle: [],
		openQuestions: [],
	};
}

function reduceWorkspaceReport(
	current: DeliberationWorkspaceReport,
	entry: NormalChatDeliberationBrief,
): DeliberationWorkspaceReport {
	const next: DeliberationWorkspaceReport = {
		intent: current.intent,
		mustInclude: [...current.mustInclude],
		evidenceNeeds: [...current.evidenceNeeds],
		recommendationGuidance: [...current.recommendationGuidance],
		viableAlternatives: [...current.viableAlternatives],
		risks: [...current.risks],
		languageRequirements: [...current.languageRequirements],
		finalStyle: [...current.finalStyle],
		openQuestions: [...current.openQuestions],
	};

	if (entry.kind === "context_source_gap_review") {
		next.intent = entry.brief.userIntent || next.intent;
		appendUnique(next.mustInclude, entry.brief.relevantFindings);
		appendUnique(
			next.evidenceNeeds,
			entry.brief.evidenceNeeds.map((need) => `${need.need} (${need.status})`),
		);
		appendUnique(next.recommendationGuidance, entry.brief.finalAnswerGuidance);
		appendUnique(next.risks, entry.brief.edgeCases);
		appendUnique(next.openQuestions, entry.brief.missingContextQuestions);
		if (mentionsHungarian(entry.brief.userIntent)) {
			appendUnique(next.languageRequirements, [
				"Hungarian-speaking users must remain first-class.",
			]);
		}
		return trimWorkspaceReport(next);
	}

	if (entry.kind === "answer_plan_critique") {
		appendUnique(next.risks, [
			...entry.brief.answerRisks,
			...entry.brief.contradictionsOrTensions,
		]);
		appendUnique(next.mustInclude, [
			...entry.brief.missedUserNeeds,
			...entry.brief.mustInclude,
		]);
		appendUnique(next.finalStyle, entry.brief.formatRequirements);
		appendUnique(next.recommendationGuidance, entry.brief.finalAnswerGuidance);
		return trimWorkspaceReport(next);
	}

	if (entry.kind === "viable_alternatives_preservation") {
		appendUnique(next.viableAlternatives, entry.brief.viableAlternatives);
		appendUnique(
			next.recommendationGuidance,
			entry.brief.recommendationBalance,
		);
		appendUnique(next.openQuestions, entry.brief.exitCriteria);
		appendUnique(next.finalStyle, entry.brief.finalAnswerGuidance);
		return trimWorkspaceReport(next);
	}

	appendUnique(next.mustInclude, entry.brief.findings);
	appendUnique(next.risks, entry.brief.risks);
	appendUnique(next.openQuestions, entry.brief.openQuestions);
	appendUnique(next.recommendationGuidance, entry.brief.finalAnswerGuidance);
	if (entry.kind === "hungarian_parity_check") {
		appendUnique(next.languageRequirements, entry.brief.findings);
	}
	if (entry.kind === "final_format_style_check") {
		appendUnique(next.finalStyle, entry.brief.findings);
	}
	if (entry.kind === "contradiction_risk_check") {
		appendUnique(next.viableAlternatives, entry.brief.openQuestions);
	}
	return trimWorkspaceReport(next);
}

function trimWorkspaceReport(
	report: DeliberationWorkspaceReport,
): DeliberationWorkspaceReport {
	return {
		intent: report.intent,
		mustInclude: report.mustInclude.slice(0, MAX_LIST_ITEMS),
		evidenceNeeds: report.evidenceNeeds.slice(0, MAX_LIST_ITEMS),
		recommendationGuidance: report.recommendationGuidance.slice(
			0,
			MAX_LIST_ITEMS,
		),
		viableAlternatives: report.viableAlternatives.slice(0, MAX_LIST_ITEMS),
		risks: report.risks.slice(0, MAX_LIST_ITEMS),
		languageRequirements: report.languageRequirements.slice(0, MAX_LIST_ITEMS),
		finalStyle: report.finalStyle.slice(0, MAX_LIST_ITEMS),
		openQuestions: report.openQuestions.slice(0, MAX_LIST_ITEMS),
	};
}

function createMicroCheckBrief(
	passSpec: PlannedDeliberationPass,
	params: Pick<
		NormalChatDeliberationParams,
		"preparedInputValue" | "language"
	> & {
		workspaceReport: DeliberationWorkspaceReport;
	},
): NormalChatDeliberationBrief | null {
	const userMessage =
		extractMarkdownSection(params.preparedInputValue, "Current User Message") ??
		params.preparedInputValue;
	const normalizedRequest = normalizeWhitespace(userMessage);
	const lower = normalizedRequest.toLowerCase();

	if (passSpec.kind === "missed_user_need_check") {
		return genericBrief(passSpec, {
			focusAreas: ["Explicit user requirements"],
			findings: [
				...selectSalientSentences(normalizedRequest, [
					"must",
					"require",
					"recommend",
					"compare",
					"risk",
					"budget",
					"latency",
					"privacy",
					"gdpr",
					"hungarian",
				]),
				...params.workspaceReport.mustInclude,
			],
			risks: [],
			openQuestions: params.workspaceReport.openQuestions,
			finalAnswerGuidance: [
				"Cover every explicit constraint before optimizing style.",
			],
		});
	}

	if (passSpec.kind === "contradiction_risk_check") {
		return genericBrief(passSpec, {
			focusAreas: ["Risks, tensions, and viable second-best paths"],
			findings: selectSalientSentences(normalizedRequest, [
				"risk",
				"avoid",
				"cost",
				"latency",
				"privacy",
				"reliability",
				"gdpr",
				"failover",
				"alternative",
				"second",
				"switch",
			]),
			risks: params.workspaceReport.risks,
			openQuestions:
				lower.includes("alternative") ||
				lower.includes("second") ||
				lower.includes("switch")
					? ["Preserve second-best options and switching criteria."]
					: params.workspaceReport.openQuestions,
			finalAnswerGuidance: [
				"Be decisive while naming material tradeoffs and reversal triggers.",
			],
		});
	}

	if (passSpec.kind === "final_format_style_check") {
		return genericBrief(passSpec, {
			focusAreas: ["Final answer shape"],
			findings: [
				"Answer in natural prose, bullets, or tables; do not emit raw JSON unless requested.",
				"Keep enough concrete rationale to justify the recommendation.",
			],
			risks: ["Over-compressing Max output into a checklist."],
			openQuestions: [],
			finalAnswerGuidance: [
				"Use user-facing language and avoid process narration.",
			],
		});
	}

	if (passSpec.kind === "hungarian_parity_check") {
		if (
			params.language !== "hu" &&
			!mentionsHungarian(normalizedRequest) &&
			params.workspaceReport.languageRequirements.length === 0
		) {
			return genericBrief(passSpec, {
				focusAreas: ["Hungarian parity"],
				findings: [],
				risks: [],
				openQuestions: [],
				finalAnswerGuidance: [],
			});
		}
		return genericBrief(passSpec, {
			focusAreas: ["Hungarian parity"],
			findings: [
				"Treat Hungarian-language users and Hungarian text as first-class constraints.",
				"Call out Hungarian retrieval, morphology, localization, or legal implications when relevant.",
			],
			risks: [
				"Do not silently route Hungarian users through weaker assumptions.",
			],
			openQuestions: [],
			finalAnswerGuidance: [
				"Include Hungarian implications where they affect the recommendation.",
			],
		});
	}

	return null;
}

function genericBrief(
	passSpec: PlannedDeliberationPass,
	brief: DeliberationGenericPassBrief,
): NormalChatDeliberationBrief {
	return {
		pass: passSpec.pass,
		kind: passSpec.kind as GenericDeliberationPassKind,
		brief: {
			focusAreas: brief.focusAreas.slice(0, MAX_LIST_ITEMS),
			findings: brief.findings
				.map(stringValue)
				.filter(Boolean)
				.slice(0, MAX_LIST_ITEMS),
			risks: brief.risks
				.map(stringValue)
				.filter(Boolean)
				.slice(0, MAX_LIST_ITEMS),
			openQuestions: brief.openQuestions
				.map(stringValue)
				.filter(Boolean)
				.slice(0, MAX_LIST_ITEMS),
			finalAnswerGuidance: brief.finalAnswerGuidance
				.map(stringValue)
				.filter(Boolean)
				.slice(0, MAX_LIST_ITEMS),
		},
	};
}

function createAlternativesPreservationBrief(
	passSpec: PlannedDeliberationPass,
	previousBriefs: NormalChatDeliberationBrief[],
): NormalChatDeliberationBrief {
	const viableAlternatives: string[] = [];
	const dismissedAlternatives: string[] = [];
	const recommendationBalance: string[] = [];
	const exitCriteria: string[] = [];
	const finalAnswerGuidance: string[] = [];

	for (const entry of previousBriefs) {
		if (entry.kind === "context_source_gap_review") {
			appendUnique(
				viableAlternatives,
				entry.brief.edgeCases.map((item) => `Preserve if relevant: ${item}`),
			);
			appendUnique(
				exitCriteria,
				entry.brief.evidenceNeeds
					.filter(
						(need) =>
							need.status === "still_needed" || need.status === "unavailable",
					)
					.map((need) => `Qualify or switch if unresolved: ${need.need}`),
			);
			appendUnique(recommendationBalance, entry.brief.finalAnswerGuidance);
			appendUnique(finalAnswerGuidance, entry.brief.finalAnswerGuidance);
			continue;
		}

		if (entry.kind === "answer_plan_critique") {
			appendUnique(viableAlternatives, [
				...entry.brief.contradictionsOrTensions.map(
					(item) => `Keep conditional path visible: ${item}`,
				),
				...entry.brief.missedUserNeeds.map(
					(item) => `Address as a possible valid user need: ${item}`,
				),
			]);
			appendUnique(
				dismissedAlternatives,
				entry.brief.shouldAvoid.map((item) => `Avoid presenting: ${item}`),
			);
			appendUnique(exitCriteria, entry.brief.contradictionsOrTensions);
			appendUnique(recommendationBalance, entry.brief.finalAnswerGuidance);
			appendUnique(finalAnswerGuidance, entry.brief.finalAnswerGuidance);
			continue;
		}

		appendUnique(
			viableAlternatives,
			entry.brief.openQuestions.map(
				(item) => `Keep as conditional until resolved: ${item}`,
			),
		);
		appendUnique(
			dismissedAlternatives,
			entry.brief.risks.map((item) => `Do not treat as default: ${item}`),
		);
		appendUnique(exitCriteria, entry.brief.openQuestions);
		appendUnique(recommendationBalance, entry.brief.finalAnswerGuidance);
		appendUnique(finalAnswerGuidance, entry.brief.finalAnswerGuidance);
	}

	appendUnique(finalAnswerGuidance, [
		"Recommend one path while preserving genuinely viable alternatives.",
		"Name switching criteria when alternatives remain materially plausible.",
	]);
	if (recommendationBalance.length === 0) {
		appendUnique(recommendationBalance, [
			"Be decisive, but do not erase material tradeoffs.",
		]);
	}

	return {
		pass: passSpec.pass,
		kind: "viable_alternatives_preservation",
		brief: {
			viableAlternatives: viableAlternatives.slice(0, MAX_LIST_ITEMS),
			dismissedAlternatives: dismissedAlternatives.slice(0, MAX_LIST_ITEMS),
			recommendationBalance: recommendationBalance.slice(0, MAX_LIST_ITEMS),
			exitCriteria: exitCriteria.slice(0, MAX_LIST_ITEMS),
			finalAnswerGuidance: finalAnswerGuidance.slice(0, MAX_LIST_ITEMS),
		},
	};
}

function appendUnique(target: string[], candidates: string[]) {
	const seen = new Set(target);
	for (const candidate of candidates) {
		const value = stringValue(candidate);
		if (!value || seen.has(value)) continue;
		target.push(value);
		seen.add(value);
		if (target.length >= MAX_LIST_ITEMS) return;
	}
}

function extractMarkdownSection(input: string, title: string): string | null {
	const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = input.match(
		new RegExp(`^## ${escapedTitle}\\n([\\s\\S]*?)(?=^## |$)`, "m"),
	);
	const value = match?.[1]?.trim();
	return value ? value : null;
}

function normalizeWhitespace(value: string): string {
	return value
		.replace(/\r/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function selectSalientSentences(value: string, keywords: string[]): string[] {
	const lowerKeywords = keywords.map((keyword) => keyword.toLowerCase());
	const sentences = splitSentences(value);
	const selected = sentences.filter((sentence) => {
		const lower = sentence.toLowerCase();
		return lowerKeywords.some((keyword) => lower.includes(keyword));
	});
	const source = selected.length > 0 ? selected : sentences;
	return source.map(stringValue).filter(Boolean).slice(0, MAX_LIST_ITEMS);
}

function splitSentences(value: string): string[] {
	return value
		.split(/\n+|(?<=[.!?])\s+|;\s+/)
		.map((part) =>
			part
				.replace(/^[-*]\s+/, "")
				.replace(/^\d+[.)]\s+/, "")
				.trim(),
		)
		.filter((part) => part.length > 0)
		.slice(0, 16);
}

function assumptionsFromRequest(value: string): string[] {
	const assumptions: string[] = [];
	const lower = value.toLowerCase();
	if (lower.includes("do not browse")) {
		assumptions.push(
			"User wants reasoning from existing/general knowledge only.",
		);
	}
	if (lower.includes("recommend") || lower.includes("decide")) {
		assumptions.push("A clear recommendation is expected.");
	}
	if (lower.includes("hungarian")) {
		assumptions.push("Hungarian-language users must remain first-class.");
	}
	if (assumptions.length === 0) {
		assumptions.push("Use the current user request as the primary task scope.");
	}
	return assumptions.slice(0, MAX_LIST_ITEMS);
}

function evidenceNeedsFromRequest(
	value: string,
): DeliberationFirstPassBrief["evidenceNeeds"] {
	const lower = value.toLowerCase();
	if (lower.includes("do not browse")) {
		return [{ need: "External web evidence", status: "not_needed" }];
	}
	const needs: DeliberationFirstPassBrief["evidenceNeeds"] = [];
	if (
		lower.includes("cite") ||
		lower.includes("evidence") ||
		lower.includes("source")
	) {
		needs.push({
			need: "Source-backed support for citation-sensitive claims",
			status: "still_needed",
		});
	}
	if (lower.includes("uploaded") || lower.includes("document")) {
		needs.push({
			need: "Uploaded document content if available in context",
			status: "still_needed",
		});
	}
	if (lower.includes("current") || lower.includes("2026")) {
		needs.push({
			need: "Freshness-sensitive claims should be qualified or verified",
			status: "still_needed",
		});
	}
	return needs.slice(0, MAX_LIST_ITEMS);
}

function finalAnswerGuidanceFromRequest(value: string): string[] {
	const lower = value.toLowerCase();
	const guidance: string[] = [];
	if (lower.includes("recommend") || lower.includes("decide")) {
		guidance.push("Make one clear recommendation.");
	}
	if (
		lower.includes("compare") ||
		lower.includes("alternative") ||
		lower.includes("switching") ||
		lower.includes("criteria")
	) {
		guidance.push("Compare options and preserve switching criteria.");
	}
	if (lower.includes("risk") || lower.includes("avoid")) {
		guidance.push("Name material risks and mitigations without overclaiming.");
	}
	if (lower.includes("hungarian")) {
		guidance.push("Include Hungarian-language implications where relevant.");
	}
	if (guidance.length === 0) {
		guidance.push("Answer directly and qualify uncertainty.");
	}
	return guidance.slice(0, MAX_LIST_ITEMS);
}

function finalAnswerQualityIssues(params: {
	text: string;
	userMessage: string;
	briefs: NormalChatDeliberationBrief[];
}): string[] {
	const issues: string[] = [];
	const answer = params.text.trim();
	const lowerAnswer = answer.toLowerCase();
	const lowerRequest = params.userMessage.toLowerCase();
	const workspaceReport = params.briefs.reduce(
		(report, brief) => reduceWorkspaceReport(report, brief),
		emptyWorkspaceReport(),
	);

	if (
		/^\s*\{[\s\S]*\}\s*$/.test(answer) ||
		lowerAnswer.includes('"recommendation"')
	) {
		issues.push("Answer appears to expose raw JSON or deliberation structure.");
	}
	if (
		/^(i can do that|before i start|which platform|please clarify)/i.test(
			answer,
		)
	) {
		issues.push(
			"Answer asks for clarification even though Max should proceed with reasonable assumptions.",
		);
	}
	if (
		(lowerRequest.includes("alternative") ||
			lowerRequest.includes("second-best") ||
			lowerRequest.includes("second best")) &&
		!/\b(alternative|second[- ]best|fallback|option)\b/i.test(answer)
	) {
		issues.push(
			"Answer should preserve viable alternatives or second-best paths.",
		);
	}
	if (
		(lowerRequest.includes("switching") || lowerRequest.includes("criteria")) &&
		!/\b(criteria|trigger|threshold|switch|when to)\b/i.test(answer)
	) {
		issues.push(
			"Answer should include switching criteria or trigger thresholds.",
		);
	}
	if (
		(mentionsHungarian(lowerRequest) ||
			workspaceReport.languageRequirements.length > 0) &&
		!/\b(hungarian|magyar|hungary)\b/i.test(answer)
	) {
		issues.push("Answer should include Hungarian-language implications.");
	}
	if (
		workspaceReport.risks.length > 0 &&
		!/\b(risk|mitigation|caveat|tradeoff|trade-off)\b/i.test(answer)
	) {
		issues.push(
			"Answer should name material risks, mitigations, or tradeoffs.",
		);
	}
	return issues.slice(0, MAX_LIST_ITEMS);
}

function mentionsHungarian(value: string): boolean {
	if (/\b(hungarian|magyar|hungary|magyarorsz[aá]g|magyarul|magyar nyelv)\b/i.test(value)) {
		return true;
	}
	// Hungarian-language input itself is a Hungarian signal —
	// detect via multiple Hungarian diacritics or common function words
	// Weight Hungarian-specific double acutes (ő, ű) more heavily to avoid
	// false positives from French/Spanish/German shared diacritics.
	const doubleAcutes = (value.match(/[őű]/gi) ?? []).length * 2;
	const otherDiacritics = (value.match(/[áéíóöúü]/gi) ?? []).length;
	const hungarianScore = doubleAcutes + otherDiacritics;
	if (hungarianScore >= 4) return true;
	return /\b(és|hogy|mert|akkor|kell|lehet|szeretnék|kérlek|tudsz|tudod)\b/i.test(value);
}

export function appendDeliberationBriefsToInput(
	inputValue: string,
	briefs: NormalChatDeliberationBrief[],
): string {
	if (briefs.length === 0) return inputValue;
	const workspaceReport = briefs.reduce(
		(report, brief) => reduceWorkspaceReport(report, brief),
		emptyWorkspaceReport(),
	);
	return [
		inputValue,
		"## Normal Chat Deliberation Guidance",
		"Use the following transient review notes silently to improve the final answer. Do not mention the deliberation process unless the user explicitly asks about it.",
		"Treat these notes as private judgment, not as an output format. Answer in natural user-facing prose, bullets, and tables as appropriate; do not emit raw JSON unless the user explicitly requested JSON.",
		"Preserve enough concrete detail, examples, and rationale for a high-quality answer instead of compressing the response into a checklist.",
		"If the notes include viable alternatives, keep the final answer decisive while preserving conditional alternatives, second-best paths, and exit criteria that remain genuinely viable.",
		serializeWorkspaceReport(workspaceReport),
	].join("\n\n");
}

export function sumUsage(
	left: NormalChatModelRunUsage,
	right: NormalChatModelRunUsage,
): NormalChatModelRunUsage {
	return {
		inputTokens: sumOptional(left.inputTokens, right.inputTokens),
		outputTokens: sumOptional(left.outputTokens, right.outputTokens),
		totalTokens: sumOptional(left.totalTokens, right.totalTokens),
	};
}

export async function verifyAndRepairDeliberatedFinalAnswer(params: {
	text: string;
	originalUserMessage: string;
	systemPrompt: string;
	briefs: NormalChatDeliberationBrief[];
	provider: NormalChatModelRunProvider;
	modelId: ModelId;
	runtimeConfig: RuntimeConfig;
	depthEffort: ReasoningDepthEffort | null;
	abortSignal?: AbortSignal;
}): Promise<DeliberatedFinalAnswerQualityResult> {
	if (!params.depthEffort || params.briefs.length === 0) {
		return {
			text: params.text,
			usage: emptyUsage(),
			repaired: false,
			issues: [],
		};
	}
	const issues = finalAnswerQualityIssues({
		text: params.text,
		userMessage: params.originalUserMessage,
		briefs: params.briefs,
	});
	if (issues.length === 0) {
		return {
			text: params.text,
			usage: emptyUsage(),
			repaired: false,
			issues,
		};
	}

	let result: PlainNormalChatModelRunResult;
	try {
		result = await runPlainNormalChatModelRun({
			provider: params.provider,
			modelId: params.modelId,
			runtimeConfig: params.runtimeConfig,
			system: [
				params.systemPrompt,
				"You are repairing a completed Max-depth answer. Keep the user's requested substance, but fix only the listed quality issues. Return the revised final answer only.",
			].join("\n\n"),
			resolveProviderOptions: (attemptProvider) =>
				buildReasoningDepthProviderOptions(attemptProvider, params.depthEffort),
			abortSignal: params.abortSignal,
			maxOutputTokens: 4_000,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: [
								"Original user message:",
								params.originalUserMessage,
								"Quality issues to fix:",
								issues.map((issue) => `- ${issue}`).join("\n"),
								"Private deliberation guidance:",
								serializeWorkspaceReport(
									params.briefs.reduce(
										(report, brief) => reduceWorkspaceReport(report, brief),
										emptyWorkspaceReport(),
									),
								),
								"Current answer:",
								params.text,
							].join("\n\n"),
						},
					],
				},
			],
		});
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw error;
		}
		return {
			text: params.text,
			usage: emptyUsage(),
			repaired: false,
			issues,
		};
	}

	const repairedText = result.text.trim();
	return {
		text: repairedText || params.text,
		usage: result.usage,
		repaired: Boolean(repairedText),
		issues,
	};
}

function sumOptional(
	left: number | undefined,
	right: number | undefined,
): number | undefined {
	if (typeof left !== "number" && typeof right !== "number") return undefined;
	return (left ?? 0) + (right ?? 0);
}

function emptyUsage(): NormalChatModelRunUsage {
	return {
		inputTokens: undefined,
		outputTokens: undefined,
		totalTokens: undefined,
	};
}

function createDeliberationTools(
	params: NormalChatDeliberationParams & { recorder: ToolCallRecorder },
) {
	const normalChatTools = createNormalChatTools({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId: `${params.turnId}:deliberation`,
		recorder: params.recorder,
		language: params.language,
		...(params.depthEffort
			? { webSourceBudget: params.depthEffort.webSourceBudget }
			: {}),
	});
	const { research_web, memory_context } = normalChatTools.tools;
	return { research_web, memory_context };
}

async function runDeliberationPass(
	params: NormalChatDeliberationParams & {
		passSpec: PlannedDeliberationPass;
		previousBriefs: NormalChatDeliberationBrief[];
		workspaceReport: DeliberationWorkspaceReport;
		tools: ReturnType<typeof createDeliberationTools>;
	},
): Promise<RunPassResult> {
	if (params.passSpec.kind === "context_source_gap_review") {
		return {
			brief: createFocusedWorkspaceBrief(params.passSpec, params),
			usage: emptyUsage(),
			constrained: false,
		};
	}

	if (params.passSpec.kind === "viable_alternatives_preservation") {
		return {
			brief: createAlternativesPreservationBrief(
				params.passSpec,
				params.previousBriefs,
			),
			usage: emptyUsage(),
			constrained: false,
		};
	}

	const microBrief = createMicroCheckBrief(params.passSpec, params);
	if (microBrief) {
		return {
			brief: microBrief,
			usage: emptyUsage(),
			constrained: false,
		};
	}

	const promptText = deliberationUserPrompt(params);
	if (shouldDegradePassBeforeModelCall(params.passSpec, promptText, params)) {
		return {
			brief: createDegradedModelPassBrief(params.passSpec, params),
			usage: emptyUsage(),
			constrained: false,
			degraded: true,
		};
	}

	let result: PlainNormalChatModelRunResult;
	try {
		result = await runPlainNormalChatModelRun({
			provider: params.provider,
			modelId: params.modelId,
			runtimeConfig: params.runtimeConfig,
			system: deliberationSystemPrompt(params.passSpec),
			resolveProviderOptions: (attemptProvider) =>
				params.depthEffort && params.passSpec.useDepthProviderOptions
					? buildReasoningDepthProviderOptions(
							attemptProvider,
							params.depthEffort,
						)
					: undefined,
			abortSignal: params.abortSignal,
			maxOutputTokens: params.passSpec.maxOutputTokens,
			tools: params.passSpec.maxToolSteps > 0 ? params.tools : undefined,
			maxToolSteps:
				params.passSpec.maxToolSteps > 0
					? Math.min(
							params.depthEffort?.maxToolSteps ?? params.passSpec.maxToolSteps,
							params.passSpec.maxToolSteps,
						)
					: undefined,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: promptText,
						},
					],
				},
			],
		});
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw error;
		}
		return {
			brief: null,
			usage: emptyUsage(),
			constrained: true,
		};
	}

	const parsed = parseBrief(params.passSpec, result.text);
	if (parsed) {
		return {
			brief: parsed,
			usage: result.usage,
			constrained: false,
		};
	}

	const repaired = await repairDeliberationBrief({
		...params,
		rawText: result.text,
	});
	return {
		brief: repaired.brief,
		usage: sumUsage(result.usage, repaired.usage),
		constrained: repaired.brief === null,
	};
}

async function repairDeliberationBrief(
	params: NormalChatDeliberationParams & {
		passSpec: PlannedDeliberationPass;
		rawText: string;
	},
): Promise<{
	brief: NormalChatDeliberationBrief | null;
	usage: NormalChatModelRunUsage;
}> {
	let result: PlainNormalChatModelRunResult;
	try {
		result = await runPlainNormalChatModelRun({
			provider: params.provider,
			modelId: params.modelId,
			runtimeConfig: params.runtimeConfig,
			system:
				"Repair the provided deliberation output into valid compact JSON only. Do not add new facts, chain-of-thought, markdown, or commentary.",
			resolveProviderOptions: (attemptProvider) =>
				params.depthEffort && params.passSpec.useDepthProviderOptions
					? buildReasoningDepthProviderOptions(
							attemptProvider,
							params.depthEffort,
						)
					: undefined,
			abortSignal: params.abortSignal,
			maxOutputTokens: params.passSpec.repairMaxOutputTokens,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: [
								`Expected schema for pass ${params.passSpec.pass}:`,
								JSON.stringify(schemaShape(params.passSpec)),
								"Raw output:",
								params.rawText,
							].join("\n\n"),
						},
					],
				},
			],
		});
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw error;
		}
		return { brief: null, usage: emptyUsage() };
	}
	return {
		brief: parseBrief(params.passSpec, result.text),
		usage: result.usage,
	};
}

function deliberationSystemPrompt(passSpec: PlannedDeliberationPass): string {
	const shared = [
		"You are running a bounded Normal Chat deliberation pass before the final answer.",
		"Return only valid JSON matching the requested schema.",
		"Do not reveal chain-of-thought, hidden scratchpad, or private reasoning.",
		"Use read-only tools only when they materially help inspect memory, current web evidence, or selected context.",
		"Keep the JSON compact: each array has at most 4 short strings, each string is at most 18 words, and empty arrays are better than filler.",
	];
	return [...shared, passSpec.systemFocusInstruction].join("\n");
}

function deliberationUserPrompt(
	params: NormalChatDeliberationParams & {
		passSpec: PlannedDeliberationPass;
		previousBriefs: NormalChatDeliberationBrief[];
		workspaceReport: DeliberationWorkspaceReport;
	},
): string {
	const schema = schemaShape(params.passSpec);
	const context = deliberationContextForPass(params);
	return [
		`Deliberation pass ${params.passSpec.pass}: ${params.passSpec.kind}`,
		"Return JSON only using this schema shape:",
		JSON.stringify(schema),
		"Your response must begin with { and end with }. Do not include markdown, headings, commentary, or final-answer prose.",
		"Prepared system instruction summary:",
		truncate(params.preparedSystemPrompt, 2_000),
		"Deliberation context:",
		context,
	].join("\n\n");
}

function deliberationContextForPass(
	params: NormalChatDeliberationParams & {
		passSpec: PlannedDeliberationPass;
		previousBriefs: NormalChatDeliberationBrief[];
		workspaceReport: DeliberationWorkspaceReport;
	},
): string {
	if (params.passSpec.schema === "first_pass") return params.preparedInputValue;
	if (params.passSpec.schema === "alternatives_preservation") {
		return [
			"Original prepared prompt context summary:",
			truncate(params.preparedInputValue, 3_000),
			"Previous deliberation briefs:",
			serializeBriefsForPrompt(params.previousBriefs),
			"Task:",
			"Identify still-viable alternatives and exit criteria only. Do not produce the final answer.",
		].join("\n\n");
	}
	return [
		"Focused workspace report:",
		serializeWorkspaceReport(params.workspaceReport),
		"Original prepared prompt context summary:",
		truncate(params.preparedInputValue, 3_000),
	].join("\n\n");
}

function shouldDegradePassBeforeModelCall(
	passSpec: PlannedDeliberationPass,
	promptText: string,
	_params: Pick<NormalChatDeliberationParams, "preparedInputValue"> & {
		workspaceReport: DeliberationWorkspaceReport;
	},
): boolean {
	if (passSpec.maxToolSteps === 0) return true;
	const outputAllowance = passSpec.maxOutputTokens * 4;
	const promptAllowance = Math.max(6_000, outputAllowance * 2);
	return promptText.length > promptAllowance;
}

function createDegradedModelPassBrief(
	passSpec: PlannedDeliberationPass,
	params: Pick<NormalChatDeliberationParams, "preparedInputValue"> & {
		workspaceReport: DeliberationWorkspaceReport;
	},
): NormalChatDeliberationBrief {
	return genericBrief(passSpec, {
		focusAreas: [`${passSpec.kind} degraded to compact workspace check`],
		findings: params.workspaceReport.mustInclude,
		risks: params.workspaceReport.risks,
		openQuestions: params.workspaceReport.openQuestions,
		finalAnswerGuidance: [
			...params.workspaceReport.recommendationGuidance,
			"Do not invent missing evidence; qualify gaps from the focused workspace.",
		],
	});
}

function serializeWorkspaceReport(report: DeliberationWorkspaceReport): string {
	const lines = [];
	if (report.intent) lines.push(`- intent: ${report.intent}`);
	for (const [label, values] of [
		["must include", report.mustInclude],
		["evidence needs", report.evidenceNeeds],
		["recommendation guidance", report.recommendationGuidance],
		["viable alternatives", report.viableAlternatives],
		["risks", report.risks],
		["language requirements", report.languageRequirements],
		["final style", report.finalStyle],
		["open questions", report.openQuestions],
	] as const) {
		if (values.length > 0) lines.push(`- ${label}: ${values.join("; ")}`);
	}
	return lines.length > 0 ? lines.join("\n") : "- no focused report yet";
}

function schemaShape(passSpec: PlannedDeliberationPass) {
	if (passSpec.schema === "first_pass") return firstPassSchemaShape();
	if (passSpec.schema === "second_pass") return secondPassSchemaShape();
	if (passSpec.schema === "alternatives_preservation") {
		return alternativesPreservationSchemaShape();
	}
	return genericPassSchemaShape();
}

function firstPassSchemaShape() {
	return {
		assumptions: ["string"],
		userIntent: "string",
		missingContextQuestions: ["string"],
		evidenceNeeds: [
			{
				need: "string",
				status: "not_needed|satisfied|unavailable|still_needed",
			},
		],
		relevantFindings: ["string"],
		edgeCases: ["string"],
		finalAnswerGuidance: ["string"],
	};
}

function secondPassSchemaShape() {
	return {
		answerRisks: ["string"],
		contradictionsOrTensions: ["string"],
		missedUserNeeds: ["string"],
		formatRequirements: ["string"],
		mustInclude: ["string"],
		shouldAvoid: ["string"],
		finalAnswerGuidance: ["string"],
	};
}

function genericPassSchemaShape() {
	return {
		focusAreas: ["string"],
		findings: ["string"],
		risks: ["string"],
		openQuestions: ["string"],
		finalAnswerGuidance: ["string"],
	};
}

function alternativesPreservationSchemaShape() {
	return {
		viableAlternatives: ["string"],
		dismissedAlternatives: ["string"],
		recommendationBalance: ["string"],
		exitCriteria: ["string"],
		finalAnswerGuidance: ["string"],
	};
}

function parseBrief(
	passSpec: PlannedDeliberationPass,
	text: string,
): NormalChatDeliberationBrief | null {
	const parsed = parseJsonObject(text);
	if (!parsed) return null;
	if (passSpec.schema === "first_pass") {
		return {
			pass: passSpec.pass,
			kind: "context_source_gap_review",
			brief: normalizeFirstPassBrief(parsed),
		};
	}
	if (passSpec.schema === "generic_brief") {
		return {
			pass: passSpec.pass,
			kind: passSpec.kind as GenericDeliberationPassKind,
			brief: normalizeGenericPassBrief(parsed),
		};
	}
	if (passSpec.schema === "alternatives_preservation") {
		return {
			pass: passSpec.pass,
			kind: "viable_alternatives_preservation",
			brief: normalizeAlternativesPassBrief(parsed),
		};
	}
	return {
		pass: passSpec.pass,
		kind: "answer_plan_critique",
		brief: normalizeSecondPassBrief(parsed),
	};
}

function parseJsonObject(text: string): Record<string, unknown> | null {
	const trimmed = text.trim();
	const direct = tryParseObject(trimmed);
	if (direct) return direct;
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
	if (fenced) {
		const parsed = tryParseObject(fenced.trim());
		if (parsed) return parsed;
	}
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) {
		return tryParseObject(trimmed.slice(start, end + 1));
	}
	return null;
}

function tryParseObject(value: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		return null;
	}
	return null;
}

function normalizeFirstPassBrief(
	value: Record<string, unknown>,
): DeliberationFirstPassBrief {
	return {
		assumptions: stringList(value.assumptions),
		userIntent: stringValue(value.userIntent),
		missingContextQuestions: stringList(value.missingContextQuestions),
		evidenceNeeds: evidenceNeeds(value.evidenceNeeds),
		relevantFindings: stringList(value.relevantFindings),
		edgeCases: stringList(value.edgeCases),
		finalAnswerGuidance: stringList(value.finalAnswerGuidance),
	};
}

function normalizeSecondPassBrief(
	value: Record<string, unknown>,
): DeliberationSecondPassBrief {
	return {
		answerRisks: stringList(value.answerRisks),
		contradictionsOrTensions: stringList(value.contradictionsOrTensions),
		missedUserNeeds: stringList(value.missedUserNeeds),
		formatRequirements: stringList(value.formatRequirements),
		mustInclude: stringList(value.mustInclude),
		shouldAvoid: stringList(value.shouldAvoid),
		finalAnswerGuidance: stringList(value.finalAnswerGuidance),
	};
}

function normalizeGenericPassBrief(
	value: Record<string, unknown>,
): DeliberationGenericPassBrief {
	return {
		focusAreas: stringList(value.focusAreas),
		findings: stringList(value.findings),
		risks: stringList(value.risks),
		openQuestions: stringList(value.openQuestions),
		finalAnswerGuidance: stringList(value.finalAnswerGuidance),
	};
}

function normalizeAlternativesPassBrief(
	value: Record<string, unknown>,
): DeliberationAlternativesPassBrief {
	return {
		viableAlternatives: stringListFrom(value, [
			"viableAlternatives",
			"viable_alternatives",
			"alternatives",
		]),
		dismissedAlternatives: stringListFrom(value, [
			"dismissedAlternatives",
			"dismissed_alternatives",
			"nonViableAlternatives",
			"non_viable_alternatives",
		]),
		recommendationBalance: stringListFrom(value, [
			"recommendationBalance",
			"recommendation_balance",
			"balance",
		]),
		exitCriteria: stringListFrom(value, [
			"exitCriteria",
			"exit_criteria",
			"switchCriteria",
			"switch_criteria",
		]),
		finalAnswerGuidance: stringListFrom(value, [
			"finalAnswerGuidance",
			"final_answer_guidance",
			"guidance",
		]),
	};
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim().slice(0, 300) : "";
}

function stringListFrom(
	value: Record<string, unknown>,
	keys: string[],
): string[] {
	for (const key of keys) {
		const list = stringList(value[key]);
		if (list.length > 0) return list;
	}
	return [];
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(stringValue).filter(Boolean).slice(0, MAX_LIST_ITEMS);
}

function evidenceNeeds(
	value: unknown,
): DeliberationFirstPassBrief["evidenceNeeds"] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				return null;
			}
			const record = entry as Record<string, unknown>;
			const need = stringValue(record.need);
			if (!need) return null;
			const status = evidenceStatus(record.status);
			return { need, status };
		})
		.filter(
			(
				entry,
			): entry is {
				need: string;
				status: EvidenceNeedStatus;
			} => Boolean(entry),
		)
		.slice(0, MAX_LIST_ITEMS);
}

function evidenceStatus(value: unknown): EvidenceNeedStatus {
	if (
		value === "not_needed" ||
		value === "satisfied" ||
		value === "unavailable" ||
		value === "still_needed"
	) {
		return value;
	}
	return "still_needed";
}

function serializeBriefsForPrompt(
	briefs: NormalChatDeliberationBrief[],
): string {
	return briefs
		.map((entry) => {
			const lines = [`Pass ${entry.pass}: ${entry.kind}`];
			for (const [key, value] of Object.entries(entry.brief)) {
				const serialized = serializeBriefValue(value);
				if (serialized) lines.push(`- ${humanizeBriefKey(key)}: ${serialized}`);
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

function serializeBriefValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const parts = value
		.map((item) => {
			if (typeof item === "string") return item;
			if (!item || typeof item !== "object" || Array.isArray(item)) return "";
			const record = item as Record<string, unknown>;
			if (typeof record.need === "string") {
				return `${record.need} (${String(record.status ?? "still_needed")})`;
			}
			return "";
		})
		.filter(Boolean);
	return parts.join("; ");
}

function humanizeBriefKey(key: string): string {
	return key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function withDeliberationMetadata(params: {
	effort: ReasoningDepthEffort;
	attemptedPasses: number;
	completedPasses: number;
	constraints: string[];
}): ReasoningDepthEffort["depthMetadata"] {
	const base = withReasoningDepthPreparedBudget(params.effort);
	const appliedEffort = base.appliedEffort;
	if (!appliedEffort) return base;
	const constraints = mergeUnique(
		appliedEffort.constraints,
		params.constraints,
	);
	return {
		...base,
		...(params.completedPasses < params.attemptedPasses
			? {
					fallback: true,
					fallbackReason: "deliberation_constrained",
				}
			: {}),
		appliedEffort: {
			...appliedEffort,
			dimensions: mergeUnique(appliedEffort.dimensions, [
				"deliberation_passes",
			]),
			...(constraints.length > 0 ? { constraints } : {}),
		},
	};
}

function mergeUnique(
	left: string[] | undefined,
	right: string[] | undefined,
): string[] {
	return Array.from(new Set([...(left ?? []), ...(right ?? [])]));
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n[truncated]`;
}
