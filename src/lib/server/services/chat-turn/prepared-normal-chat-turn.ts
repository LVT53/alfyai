import type { ModelMessage } from "ai";
import type { ModelId } from "$lib/model-types";
import { projectNormalChatOutput } from "$lib/shared/normal-chat-output";
import { hasLocalDistillEnabled } from "../connections/locality";
import type { Capability } from "../connections/registry";
import { resolveActiveCapabilities } from "../connections/resolve";
import { appendTurnGuidance } from "../normal-chat-context";
import {
	buildNormalChatModelRunProviderOptions,
	mapNormalChatModelRunUsageToProviderSnapshot,
	type NormalChatAttemptPolicy,
	type NormalChatContinuationSnapshot,
	type NormalChatExecution,
	prepareNormalChatCompletionRun,
} from "../normal-chat-model";
import { resolveHistoryToolMessagesMode } from "../normal-chat-model/provider-compatibility";
import { providerRunsLocally } from "../vision/provider-vision";
import { createStepImageQueue } from "../vision/step-images";
import { buildCurrentUserMessage } from "../vision/turn-images";
import { beginCompletionLifetime } from "./completion-lifetime";
import {
	deriveModelContextBudget,
	resolveCompletionMaxTokens,
} from "./context-budget";
import { normalizeAssistantOutputWithSkillControl } from "./normalizer";
import { logOutboundMessageShape } from "./outbound-debug";
import type { PlainNormalChatSendModelResult } from "./plain-normal-chat-model-run";
import { buildReasoningDepthProviderOptions } from "./reasoning-depth-effort";
import {
	createToolPack,
	estimateTurnPromptTokens,
	isEvidenceReadyToolCall,
	type NormalChatSendModelBaseParams,
	type PreparedModelContext,
	prepareOutboundContext,
	resolveActiveDepthEffort,
	resolveProviderRuntime,
	type ToolPack,
} from "./shared-normal-chat-model-run-helpers";
import type { ParsedSkillControlEnvelope } from "./skill-control-envelope";
import { NORMAL_CHAT_MAX_TOOL_STEPS } from "./tool-step-budget";

export type CompletionReceipt = {
	readonly skillControl?: Omit<ParsedSkillControlEnvelope, "visibleText">;
	segmentId?: string;
	getSnapshot(): NormalChatContinuationSnapshot | null;
	finish(messageId?: string): Promise<void>;
};
type Provenance = {
	version: 1;
	keptLocal: boolean;
	originalLocal: boolean;
	prepared: Omit<PreparedModelContext, "turnPictures"> & {
		turnPictures: Pick<
			PreparedModelContext["turnPictures"],
			"pictures" | "metadata"
		>;
	};
	settings: Pick<
		NormalChatSendModelBaseParams,
		"thinkingMode" | "depthMetadata" | "forceWebSearch"
	>;
};

function isFiniteTokenLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Owns preparation, dispatch admission and effective-attempt policy for both transports. */
export async function prepareNormalChatTurn(
	given: NormalChatSendModelBaseParams,
) {
	let continuation = given.continuationSnapshot;
	const saved = continuation?.original.provenance as Provenance | undefined;
	const params =
		saved?.version === 1
			? {
					...given,
					...saved.settings,
					...(given.resumeDepthOverride
						? {
								thinkingMode: given.thinkingMode,
								depthMetadata: given.depthMetadata,
							}
						: {}),
				}
			: given;
	const lifetime = beginCompletionLifetime({
		userId: params.userId,
		conversationId: params.conversationId,
		requestId: params.completionRequestId,
		turnId: continuation?.turnId ?? params.createTurnId?.(),
	});
	try {
		const selectedRuntime = await resolveProviderRuntime(params);
		const capturedLimit = continuation?.prepared?.maxOutputTokens;
		const contextWindow = isFiniteTokenLimit(
			selectedRuntime.provider.maxModelContext,
		)
			? selectedRuntime.provider.maxModelContext
			: selectedRuntime.baseContextLimits.maxModelContext;
		const requestedLimit = isFiniteTokenLimit(capturedLimit)
			? capturedLimit
			: resolveCompletionMaxTokens({
					maxModelContext: contextWindow,
					maxTokens: selectedRuntime.modelConfig.maxTokens,
					providerMaxOutputTokens: selectedRuntime.provider.maxOutputTokens,
				});
		// Resolve before preparation so its output reservation and the SDK cap agree.
		// This copy preserves selected runtime config and all reasoning controls.
		const runtime = {
			...selectedRuntime,
			modelConfig: {
				...selectedRuntime.modelConfig,
				maxTokens: requestedLimit,
			},
		};
		const effort = resolveActiveDepthEffort(runtime.depthEffort);
		const capabilities = await resolveActiveCapabilities(
			params.userId,
			params.enabledConnectionCapabilities,
		).catch(() => new Set<Capability>());
		let prepared: PreparedModelContext =
			saved?.version === 1
				? {
						...saved.prepared,
						turnPictures: {
							...saved.prepared.turnPictures,
							byNumber: (number) =>
								saved.prepared.turnPictures.pictures.find(
									(p) => p.number === number,
								) ?? null,
						},
					}
				: await prepareOutboundContext(params, runtime, effort, capabilities);
		const preparedLimit = prepared.outputTokenBudget?.effectiveMaxTokens;
		const outputLimit = isFiniteTokenLimit(capturedLimit)
			? capturedLimit
			: isFiniteTokenLimit(preparedLimit)
				? preparedLimit
				: deriveModelContextBudget({
						...prepared.contextLimits,
						maxTokens: requestedLimit,
					}).effectiveMaxTokens;
		if (!isFiniteTokenLimit(outputLimit))
			throw new Error("Normal Chat requires a finite positive output reserve");
		if (preparedLimit !== outputLimit) {
			// Old captures may have no reserve. Repair metadata only: never refetch,
			// rebuild or shorten their canonical evidence to fit the destination.
			prepared = {
				...prepared,
				outputTokenBudget: {
					configuredMaxTokens: requestedLimit,
					effectiveMaxTokens: outputLimit,
					outputReserve: outputLimit,
					outputReserveClamped: requestedLimit !== outputLimit,
				},
			};
		}
		if (continuation)
			continuation = {
				...continuation,
				prepared: { ...continuation.prepared, maxOutputTokens: outputLimit },
			};
		const keepLocal = await hasLocalDistillEnabled(params.userId);
		const provenance: Provenance = {
			version: 1,
			keptLocal: keepLocal,
			originalLocal:
				saved?.originalLocal ?? providerRunsLocally(runtime.provider),
			prepared: {
				...prepared,
				turnPictures: {
					pictures: prepared.turnPictures.pictures,
					metadata: prepared.turnPictures.metadata,
				},
			},
			settings: {
				thinkingMode: params.thinkingMode,
				depthMetadata: params.depthMetadata,
				forceWebSearch: params.forceWebSearch,
			},
		};
		const input = appendTurnGuidance(
			prepared.inputValue,
			prepared.turnGuidance,
		);
		const messages: ModelMessage[] = continuation
			? continuation.original.messages
			: [
					...(prepared.historyMessages ?? []),
					buildCurrentUserMessage(input, prepared.turnPictureImages),
					...(prepared.prefetchedToolMessages ?? []),
					...(params.continuationMessages ?? []),
				];
		const packs: ToolPack[] = [];
		const stepImages = createStepImageQueue();
		const packFor = async (modelId: string) => {
			const pack = await createToolPack(
				params,
				lifetime.scope.turnId,
				effort,
				modelId as ModelId,
				capabilities,
				prepared.turnPictures,
				stepImages,
			);
			packs.push(pack);
			return pack;
		};
		const initial = await packFor(runtime.modelId);
		let first = true;
		const calls = () => packs.flatMap((pack) => pack.getToolCalls());
		const rowFor = (execution: Readonly<NormalChatExecution>) =>
			calls().findLast(
				(row) =>
					row.callId === execution.callId && row.name === execution.toolName,
			);
		const receipt: CompletionReceipt = {
			get skillControl() {
				const snapshot = lifetime.getSnapshot();
				if (
					!snapshot ||
					snapshot.completion?.outcome === "stopped" ||
					params.runtimeConfig.composerCommandRegistryEnabled === false
				)
					return { operations: [] };
				const raw = projectNormalChatOutput(
					snapshot.events.filter(
						(event) => event.segmentId === lifetime.scope.segmentId,
					),
				)
					.blocks.filter((block) => block.kind === "text")
					.map((block) => block.text)
					.join("");
				const parsed = normalizeAssistantOutputWithSkillControl(raw, {
					structuredOutput: true,
				});
				return { operations: parsed.operations, metadata: parsed.metadata };
			},
			segmentId: lifetime.tracked ? lifetime.scope.segmentId : undefined,
			getSnapshot: lifetime.getSnapshot,
			finish: lifetime.finish,
		};
		if (prepared.turnPictureImages.length)
			params.onResponseActivity?.({
				id: "viewing-images",
				kind: "viewing_images",
				status: "running",
				count: prepared.turnPictureImages.length,
			});
		logOutboundMessageShape({
			label: "prepared turn",
			systemPrompt: prepared.systemPrompt,
			messages,
			toolCount: initial.tools ? Object.keys(initial.tools).length : 0,
		});
		const run = prepareNormalChatCompletionRun({
			provider: runtime.provider,
			modelId: runtime.modelId,
			runtimeConfig: params.runtimeConfig,
			system: prepared.systemPrompt,
			messages,
			stepImages,
			abortSignal: params.signal
				? AbortSignal.any([params.signal, lifetime.signal])
				: lifetime.signal,
			maxOutputTokens: outputLimit,
			maxToolSteps: effort?.maxToolSteps ?? NORMAL_CHAT_MAX_TOOL_STEPS,
			tools: initial.tools,
			firstStepToolChoice: undefined,
			toolChoice: params.forceProduceFileTool
				? { type: "tool", toolName: "produce_file" }
				: undefined,
			resolveProviderOptions: (provider) =>
				effort
					? buildReasoningDepthProviderOptions(provider, effort)
					: buildNormalChatModelRunProviderOptions(
							provider,
							params.thinkingMode,
						),
			gateMessagesForAttempt: params.gateMessagesForAttempt,
			completionPolicy: {
				...lifetime.scope,
				deadlineAt: Date.now() + params.runtimeConfig.requestTimeoutMs,
				totalTimeoutMs: params.runtimeConfig.requestTimeoutMs,
				contextProvenance: provenance,
				continuation,
				continuationKind: continuation ? "user_resume" : undefined,
				onSnapshot: lifetime.capture,
				onOutputEvent: params.onOutputEvent,
				abortCause: () =>
					lifetime.signal.aborted
						? "transport_error"
						: params.signal?.reason?.name === "UserStopReason"
							? "user_stop"
							: "deadline",
				forAttempt: async (context) => {
					const pack = context.toolsAllowed
						? first &&
							context.provider.id === runtime.provider.id &&
							context.modelId === runtime.modelId
							? initial
							: await packFor(context.modelId)
						: null;
					first = false;
					await lifetime.register({
						attemptId: context.attemptId,
						phase: context.phase,
						providerId: context.provider.id,
						modelId: context.modelId,
						providerModelName: context.provider.modelName,
					});
					const policy: NormalChatAttemptPolicy = {
						tools: pack?.tools,
						classifyExecution: (execution, result) => {
							// Consult this attempt's original result identity before legacy
							// row lookup; reused IDs/metadata cannot supply refusal certainty.
							if (
								result.success &&
								pack?.recorder?.getExecutionCertainty?.(result.output) ===
									"definitely_not_executed"
							)
								return "definitely_not_executed";
							return result.success && rowFor(execution)?.status === "done"
								? "succeeded"
								: "uncertain";
						},
						isDelivery: (execution) => {
							const row = rowFor(execution),
								meta = row?.metadata;
							if (row?.status !== "done" || meta?.ok !== true) return false;
							return (
								((execution.toolName === "create_artifact" ||
									execution.toolName === "edit_artifact") &&
									typeof meta.artifactId === "string") ||
								(execution.toolName === "produce_file" &&
									meta.jobStatus === "succeeded" &&
									typeof meta.jobId === "string") ||
								(execution.toolName === "make_image" &&
									meta.imageStatus === "succeeded" &&
									typeof meta.imageArtifactId === "string")
							);
						},
						authorizeExecution: (proposal, prior) => {
							// Human input admits genuinely new occurrences; retained executions are never a dispatch queue.
							const old = prior.find(
								(e) => e.executionId === proposal.executionId,
							);
							return old
								? old.state === "succeeded"
									? { kind: "reuse", executionId: old.executionId }
									: { kind: "refuse" }
								: { kind: "new" };
						},
						projectContext: ({ system, messages, provider }) => {
							if (resolveHistoryToolMessagesMode(provider) === "flatten")
								return null;
							// Model Run projects typed step images through the vision owner.
							// Original private preparation still has no safe cloud reconstruction.
							if (
								!providerRunsLocally(provider) &&
								provenance.originalLocal &&
								(keepLocal || saved?.keptLocal)
							)
								return null;
							return { system, messages };
						},
					};
					return policy;
				},
			},
		});
		const presentation = {
			contextStatus: prepared.contextStatus,
			taskState: prepared.taskState,
			contextDebug: prepared.contextDebug,
			contextTraceSections: prepared.contextTraceSections,
			contextPreparationTimings: prepared.contextPreparationTimings,
			estimatedPromptTokens: estimateTurnPromptTokens({
				prepared,
				inputValue: input,
				tools: initial.tools,
				continuationMessages: params.continuationMessages,
			}),
			instructionsApplied: prepared.instructionsApplied,
			userPictures: prepared.turnPictures.metadata ?? undefined,
		};
		const prefetched = prepared.prefetchedToolCalls ?? [];
		const shared = {
			prepared: presentation,
			modelId: runtime.modelId,
			modelDisplayName: runtime.provider.displayName,
			providerIconUrl: runtime.provider.iconUrl ?? null,
			resolvedProviderId: runtime.provider.id,
			prefetchedToolCalls: prefetched,
			getNormalChatToolCalls: calls,
			getToolCalls: () => [
				...prefetched,
				...calls().filter(isEvidenceReadyToolCall),
			],
			depthMetadata: effort?.depthMetadata,
			getTurnAsk: () => packs.map((p) => p.getTurnAsk()).find(Boolean) ?? null,
			getResponseMessages: () =>
				lifetime
					.getSnapshot()
					?.steps.filter((step) => step.segmentId === lifetime.scope.segmentId)
					.flatMap((step) => step.response) ?? [],
			continuationGiven: [
				...(prepared.prefetchedToolMessages ?? []),
				...(params.continuationMessages ?? []),
			],
			completionTurn: receipt,
		};
		let plain: Promise<PlainNormalChatSendModelResult> | undefined;
		return {
			receipt,
			runPlain(): Promise<PlainNormalChatSendModelResult> {
				plain ??= (async () => {
					try {
						const result = await run.runPlain();
						if (result.continuation) lifetime.capture(result.continuation);
						const recorded = calls();
						const timeline = [...prefetched, ...recorded];
						return {
							...presentation,
							text: result.continuation
								? projectNormalChatOutput(
										result.continuation.events.filter(
											(event) => event.segmentId === lifetime.scope.segmentId,
										),
									)
										.blocks.filter(
											(block) =>
												block.kind === "text" && block.role === "answer",
										)
										.map((block) => block.text)
										.join("")
								: result.text,
							providerUsage: mapNormalChatModelRunUsageToProviderSnapshot(
								result.usage,
							),
							prefetchedToolCalls: prefetched,
							normalChatToolCalls: recorded,
							toolCalls: shared.getToolCalls(),
							// The plain transport has no live segment accumulator. Persist
							// recorder facts separately from the success-only evidence view.
							serverSegments: timeline.length
								? timeline.map((entry) => ({
										type: "tool_call" as const,
										...entry,
									}))
								: undefined,
							modelId: result.model.modelId as ModelId,
							modelDisplayName: result.model.displayName,
							resolvedProviderId: result.model.providerId,
							depthMetadata: shared.depthMetadata,
							completionTurn: receipt,
						};
					} finally {
						await lifetime.finish();
					}
				})();
				return plain;
			},
			stream() {
				const events = run.stream();
				return {
					...shared,
					stream: (async function* () {
						try {
							yield* events;
						} finally {
							await lifetime.finish();
						}
					})(),
				};
			},
		};
	} catch (error) {
		await lifetime.finish();
		throw error;
	}
}
