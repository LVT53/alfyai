import {
	type InvalidToolInputError,
	type JSONValue,
	NoSuchToolError,
	type ToolResultPart,
	type ToolSet,
} from "ai";
import { repairMalformedToolCallJson } from "$lib/server/utils/tool-json-repair";
import type { NormalChatStopCause } from "$lib/shared/normal-chat-completion";
import type { NormalChatOutputPhase } from "$lib/shared/normal-chat-output";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	bindReadResultGrant,
	boundedWebReadFailure,
	ReadResultCapacityError,
	type ReadResultGrantSpec,
	supportsReadResultBudget,
} from "../normal-chat-tools/model-payload-budget";
import { stableStringify } from "../normal-chat-tools/stable-stringify";
import type {
	NormalChatAttemptPolicy,
	NormalChatContinuationSnapshot,
	NormalChatExecution,
} from "./completion";
import { cloneNormalChatContextValue as clone } from "./continuation-codec";

type ReadProposal = Pick<
	NormalChatExecution,
	| "turnId"
	| "segmentId"
	| "attemptId"
	| "stepId"
	| "executionId"
	| "callId"
	| "toolName"
	| "input"
>;

/** Call/result framing and SDK JSON wrapper, separate from payload spending. */
export function measureReadResultFraming(
	entry: Pick<ReadProposal, "callId" | "toolName" | "input">,
): number {
	return (
		8 +
		estimateTokenCount(
			stableStringify([
				{
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolCallId: entry.callId,
							toolName: entry.toolName,
							input: entry.input,
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: entry.callId,
							toolName: entry.toolName,
							output: { type: "json", value: null },
						},
					],
				},
			]),
		)
	);
}

/** Invocation-local leases. A step freezes once; settlement never refunds it. */
export function createCompletionReadBudget() {
	let step: string | undefined,
		remaining = 0,
		refusal = 0,
		ordinal = 0,
		exhausted = false;
	return {
		freeze(
			stepId: string,
			unallocatedTokens: number,
			terminalRefusalTokens: number,
		) {
			if (step === stepId) return;
			step = stepId;
			remaining = Number.isFinite(unallocatedTokens)
				? Math.max(0, Math.floor(unallocatedTokens))
				: 0;
			refusal = Number.isFinite(terminalRefusalTokens)
				? Math.max(0, Math.floor(terminalRefusalTokens))
				: 0;
			ordinal = 0;
			exhausted = false;
		},
		allocate(entry: ReadProposal): ReadResultGrantSpec {
			const base = {
				turnId: entry.turnId,
				segmentId: entry.segmentId,
				attemptId: entry.attemptId,
				stepId: entry.stepId,
				executionId: entry.executionId,
				proposalOrdinal: ordinal++,
			};
			const h = measureReadResultFraming(entry);
			const f = estimateTokenCount(
				stableStringify(boundedWebReadFailure(entry.toolName)),
			);
			if (entry.stepId === step && remaining >= h + f) {
				const p = f + Math.floor((remaining - h - f) / 2);
				remaining -= h + p;
				return {
					...base,
					kind: "admitted",
					maxPayloadTokens: p,
					maxFailurePayloadTokens: f,
				};
			}
			exhausted = true;
			const allowance = refusal >= h + f ? f : 0;
			if (allowance) refusal -= h + f;
			return {
				...base,
				kind: "denied",
				maxPayloadTokens: 0,
				maxFailurePayloadTokens: allowance,
			};
		},
		get exhausted() {
			return exhausted;
		},
	};
}

