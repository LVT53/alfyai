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

const MAX_LIST_ITEMS = 6;

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

type GenericDeliberationPassKind = Exclude<
	DeliberationPassKind,
	"context_source_gap_review" | "answer_plan_critique"
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

export function appendDeliberationBriefsToInput(
	inputValue: string,
	briefs: NormalChatDeliberationBrief[],
): string {
	if (briefs.length === 0) return inputValue;
	return [
		inputValue,
		"## Normal Chat Deliberation Guidance",
		"Use the following transient review notes silently to improve the final answer. Do not mention the deliberation process unless the user explicitly asks about it.",
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
	let result: PlainNormalChatModelRunResult;
	try {
		result = await runPlainNormalChatModelRun({
			provider: params.provider,
			modelId: params.modelId,
			runtimeConfig: params.runtimeConfig,
			system: deliberationSystemPrompt(params.passSpec),
			resolveProviderOptions: (attemptProvider) =>
				params.depthEffort
					? buildReasoningDepthProviderOptions(
							attemptProvider,
							params.depthEffort,
						)
					: undefined,
			abortSignal: params.abortSignal,
			maxOutputTokens: params.passSpec.maxOutputTokens,
			tools: params.tools,
			maxToolSteps: Math.min(
				params.depthEffort?.maxToolSteps ?? params.passSpec.maxToolSteps,
				params.passSpec.maxToolSteps,
			),
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
				params.depthEffort
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
		"Keep every list short. Empty arrays are better than filler.",
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
	const context =
		params.passSpec.schema === "first_pass"
			? params.preparedInputValue
			: [
					"Original prepared prompt context summary:",
					truncate(params.preparedInputValue, 7_000),
					"Previous deliberation brief:",
					serializeBriefsForPrompt(params.previousBriefs),
				].join("\n\n");
	return [
		`Deliberation pass ${params.passSpec.pass}: ${params.passSpec.kind}`,
		"Return JSON only using this schema shape:",
		JSON.stringify(schema),
		"Prepared system instruction summary:",
		truncate(params.preparedSystemPrompt, 2_000),
		"Deliberation context:",
		context,
	].join("\n\n");
}

function schemaShape(passSpec: PlannedDeliberationPass) {
	if (passSpec.schema === "first_pass") return firstPassSchemaShape();
	if (passSpec.schema === "second_pass") return secondPassSchemaShape();
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

function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim().slice(0, 500) : "";
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
	return JSON.stringify(briefs, null, 2);
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
