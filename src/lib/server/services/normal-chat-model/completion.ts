import {
	generateText,
	type JSONValue,
	type LanguageModel,
	type ModelMessage,
	type OnStepFinishEvent,
	type PrepareStepFunction,
	streamText,
	type TextStreamPart,
	type ToolResultPart,
	type ToolSet,
} from "ai";
import { hasVisibleCharacter } from "$lib/services/stream-protocol";
import { ASK_USER_TOOL_NAME, isAskPauseOutput } from "$lib/shared/ask-user";
import type {
	NormalChatAttemptUsage,
	NormalChatCompletion,
	NormalChatExecutionState,
	NormalChatStopCause,
} from "$lib/shared/normal-chat-completion";
import {
	type NormalChatOutputEvent,
	type NormalChatOutputPhase,
	type NormalChatOutputScope,
	projectNormalChatOutput,
	sanitizeNormalChatAnswer,
} from "$lib/shared/normal-chat-output";
import { estimateTokenCount } from "$lib/utils/tokens";
import { estimateHistoryMessagesTokens } from "../chat-turn/conversation-history";
import {
	providerCanSeeImages,
	providerRunsLocally,
} from "../vision/provider-vision";
import {
	buildVisionPrepareStep,
	type StepImageEntry,
} from "../vision/step-images";
import { buildStepImagesMessage, stripImageParts } from "../vision/turn-images";
import { buildCompletionTools } from "./completion-tools";
import { CONTEXT_GUARD_MARGIN_TOKENS } from "./context-guard";
import { cloneNormalChatContextValue } from "./continuation-codec";
import type {
	NormalChatModelRunModelMetadata,
	NormalChatModelRunUsage,
	PlainNormalChatModelRunParams,
	PlainNormalChatModelRunResult,
	StreamingNormalChatModelRunEvent,
	StreamingNormalChatModelRunParams,
} from "./index";
import { resolveModelCallSampling } from "./sampling";

export type NormalChatExecution = {
	executionId: string;
	turnId: string;
	segmentId: string;
	attemptId: string;
	stepId: string;
	callId: string;
	toolName: string;
	input: unknown;
	state: NormalChatExecutionState;
	providerExecuted: boolean;
	preliminary: boolean;
	output?: unknown;
	modelOutput?: ToolResultPart["output"];
	providerOptions?: ToolResultPart["providerOptions"];
	delivered?: boolean;
};
export type NormalChatContinuationStep = {
	segmentId: string;
	attemptId: string;
	stepId: string;
	phase: NormalChatOutputPhase;
	response: ModelMessage[];
	finished: boolean;
	toolAttempted: boolean;
	finishReason: string | null;
	/** Canonical insert boundary, BEFORE destination projection; never fetch these again. */
	inserts: ModelMessage[];
	imageEntries: StepImageEntry[];
	/** Actual outbound observations are evidence, never a replacement for canonical inputs. */
	observedInput?: {
		providerId: string;
		system?: string;
		messages: ModelMessage[];
	};
};
export type NormalChatContinuationSnapshot = {
	version: 1;
	fidelity: "exact";
	turnId: string;
	segmentId: string;
	original: {
		providerId: string;
		providerBaseUrl: string;
		modelName: string;
		provenance?: unknown;
		system?: string;
		messages: ModelMessage[];
	};
	steps: NormalChatContinuationStep[];
	prepared: {
		maxOutputTokens: number | null;
		providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
	};
	pendingImageEntries: StepImageEntry[];
	executions: NormalChatExecution[];
	events: NormalChatOutputEvent[];
	usage: NormalChatAttemptUsage[];
	sequence: number;
	nextAttempt: number;
	workingSteps: number;
	closingSegments: string[];
	deadlineAt: number;
	totalTimeoutMs: number;
	completion?: NormalChatCompletion;
};
export type NormalChatCompletionPolicy = {
	turnId: string;
	segmentId: string;
	deadlineAt: number;
	totalTimeoutMs: number;
	/** Canonical source/privacy boundaries owned by chat-turn, before any flattening. */
	contextProvenance?: unknown;
	continuation?: NormalChatContinuationSnapshot;
	continuationKind?: "automatic" | "user_resume";
	onOutputEvent?: (event: NormalChatOutputEvent) => void;
	onSnapshot?: (snapshot: NormalChatContinuationSnapshot) => void;
	/** One adapter bound to the effective provider/model; called by Model Run, never by recovery callers. */
	forAttempt?: (context: {
		provider: PlainNormalChatModelRunParams["provider"];
		modelId: string;
		phase: NormalChatOutputPhase;
		attemptId: string;
		toolsAllowed: boolean;
		snapshot: Readonly<NormalChatContinuationSnapshot>;
	}) =>
		| NormalChatAttemptPolicy
		| null
		| Promise<NormalChatAttemptPolicy | null>;
	/** Only an explicitly owned abort cause distinguishes request deadline from a person stopping. */
	abortCause?: () => "user_stop" | "deadline" | "transport_error";
};
export type NormalChatAttemptPolicy = {
	/** Omit only when retaining initial tools on the SAME effective model. Explicitly undefined disables tools. */
	tools?: ToolSet;
	/** Existing recorder/envelope facts, not prose or tool-name guesses. Unknown defaults uncertain. */
	classifyExecution?: (
		execution: Readonly<NormalChatExecution>,
		result: { success: boolean; output?: unknown; error?: unknown },
	) => "succeeded" | "definitely_not_executed" | "uncertain";
	/** Real delivering operation ownership; later calls invalidate a previous delivery. */
	isDelivery?: (execution: Readonly<NormalChatExecution>) => boolean;
	/** Required for a resumed segment with prior operations; new call IDs prove nothing. */
	authorizeExecution?: (
		proposal: Readonly<NormalChatExecution>,
		prior: readonly NormalChatExecution[],
	) =>
		| { kind: "new" }
		| { kind: "reuse"; executionId: string }
		| { kind: "refuse" };
	/** Whole-context policy after step-local vision projection; lossless canonical inputs remain in snapshot. Null fails closed. */
	projectContext?: (input: {
		snapshot: Readonly<NormalChatContinuationSnapshot>;
		system?: string;
		messages: ModelMessage[];
		provider: PlainNormalChatModelRunParams["provider"];
	}) => { system?: string; messages: ModelMessage[] } | null;
};
type Params = (
	| PlainNormalChatModelRunParams
	| StreamingNormalChatModelRunParams
) & { completionPolicy: NormalChatCompletionPolicy };
export type NormalChatCompletionDependencies = {
	model: LanguageModel;
	maxModelContext?: number;
	providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
	stopWhen: Parameters<typeof generateText>[0]["stopWhen"];
	validateTools?: (tools: ToolSet | undefined) => void;
	firstOutputTimeoutMs?: () => Promise<number | null>;
	metadata: (responseModel: string) => NormalChatModelRunModelMetadata;
	mapUsage: (
		usage: OnStepFinishEvent<ToolSet>["usage"],
		metadata?: unknown,
	) => NormalChatModelRunUsage;
	fallback?: (error: unknown) => Promise<{
		provider: Params["provider"];
		modelId: Params["modelId"];
		dependencies: NormalChatCompletionDependencies;
	} | null>;
};
const closingInstruction =
	"Complete the original request using the evidence and working text already present. Preserve useful completed subanswers. Do not repeat already committed answer parts. Tools are unavailable. State unresolved limitations honestly.";
