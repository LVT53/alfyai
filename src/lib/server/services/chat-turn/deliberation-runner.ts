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
	let usage = emptyUsage();
	const constraints: string[] = [];

	for (const passSpec of passPlan) {
		if (params.abortSignal?.aborted) {
			break;
		}
		params.onStatus?.(
			deliberationStatusEntry({
				passSpec,
				status: "running",
				language: params.language,
			}),
		);
		const result = await runDeliberationPass({
			...params,
			passSpec,
			previousBriefs: briefs,
			tools,
		});
		params.onStatus?.(
			deliberationStatusEntry({
				passSpec,
				status: result.constrained ? "error" : "done",
				language: params.language,
			}),
		);
		usage = sumUsage(usage, result.usage);
		if (result.brief) {
			briefs.push(result.brief);
		}
		if (result.constrained) {
			constraints.push(`deliberation_pass_${passSpec.pass}_constrained`);
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
	status: ResponseActivityEntry["status"];
	language: "en" | "hu";
}): ResponseActivityEntry {
	return {
		id: `deliberation-pass-${params.passSpec.pass}`,
		kind: "deliberation",
		status: params.status,
		label: deliberationStatusLabel(params),
		occurredAt: Date.now(),
	};
}

function deliberationStatusLabel(params: {
	passSpec: PlannedDeliberationPass;
	status: ResponseActivityEntry["status"];
	language: "en" | "hu";
}): string {
	return params.passSpec.statusLabels[params.language][params.status];
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

export function appendDeliberationBriefsToInput(
	inputValue: string,
	briefs: NormalChatDeliberationBrief[],
): string {
	if (briefs.length === 0) return inputValue;
	return [
		inputValue,
		"## Normal Chat Deliberation Guidance",
		"Use the following transient review notes silently to improve the final answer. Do not mention the deliberation process unless the user explicitly asks about it.",
		"Treat these notes as private judgment, not as an output format. Answer in natural user-facing prose, bullets, and tables as appropriate; do not emit raw JSON unless the user explicitly requested JSON.",
		"Preserve enough concrete detail, examples, and rationale for a high-quality answer instead of compressing the response into a checklist.",
		"If the notes include viable alternatives, keep the final answer decisive while preserving conditional alternatives, second-best paths, and exit criteria that remain genuinely viable.",
		serializeBriefsForPrompt(briefs),
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
							text: deliberationUserPrompt(params),
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
		"Original prepared prompt context summary:",
		truncate(params.preparedInputValue, 7_000),
		"Previous deliberation brief:",
		serializeBriefsForPrompt(params.previousBriefs),
	].join("\n\n");
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