/** Executable tools exist only in working generations. Every dispatch retains its scoped result. */
export function buildCompletionTools(context: {
	phase: NormalChatOutputPhase;
	readBudget: ReturnType<typeof createCompletionReadBudget>;
	policy: NormalChatAttemptPolicy;
	snapshot: NormalChatContinuationSnapshot;
	params: { tools?: ToolSet };
	resumed: boolean;
	priorExecutions: NormalChatExecution[];
	workingDeadlineAt: number;
	stopped(): boolean;
	ledger(
		callId: string,
		toolName: string,
		input: unknown,
		providerExecuted?: boolean,
	): NormalChatExecution;
	recordCall(entry: NormalChatExecution): void;
	responseResult(entry: NormalChatExecution): void;
	notify(): void;
	clearFirstOutputTimeout(): void;
	executionsForStep(): NormalChatExecution[];
	failure(cause: NormalChatStopCause): Error;
}): ToolSet | undefined {
	const {
		phase,
		readBudget,
		policy,
		snapshot,
		params,
		resumed,
		priorExecutions,
		workingDeadlineAt,
		stopped,
		ledger,
		recordCall,
		responseResult,
		notify,
		clearFirstOutputTimeout,
		executionsForStep,
		failure,
	} = context;
	const wrapped: ToolSet = {};
	// A closure cannot regain tool access through prepareStep during closing.
	if (phase === "working")
		for (const [name, original] of Object.entries(params.tools ?? {})) {
			wrapped[name] = {
				...original,
				...(original.execute
					? {
							execute: async (input, options) => {
								const entry = ledger(options.toolCallId, name, input);
								recordCall(entry);
								if (
									stopped() ||
									Date.now() >= workingDeadlineAt ||
									snapshot.executions.some(
										(e) =>
											e !== entry &&
											(e.state === "uncertain" || e.state === "dispatched") &&
											e.stepId !== entry.stepId,
									)
								) {
									entry.state = "definitely_not_executed";
									throw failure(
										stopped()
											? "user_stop"
											: Date.now() >= workingDeadlineAt
												? "deadline"
												: "uncertain_execution",
									);
								}
								if (resumed && priorExecutions.length) {
									const decision = policy.authorizeExecution?.(
										entry,
										priorExecutions,
									) ?? { kind: "refuse" };
									if (decision.kind === "reuse") {
										const prior = priorExecutions.find(
											(e) =>
												e.executionId === decision.executionId &&
												e.state === "succeeded",
										);
										if (!prior) {
											entry.state = "definitely_not_executed";
											throw failure("uncertain_execution");
										}
										entry.state = "succeeded";
										entry.delivered = prior.delivered;
										entry.output = clone(prior.output);
										entry.modelOutput = clone(prior.modelOutput);
										responseResult(entry);
										notify();
										return clone(prior.output);
									}
									if (decision.kind !== "new") {
										entry.state = "definitely_not_executed";
										throw failure("uncertain_execution");
									}
								}
								const executionOptions = supportsReadResultBudget(original)
									? bindReadResultGrant(options, readBudget.allocate(entry))
									: options;
								entry.state = "dispatched";
								clearFirstOutputTimeout();
								notify();
								try {
									const pending = Promise.resolve(
										original.execute?.(input, executionOptions),
									);
									const settle = pending.then(async (output) => {
										// Streaming tool executors require explicit finality; never mistake an iterator for a final result.
										if (
											output &&
											typeof output === "object" &&
											Symbol.asyncIterator in output
										) {
											entry.state = "uncertain";
											throw failure("uncertain_execution");
										}
										entry.output = clone(output);
										entry.state =
											policy.classifyExecution?.(entry, {
												success: true,
												output,
											}) ?? "uncertain";
										entry.modelOutput = original.toModelOutput
											? await original.toModelOutput({
													toolCallId: options.toolCallId,
													input,
													output,
												})
											: typeof output === "string"
												? { type: "text", value: output }
												: {
														type: "json",
														value: (output ?? null) as JSONValue,
													};
										entry.delivered =
											entry.state === "succeeded" &&
											(policy.isDelivery?.(entry) ?? false);
										responseResult(entry);
										notify();
										return output;
									});
									if (!options.abortSignal) return await settle;
									let remove = () => {};
									const aborted = new Promise<never>((_, reject) => {
										const onAbort = () => {
											entry.state = "uncertain";
											notify();
											reject(failure(stopped() ? "user_stop" : "deadline"));
										};
										options.abortSignal?.addEventListener("abort", onAbort, {
											once: true,
										});
										remove = () =>
											options.abortSignal?.removeEventListener(
												"abort",
												onAbort,
											);
										if (options.abortSignal?.aborted) onAbort();
									});
									try {
										return await Promise.race([settle, aborted]);
									} finally {
										remove();
									}
								} catch (error) {
									if (error instanceof ReadResultCapacityError) {
										entry.state = options.abortSignal?.aborted
											? "uncertain"
											: error.executed
												? "failed"
												: "definitely_not_executed";
										notify();
										throw failure("context_capacity");
									}
									const classified = policy.classifyExecution?.(entry, {
										success: false,
										error,
									});
									entry.state =
										classified === "definitely_not_executed" &&
										!options.abortSignal?.aborted
											? "definitely_not_executed"
											: "uncertain";
									notify();
									throw error;
								}
							},
						}
					: {}),
				toModelOutput: async ({
					toolCallId,
					input,
					output,
				}: {
					toolCallId: string;
					input: unknown;
					output: unknown;
				}): Promise<ToolResultPart["output"]> => {
					const entry = executionsForStep().find(
						(e) => e.callId === toolCallId && e.toolName === name,
					);
					if (entry?.modelOutput) return clone(entry.modelOutput);
					return original.toModelOutput
						? original.toModelOutput({ toolCallId, input, output })
						: typeof output === "string"
							? { type: "text", value: output }
							: { type: "json", value: (output ?? null) as JSONValue };
				},
			};
		}
	return Object.keys(wrapped).length ? wrapped : undefined;
}

/** Deterministic syntax repair shared by legacy and structural completion calls. */
export function toolCallRepairFunction({
	error,
	toolCall,
}: {
	error: InvalidToolInputError | NoSuchToolError;
	toolCall: { toolCallId: string; toolName: string; input: string };
}): Promise<{
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	input: string;
} | null> {
	if (NoSuchToolError.isInstance(error)) return Promise.resolve(null);
	const repaired = repairMalformedToolCallJson(toolCall.input);
	if (!repaired) return Promise.resolve(null);
	return Promise.resolve({ type: "tool-call", ...toolCall, input: repaired });
}