class CompletionExit extends Error {
	constructor(readonly causeCode: NormalChatStopCause) {
		super(causeCode);
	}
}
function cause(reason: string | null): NormalChatStopCause {
	if (reason === "stop") return "natural_stop";
	if (reason === "length") return "length";
	if (reason === "content-filter") return "content_filter";
	return "stream_end";
}
function clone<T>(value: T): T {
	return cloneNormalChatContextValue(value);
}

/** One engine for plain and streaming. The legacy API enters this ONLY with completionPolicy. */
export async function* runNormalChatCompletion(
	params: Params,
	deps: NormalChatCompletionDependencies,
	streaming: boolean,
): AsyncGenerator<
	StreamingNormalChatModelRunEvent,
	PlainNormalChatModelRunResult
> {
	params = {
		...params,
		maxOutputTokens: params.maxOutputTokens ?? params.provider.maxOutputTokens,
	};
	const policy = params.completionPolicy;
	const selectedProvider = params.provider;
	let attemptPolicy: NormalChatAttemptPolicy = {};
	const snapshot: NormalChatContinuationSnapshot = policy.continuation
		? clone(policy.continuation)
		: {
				version: 1,
				fidelity: "exact",
				turnId: policy.turnId,
				segmentId: policy.segmentId,
				original: {
					providerId: params.provider.id,
					providerBaseUrl: params.provider.baseUrl,
					modelName: params.provider.modelName,
					provenance: clone(policy.contextProvenance),
					system: params.system,
					messages: clone(params.messages),
				},
				steps: [],
				prepared: {
					maxOutputTokens: params.maxOutputTokens ?? null,
					providerOptions: clone(deps.providerOptions),
				},
				pendingImageEntries: [],
				executions: [],
				events: [],
				usage: [],
				sequence: 0,
				nextAttempt: 0,
				workingSteps: 0,
				closingSegments: [],
				deadlineAt: policy.deadlineAt,
				totalTimeoutMs: policy.totalTimeoutMs,
			};
	if (snapshot.turnId !== policy.turnId)
		throw new Error("Continuation belongs to a different requested turn");
	const resumed =
		policy.continuationKind === "user_resume" &&
		snapshot.segmentId !== policy.segmentId;
	if (snapshot.segmentId !== policy.segmentId && !resumed)
		throw new Error(
			"A new segment requires explicit user resume authorization",
		);
	if (resumed) {
		snapshot.segmentId = policy.segmentId;
		snapshot.deadlineAt = policy.deadlineAt;
		snapshot.totalTimeoutMs = policy.totalTimeoutMs;
		delete snapshot.completion;
		snapshot.prepared = {
			maxOutputTokens: params.maxOutputTokens ?? null,
			providerOptions: clone(deps.providerOptions),
		};
	}
	if (policy.continuation && !resumed) {
		params = { ...params, maxOutputTokens: snapshot.prepared.maxOutputTokens };
		if (
			!params.resolveProviderOptions &&
			snapshot.original.providerId === params.provider.id &&
			snapshot.original.modelName === params.provider.modelName
		)
			deps.providerOptions = clone(snapshot.prepared.providerOptions);
	}
	// Automatic continuation cannot extend a deadline or obtain another closing allowance.
	const reserve = Math.min(60000, Math.floor(snapshot.totalTimeoutMs / 4));
	const notify = () => {
		snapshot.pendingImageEntries.push(
			...clone(params.stepImages?.drain() ?? []),
		);
		policy.onSnapshot?.(clone(snapshot));
	};
	const emit = (scope: NormalChatOutputScope, event: EventBody) => {
		const full = {
			...scope,
			...event,
			sequence: ++snapshot.sequence,
		} as NormalChatOutputEvent;
		snapshot.events.push(full);
		policy.onOutputEvent?.(full);
	};
	type EventBody = NormalChatOutputEvent extends infer E
		? E extends NormalChatOutputEvent
			? Omit<E, keyof NormalChatOutputScope | "sequence">
			: never
		: never;
	let workingCause: NormalChatStopCause = "stream_end";
	let stopCause: NormalChatStopCause = "stream_end";
	let outcome: NormalChatCompletion["outcome"] = "incomplete";
	let phase: NormalChatOutputPhase =
		policy.continuation && !resumed ? "closing" : "working";
	let lastScope: NormalChatOutputScope = {
		version: 1,
		turnId: policy.turnId,
		segmentId: policy.segmentId,
		attemptId: `${policy.segmentId}:terminal`,
		stepId: `${policy.segmentId}:terminal:0`,
		phase,
	};
	let finalFinish: PlainNormalChatModelRunResult["finishReason"] = "other";
	let responseModel = params.provider.modelName;
	let closingAttempted = snapshot.closingSegments.includes(policy.segmentId);
	let droppedToolCalls = 0;
	let segmentWorkingSteps = snapshot.steps.filter(
		(s) =>
			s.segmentId === policy.segmentId && s.phase === "working" && s.finished,
	).length;
	const priorExecutions = clone(snapshot.executions);
	const uncertain = () =>
		snapshot.executions.some(
			(e) =>
				e.state === "dispatched" ||
				e.state === "uncertain" ||
				(e.providerExecuted && e.state === "proposed"),
		);
	// A proven refusal is not a submitted effect, but is still a tool occurrence.
	// Automatic recovery after it must not regain pre-work executable tools.
	const hasToolOccurrence = () =>
		snapshot.executions.some(
			(e) => e.segmentId === policy.segmentId && e.state !== "proposed",
		);
	const externalAbort = () =>
		params.abortSignal?.aborted
			? (policy.abortCause?.() ?? "user_stop")
			: undefined;
	const stopped = () => externalAbort() === "user_stop";
	// Complete terminal observations are read-only. A resume is a distinct authorized segment.
	if (snapshot.completion && !resumed) {
		const saved = snapshot.completion;
		return {
			text: projectNormalChatOutput(snapshot.events).answer,
			finishReason: saved.outcome === "answered" ? "stop" : "other",
			usage: aggregateUsage(snapshot.usage),
			model: deps.metadata(responseModel),
			completion: saved,
			continuation: snapshot,
		};
	}
	const canonical = (): ModelMessage[] => {
		const messages = clone(snapshot.original.messages);
		for (const step of snapshot.steps) {
			messages.push(...clone(step.inserts), ...clone(step.response));
		}
		return messages;
	};
	const project = async (messages: ModelMessage[]) => {
		// The journal is lossless; queued pictures are outbound step-local inputs.
		// A truncated/failed step has not consumed its look. Keep it eligible until
		// a clean step completes, including a tools-disabled closing attempt.
		let offset = snapshot.original.messages.length;
		const boundaries = snapshot.steps.map((saved) => {
			const start = offset;
			offset += saved.inserts.length + saved.response.length;
			return { saved, start };
		});
		messages = clone(messages);
		let consumed = false;
		for (const { saved, start } of boundaries.reverse()) {
			consumed ||=
				saved.finished &&
				(saved.finishReason === "stop" || saved.finishReason === "tool-calls");
			if (!saved.imageEntries.length) continue;
			const entries = consumed ? [] : clone(saved.imageEntries);
			const imageProjection = await buildVisionPrepareStep({
				queue: {
					drain: () => entries,
					push: () => {},
					reserve: () => 0,
					release: () => {},
					room: () => 0,
				},
				providerCanSee: providerCanSeeImages(params.provider),
				providerIsLocal: providerRunsLocally(params.provider),
			})({
				stepNumber: 0,
				steps: [],
				messages: [],
				model: deps.model,
				experimental_context: undefined,
			});
			messages.splice(
				start,
				saved.inserts.length,
				...(imageProjection?.messages ?? []),
			);
		}
		// Apply whole-context policy AFTER the typed entries have been projected.
		// It may still refuse original context that has no safe destination form.
		const projected = attemptPolicy.projectContext?.({
			snapshot: clone(snapshot),
			system: snapshot.original.system,
			messages: clone(messages),
			provider: params.provider,
		});
		if (
			projected === null ||
			(!attemptPolicy.projectContext &&
				(snapshot.original.providerId !== params.provider.id ||
					snapshot.original.providerBaseUrl !== params.provider.baseUrl ||
					snapshot.original.modelName !== params.provider.modelName))
		)
			throw new CompletionExit("incompatible_continuation");
		const input = projected ?? { system: snapshot.original.system, messages };
		if (!providerCanSeeImages(params.provider))
			input.messages = stripImageParts(input.messages);
		return {
			...input,
			messages: params.gateMessagesForAttempt
				? params.gateMessagesForAttempt(clone(input.messages), params.provider)
				: input.messages,
		};
	};
	const assertFits = (input: { system?: string; messages: ModelMessage[] }) => {
		const output = params.maxOutputTokens ?? params.provider.maxOutputTokens;
		const capacity = deps.maxModelContext;
		// No invented model table and no shrinking of continuation evidence.
		if (
			capacity === undefined ||
			output === undefined ||
			estimateHistoryMessagesTokens(input.messages, estimateTokenCount) +
				estimateTokenCount(input.system ?? "") +
				output +
				CONTEXT_GUARD_MARGIN_TOKENS >
				capacity
		)
			throw new CompletionExit("context_capacity");
	};
	while (true) {
		if (stopped()) {
			outcome = "stopped";
			stopCause = "user_stop";
			break;
		}
		if (externalAbort()) {
			stopCause = externalAbort() ?? "transport_error";
			outcome = stopCause === "transport_error" ? "failed" : "incomplete";
			break;
		}
		if (uncertain()) {
			stopCause = "uncertain_execution";
			break;
		}
		if (Date.now() >= snapshot.deadlineAt) {
			stopCause = "deadline";
			break;
		}
		if (phase === "closing") {
			if (closingAttempted) break;
			closingAttempted = true;
			snapshot.closingSegments.push(policy.segmentId);
		}
		const attemptId = `${policy.segmentId}:attempt:${snapshot.nextAttempt++}`;
		const toolsAllowed =
			phase === "working" &&
			(!policy.continuation || resumed || !hasToolOccurrence());
		try {
			const prepared = await policy.forAttempt?.({
				provider: params.provider,
				modelId:
					params.modelId ?? params.provider.modelId ?? params.provider.id,
				phase,
				attemptId,
				toolsAllowed,
				snapshot: clone(snapshot),
			});
			if (prepared === null)
				throw new CompletionExit("incompatible_continuation");
			attemptPolicy = prepared ?? {};
			const modelChanged =
				params.provider.id !== selectedProvider.id ||
				params.provider.baseUrl !== selectedProvider.baseUrl ||
				params.provider.modelName !== selectedProvider.modelName;
			if (
				toolsAllowed &&
				modelChanged &&
				params.tools &&
				!Object.hasOwn(attemptPolicy, "tools")
			)
				throw new CompletionExit("incompatible_continuation");
		} catch {
			stopCause = "incompatible_continuation";
			break;
		}
		const effectiveTools = toolsAllowed
			? Object.hasOwn(attemptPolicy, "tools")
				? attemptPolicy.tools
				: params.tools
			: undefined;

		const stepsByNumber = new Map<number, NormalChatContinuationStep>();
		let preparedStepNumber = 0;
		let attemptFinished = false;
		let attemptError = false;
		let rawError: unknown;
		let attemptCause: NormalChatStopCause | undefined;
		let lastReason: string | null = null;
		let missingUsage = false;
		let firstOutputTimedOut = false;
		const firstOutputController = new AbortController();
		const firstOutputMs =
			phase === "working" ? await deps.firstOutputTimeoutMs?.() : null;
		const firstOutputTimer =
			firstOutputMs && firstOutputMs > 0
				? setTimeout(() => {
						firstOutputTimedOut = true;
						firstOutputController.abort(
							new Error("Timed out waiting for first upstream output"),
						);
					}, firstOutputMs)
				: undefined;
		firstOutputTimer?.unref?.();
		const clearFirstOutputTimeout = () => {
			if (firstOutputTimer) clearTimeout(firstOutputTimer);
		};

		const usage: NormalChatAttemptUsage = {
			turnId: policy.turnId,
			segmentId: policy.segmentId,
			attemptId,
			phase,
			providerId: params.provider.id,
			modelId:
				params.modelId ?? params.provider.modelId ?? params.provider.modelName,
			responseModelId: null,
			inputTokens: null,
			outputTokens: null,
			totalTokens: null,
			complete: false,
		};
		snapshot.usage.push(usage);
		const scope = (
			current: NormalChatContinuationStep,
		): NormalChatOutputScope => ({
			version: 1,
			turnId: policy.turnId,
			segmentId: policy.segmentId,
			attemptId,
			stepId: current.stepId,
			phase,
		});
		const ensureStep = (stepNumber = preparedStepNumber) => {
			let current = stepsByNumber.get(stepNumber);
			if (!current) {
				current = {
					segmentId: policy.segmentId,
					attemptId,
					stepId: `${attemptId}:step:${stepNumber}`,
					phase,
					response: [],
					inserts: [],
					imageEntries: [],
					finished: false,
					toolAttempted: false,
					finishReason: null,
				};
				stepsByNumber.set(stepNumber, current);
				snapshot.steps.push(current);
				if (!streaming) {
					lastScope = scope(current);
					emit(lastScope, { type: "step_start" });
				}
			}
			return current;
		};
		const executionsForStep = (current = ensureStep()) =>
			snapshot.executions.filter(
				(e) => e.stepId === current.stepId && e.attemptId === attemptId,
			);
		const ledger = (
			callId: string,
			toolName: string,
			input: unknown,
			providerExecuted = false,
			current = ensureStep(),
		) => {
			current.toolAttempted = true;
			let entry = executionsForStep(current).find(
				(e) => e.callId === callId && e.toolName === toolName,
			);
			if (!entry) {
				entry = {
					executionId: `${attemptId}:${current.stepId}:${snapshot.executions.length}`,
					turnId: policy.turnId,
					segmentId: policy.segmentId,
					attemptId,
					stepId: current.stepId,
					callId,
					toolName,
					input: clone(input),
					state: providerExecuted ? "uncertain" : "proposed",
					providerExecuted,
					preliminary: false,
				};
				snapshot.executions.push(entry);
			}
			return entry;
		};
		const responseResult = (entry: NormalChatExecution) => {
			if (!entry.modelOutput) return;
			const current = snapshot.steps.find(
				(s) => s.stepId === entry.stepId && s.attemptId === entry.attemptId,
			);
			if (!current) return;
			if (entry.providerExecuted) {
				let assistant = current.response.find((m) => m.role === "assistant");
				if (!assistant) {
					assistant = { role: "assistant", content: [] };
					current.response.unshift(assistant);
				}
				if (
					Array.isArray(assistant.content) &&
					!assistant.content.some(
						(p) => p.type === "tool-result" && p.toolCallId === entry.callId,
					)
				)
					assistant.content.push({
						type: "tool-result",
						toolCallId: entry.callId,
						toolName: entry.toolName,
						output: clone(entry.modelOutput),
						providerOptions: entry.providerOptions,
					});
				return;
			}
			let message = current.response.find((m) => m.role === "tool");
			if (!message) {
				message = { role: "tool", content: [] };
				current.response.push(message);
			}
			if (
				message.role === "tool" &&
				!message.content.some(
					(p) => p.type === "tool-result" && p.toolCallId === entry.callId,
				)
			)
				message.content.push({
					type: "tool-result",
					toolCallId: entry.callId,
					toolName: entry.toolName,
					output: clone(entry.modelOutput),
				});
		};
		const recordCall = (entry: NormalChatExecution) => {
			const current = snapshot.steps.find(
				(s) => s.stepId === entry.stepId && s.attemptId === entry.attemptId,
			);
			if (!current || current.finished) return;
			let message = current.response.find((m) => m.role === "assistant");
			if (!message) {
				message = { role: "assistant", content: [] };
				current.response.unshift(message);
			}
			if (
				message.role === "assistant" &&
				Array.isArray(message.content) &&
				!message.content.some(
					(p) => p.type === "tool-call" && p.toolCallId === entry.callId,
				)
			)
				message.content.push({
					type: "tool-call",
					toolCallId: entry.callId,
					toolName: entry.toolName,
					input: clone(entry.input),
					providerExecuted: entry.providerExecuted,
					providerOptions: entry.providerOptions,
				});
			if (Array.isArray(message.content))
				for (const part of message.content)
					if (part.type === "tool-call" && part.toolCallId === entry.callId) {
						part.input = clone(entry.input);
						part.providerOptions = clone(entry.providerOptions);
					}
		};
		const tools = buildCompletionTools({
			phase,
			policy: attemptPolicy,
			snapshot,
			params: { tools: effectiveTools },
			resumed,
			priorExecutions,
			workingDeadlineAt: snapshot.deadlineAt - reserve,
			stopped,
			ledger,
			recordCall,
			responseResult,
			notify,
			clearFirstOutputTimeout,
			executionsForStep,
			failure: (code) => {
				attemptCause = code;
				return new CompletionExit(code);
			},
		});
		const deadline =
			phase === "working" ? snapshot.deadlineAt - reserve : snapshot.deadlineAt;
		const timerController = new AbortController();
		const timer = setTimeout(
			() => timerController.abort(new CompletionExit("deadline")),
			Math.max(1, deadline - Date.now()),
		);
		timer.unref?.();
		const signal = AbortSignal.any([
			timerController.signal,
			firstOutputController.signal,
			...(params.abortSignal ? [params.abortSignal] : []),
		]);
		let cumulativeMessageCount = 0;
		const blocks = new Map<string, { id: string; index: number }>();
		type NativeMetadata = Extract<
			TextStreamPart<ToolSet>,
			{ type: "text-start" }
		>["providerMetadata"];
		const startBlock = (
			id: string,
			kind: "text" | "reasoning",
			metadata?: NativeMetadata,
			current = ensureStep(),
		) => {
			const key = `${current.stepId}:${kind}:${id}`;
			let b = blocks.get(key);
			if (!b) {
				let index = -1;
				if (!current.finished) {
					let assistant = current.response.find((m) => m.role === "assistant");
					if (!assistant) {
						assistant = { role: "assistant", content: [] };
						current.response.unshift(assistant);
					}
					if (!Array.isArray(assistant.content))
						throw new Error("Expected assistant parts");
					index = assistant.content.length;
					assistant.content.push({ type: kind, text: "" });
				}
				b = { id: `${key}:${blocks.size}`, index };
				blocks.set(key, b);
				emit(scope(current), {
					type: "block_start",
					blockId: b.id,
					nativeId: id,
					kind,
					role:
						kind === "reasoning"
							? "activity"
							: phase === "closing"
								? "answer"
								: "provisional",
				});
			}
			if (metadata && !current.finished) {
				const assistant = current.response.find((m) => m.role === "assistant");
				if (assistant && Array.isArray(assistant.content)) {
					const part = assistant.content[b.index];
					if (part?.type === "text" || part?.type === "reasoning")
						part.providerOptions = {
							...part.providerOptions,
							...clone(metadata),
						};
				}
			}
			return b;
		};
		const delta = (
			id: string,
			kind: "text" | "reasoning",
			text: string,
			current = ensureStep(),
		) => {
			const b = startBlock(id, kind, undefined, current);
			const assistant = current.response.find((m) => m.role === "assistant");
			if (!current.finished && assistant && Array.isArray(assistant.content)) {
				const part = assistant.content[b.index];
				if (part?.type === "text" || part?.type === "reasoning")
					part.text += text;
			}
			emit(scope(current), { type: "block_delta", blockId: b.id, text });
		};
		const settleOutputStep = (
			current: NormalChatContinuationStep,
			finishReason: string | null,
		) => {
			emit(scope(current), {
				type: "step_end",
				finishReason,
				toolAttempted: current.toolAttempted,
			});
			emit(scope(current), {
				type: "step_settled",
				role: phase === "closing" ? "answer" : "activity",
				finishReason,
			});
		};
		const finishStep = (event: OnStepFinishEvent<ToolSet>) => {
			clearFirstOutputTimeout();
			const current = ensureStep(event.stepNumber);
			if (!streaming)
				for (const [i, part] of event.content.entries()) {
					if (part.type === "text" || part.type === "reasoning") {
						const b = startBlock(
							String(i),
							part.type,
							part.providerMetadata,
							current,
						);
						delta(String(i), part.type, part.text, current);
						emit(scope(current), { type: "block_end", blockId: b.id });
					}
				}
			current.toolAttempted ||= event.toolCalls.length > 0;
			// Native response.messages is cumulative WITHIN this SDK invocation, never across attempts.
			current.response = clone(
				event.response.messages.slice(cumulativeMessageCount),
			);
			cumulativeMessageCount = event.response.messages.length;
			for (const call of event.toolCalls) {
				const entry = ledger(
					call.toolCallId,
					call.toolName,
					call.input,
					call.providerExecuted === true,
					current,
				);
				if (call.invalid && entry.state === "proposed")
					entry.state = "definitely_not_executed";
			}
			for (const result of event.toolResults) {
				const entry = ledger(
					result.toolCallId,
					result.toolName,
					result.input,
					result.providerExecuted === true,
					current,
				);
				entry.preliminary = result.preliminary === true;
				if (result.providerExecuted && !entry.preliminary) {
					entry.output = clone(result.output);
					entry.state = "succeeded";
					entry.delivered = attemptPolicy.isDelivery?.(entry) ?? false;
				}
			}
			current.finishReason = event.finishReason;
			current.finished = true;
			lastReason = event.finishReason;
			if (phase === "working") {
				snapshot.workingSteps++;
				segmentWorkingSteps++;
			}
			usage.responseModelId = event.response.modelId;
			responseModel = event.response.modelId;
			const mapped = deps.mapUsage(event.usage, event.providerMetadata);
			usage.lastStepInputTokens = mapped.inputTokens;
			const reasoningTokens = event.usage.outputTokenDetails?.reasoningTokens;
			if (reasoningTokens !== undefined)
				usage.reasoningTokens = (usage.reasoningTokens ?? 0) + reasoningTokens;
			for (const key of [
				"cachedInputTokens",
				"cacheHitTokens",
				"cacheMissTokens",
			] as const)
				if (mapped[key] !== undefined)
					usage[key] = (usage[key] ?? 0) + mapped[key];
			missingUsage ||=
				mapped.inputTokens === undefined ||
				mapped.outputTokens === undefined ||
				mapped.totalTokens === undefined;
			usage.inputTokens = addKnown(usage.inputTokens, mapped.inputTokens);
			usage.outputTokens = addKnown(usage.outputTokens, mapped.outputTokens);
			usage.totalTokens = addKnown(usage.totalTokens, mapped.totalTokens);
			if (!streaming) settleOutputStep(current, event.finishReason);
			if ("onStepMessages" in params)
				params.onStepMessages?.(
					clone(canonical().slice(snapshot.original.messages.length)),
				);
			notify();
		};
		const prepareStep: PrepareStepFunction<ToolSet> = async (options) => {
			if (stopped()) throw new CompletionExit("user_stop");
			if (uncertain()) throw new CompletionExit("uncertain_execution");
			if (Date.now() >= deadline) throw new CompletionExit("deadline");
			preparedStepNumber = options.stepNumber;
			const current = ensureStep(options.stepNumber);
			const entries = [
				...snapshot.pendingImageEntries.splice(0),
				...clone(params.stepImages?.drain() ?? []),
			];
			current.imageEntries = clone(entries);
			current.inserts = entries.map((entry) =>
				buildStepImagesMessage(entry.label, entry.images),
			);
			const messages = canonical();
			if (phase === "closing")
				messages.push({ role: "user", content: closingInstruction });
			const input = await project(messages);
			assertFits(input);
			current.observedInput = clone({
				providerId: params.provider.id,
				...input,
			});
			notify();
			return {
				...input,
				...(phase === "working" &&
				options.stepNumber === 0 &&
				params.firstStepToolChoice
					? { toolChoice: params.firstStepToolChoice }
					: {}),
			};
		};
		try {
			deps.validateTools?.(tools);
			const input = await project(canonical());
			if (phase === "closing")
				input.messages.push({ role: "user", content: closingInstruction });
			assertFits(input);
			const request = {
				model: deps.model,
				...input,
				tools,
				...(phase === "working"
					? {
							toolChoice: params.toolChoice,
							stopWhen: [
								...(Array.isArray(deps.stopWhen)
									? deps.stopWhen
									: deps.stopWhen
										? [deps.stopWhen]
										: []),
								() => {
									if (uncertain() || attemptCause === "uncertain_execution") {
										attemptCause = "uncertain_execution";
										return true;
									}
									if (Date.now() >= deadline) {
										attemptCause = "deadline";
										return true;
									}
									return segmentWorkingSteps >= (params.maxToolSteps ?? 20);
								},
							],
						}
					: {}),
				prepareStep,
				maxOutputTokens:
					params.maxOutputTokens ?? params.provider.maxOutputTokens,
				...resolveModelCallSampling(params.provider),
				providerOptions: deps.providerOptions,
				maxRetries: 0,
				abortSignal: signal,
				headers: params.headers,
				onStepFinish: finishStep,
			};
			if (streaming) {
				const result = streamText({ ...request, onError: () => {} });
				let streamStepNumber = -1;
				for await (const part of result.fullStream) {
					if (part.type === "start-step") {
						streamStepNumber++;
						const current = ensureStep(streamStepNumber);
						lastScope = scope(current);
						emit(lastScope, { type: "step_start" });
					}
					const sourceStep = () => ensureStep(Math.max(0, streamStepNumber));
					if (part.type === "finish-step")
						settleOutputStep(sourceStep(), part.finishReason);
					if (
						part.type === "text-delta" ||
						part.type === "reasoning-delta" ||
						part.type === "tool-input-start"
					)
						clearFirstOutputTimeout();
					if (part.type === "text-start" || part.type === "reasoning-start")
						startBlock(
							part.id,
							part.type === "text-start" ? "text" : "reasoning",
							part.providerMetadata,
							sourceStep(),
						);
					if (part.type === "text-delta" || part.type === "reasoning-delta") {
						startBlock(
							part.id,
							part.type === "text-delta" ? "text" : "reasoning",
							part.providerMetadata,
							sourceStep(),
						);
						delta(
							part.id,
							part.type === "text-delta" ? "text" : "reasoning",
							part.text,
							sourceStep(),
						);
						if (part.type === "reasoning-delta")
							yield { type: "reasoning_delta", text: part.text };
						else if (phase === "closing")
							yield { type: "text_delta", text: part.text };
					}
					if (part.type === "text-end" || part.type === "reasoning-end") {
						const b = startBlock(
							part.id,
							part.type === "text-end" ? "text" : "reasoning",
							part.providerMetadata,
							sourceStep(),
						);
						emit(scope(sourceStep()), { type: "block_end", blockId: b.id });
					}
					if (part.type === "tool-input-start") {
						ledger(
							part.id,
							part.toolName,
							undefined,
							part.providerExecuted,
							sourceStep(),
						);
					}
					if (part.type === "tool-call") {
						const entry = ledger(
							part.toolCallId,
							part.toolName,
							part.input,
							part.providerExecuted,
							sourceStep(),
						);
						entry.input = clone(part.input);
						entry.providerOptions = clone(part.providerMetadata);
						recordCall(entry);
						if (part.invalid && entry.state === "proposed")
							entry.state = "definitely_not_executed";
						if (tools && !Object.hasOwn(tools, part.toolName))
							droppedToolCalls++;
						else
							yield {
								type: "tool_call",
								callId: part.toolCallId,
								toolName: part.toolName,
								input: part.input,
							};
					}
					if (part.type === "tool-result") {
						const entry = ledger(
							part.toolCallId,
							part.toolName,
							part.input,
							part.providerExecuted,
							sourceStep(),
						);
						entry.preliminary = part.preliminary === true;
						if (part.providerExecuted) entry.output = clone(part.output);
						if (part.providerExecuted && !part.preliminary) {
							entry.output = clone(part.output);
							entry.providerOptions = clone(part.providerMetadata);
							entry.modelOutput = effectiveTools?.[part.toolName]?.toModelOutput
								? await effectiveTools[part.toolName].toModelOutput?.({
										toolCallId: part.toolCallId,
										input: part.input,
										output: part.output,
									})
								: typeof part.output === "string"
									? { type: "text", value: part.output }
									: { type: "json", value: (part.output ?? null) as JSONValue };
							entry.state = "succeeded";
							entry.delivered = attemptPolicy.isDelivery?.(entry) ?? false;
							responseResult(entry);
							notify();
						}
						if (!tools || Object.hasOwn(tools, part.toolName))
							yield {
								type: "tool_result",
								callId: part.toolCallId,
								toolName: part.toolName,
								output: part.output,
							};
					}
					if (part.type === "tool-error") {
						const entry = ledger(
							part.toolCallId,
							part.toolName,
							part.input,
							part.providerExecuted,
							sourceStep(),
						);
						if (entry.state === "dispatched") entry.state = "uncertain";
						if (!tools || Object.hasOwn(tools, part.toolName))
							yield {
								type: "tool_error",
								callId: part.toolCallId,
								toolName: part.toolName,
								error: String(part.error),
							};
					}
					if (part.type === "error") {
						attemptError = true;
						throw part.error;
					}
					if (part.type === "finish") {
						attemptFinished = true;
						finalFinish = part.finishReason;
						lastReason = part.finishReason;
						usage.complete =
							!missingUsage &&
							usage.inputTokens !== null &&
							usage.outputTokens !== null &&
							usage.totalTokens !== null;
					}
				}
			} else {
				const result = await generateText(request);
				finalFinish = result.finishReason;
				lastReason = result.finishReason;
				attemptFinished = true;
				usage.complete =
					!missingUsage &&
					usage.inputTokens !== null &&
					usage.outputTokens !== null &&
					usage.totalTokens !== null;
			}
		} catch (error) {
			attemptError = true;
			rawError = firstOutputTimedOut
				? new Error("Timed out waiting for first upstream output")
				: error;
			attemptCause =
				error instanceof CompletionExit
					? error.causeCode
					: stopped()
						? "user_stop"
						: timerController.signal.aborted
							? "deadline"
							: "transport_error";
		} finally {
			clearTimeout(timer);
			clearFirstOutputTimeout();
			notify();
		}
		if (timerController.signal.aborted && !stopped()) {
			attemptError = true;
			attemptCause = "deadline";
		}
		if (firstOutputTimedOut) {
			attemptError = true;
			attemptCause = "transport_error";
			rawError = new Error("Timed out waiting for first upstream output");
		}
		// A callback can finish a step before its stream parts are consumed. Keep its ID stable.
		const finalStep = snapshot.steps
			.filter((s) => s.attemptId === attemptId)
			.at(-1);
		const finalText =
			finalStep?.response
				.filter((m) => m.role === "assistant")
				.flatMap((m) =>
					typeof m.content === "string"
						? [m.content]
						: m.content.filter((p) => p.type === "text").map((p) => p.text),
				)
				.join("") ?? "";
		stopCause =
			externalAbort() ??
			(stopped()
				? "user_stop"
				: uncertain()
					? "uncertain_execution"
					: (attemptCause ?? cause(lastReason)));
		const paused = snapshot.executions.some(
			(e) =>
				e.segmentId === policy.segmentId &&
				e.toolName === ASK_USER_TOOL_NAME &&
				e.state === "succeeded" &&
				isAskPauseOutput(e.output),
		);
		if (stopped()) {
			outcome = "stopped";
			stopCause = "user_stop";
			break;
		}
		if (externalAbort() && !stopped()) {
			outcome = stopCause === "transport_error" ? "failed" : "incomplete";
			break;
		}
		if (paused) {
			outcome = "paused";
			stopCause = "ask_pause";
			break;
		}
		if (uncertain() || stopCause === "uncertain_execution") {
			stopCause = "uncertain_execution";
			break;
		}
		if (stopCause === "content_filter") break;
		if (
			attemptError &&
			phase === "working" &&
			!hasToolOccurrence() &&
			(stopCause === "transport_error" || stopCause === "deadline") &&
			Date.now() < snapshot.deadlineAt - reserve
		) {
			const fallback = await deps.fallback?.(rawError);
			if (fallback) {
				params = {
					...params,
					provider: fallback.provider,
					modelId: fallback.modelId,
				};
				deps = fallback.dependencies;
				responseModel = params.provider.modelName;
				continue;
			}
		}
		const natural =
			attemptFinished &&
			!attemptError &&
			lastReason === "stop" &&
			finalStep?.finished &&
			!finalStep.toolAttempted &&
			hasVisibleCharacter(sanitizeNormalChatAnswer(finalText));
		if (natural) {
			emit(
				{ ...lastScope, stepId: finalStep.stepId },
				{ type: "step_settled", role: "answer", finishReason: "stop" },
			);
			if (streaming && phase === "working")
				yield { type: "text_delta", text: finalText };
			outcome = "answered";
			stopCause = "natural_stop";
			break;
		}
		const lastExecution = snapshot.executions
			.filter((e) => e.segmentId === policy.segmentId)
			.at(-1);
		const deliveryStepIndex = lastExecution
			? snapshot.steps.findIndex(
					(s) =>
						s.stepId === lastExecution.stepId &&
						s.attemptId === lastExecution.attemptId,
				)
			: -1;
		const laterUnfinishedWork =
			deliveryStepIndex < 0 ||
			snapshot.steps
				.slice(deliveryStepIndex + 1)
				.some(
					(s) =>
						s.segmentId === policy.segmentId &&
						(!s.finished || s.finishReason !== "stop" || s.toolAttempted),
				);
		if (
			phase === "working" &&
			lastExecution?.state === "succeeded" &&
			lastExecution.delivered === true &&
			!laterUnfinishedWork
		) {
			outcome = "delivered";
			break;
		}
		if (
			phase === "closing" ||
			stopCause === "context_capacity" ||
			stopCause === "incompatible_continuation" ||
			Date.now() >= snapshot.deadlineAt
		) {
			if (attemptError && stopCause === "transport_error") outcome = "failed";
			break;
		}
		workingCause =
			finalStep?.toolAttempted && !attemptCause
				? segmentWorkingSteps >= (params.maxToolSteps ?? 20)
					? "tool_budget"
					: "stagnation"
				: stopCause;
		phase = "closing";
	}
	if (!closingAttempted) workingCause = stopCause;
	const completion: NormalChatCompletion = {
		version: 1,
		turnId: policy.turnId,
		segmentId: policy.segmentId,
		phase,
		outcome,
		stopCause,
		workingStopCause: workingCause,
		closingAttempted,
	};
	snapshot.completion = completion;
	emit({ ...lastScope, phase }, { type: "completion", completion });
	notify();
	const aggregate = aggregateUsage(snapshot.usage);
	yield { type: "usage", usage: aggregate };
	yield {
		type: "finish",
		droppedToolCalls,
		stepCount: segmentWorkingSteps,
		finishReason: finalFinish,
		rawFinishReason: undefined,
		model: deps.metadata(responseModel),
	};
	return {
		text: projectNormalChatOutput(snapshot.events).answer,
		finishReason: finalFinish,
		usage: aggregate,
		model: deps.metadata(responseModel),
		completion,
		continuation: snapshot,
	};
}
function addKnown(total: number | null, value: number | undefined) {
	return value === undefined ? total : (total ?? 0) + value;
}
function aggregateUsage(
	usage: NormalChatAttemptUsage[],
): NormalChatModelRunUsage {
	const sum = (key: "inputTokens" | "outputTokens" | "totalTokens") =>
		usage.some((u) => u[key] === null || !u.complete)
			? undefined
			: usage.reduce((n, u) => n + (u[key] ?? 0), 0);
	return {
		inputTokens: sum("inputTokens"),
		outputTokens: sum("outputTokens"),
		totalTokens: sum("totalTokens"),
		lastStepInputTokens: usage.at(-1)?.lastStepInputTokens,
		...Object.fromEntries(
			(
				[
					"reasoningTokens",
					"cachedInputTokens",
					"cacheHitTokens",
					"cacheMissTokens",
				] as const
			)
				.filter((key) => usage.some((u) => u[key] !== undefined))
				.map((key) => [key, usage.reduce((n, u) => n + (u[key] ?? 0), 0)]),
		),
	};
}
