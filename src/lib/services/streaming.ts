import {
	isNormalChatContextPreparationActivityClass,
	type ModelId,
	type ResponseActivityEntry,
} from "$lib/types";
import {
	type AiSdkUiStreamFrame,
	consumeAiSdkUiStreamFrames,
	extractAiSdkUiStreamMetadataData,
	type UiMessageStreamPart,
} from "./ai-sdk-ui-stream-contract";
import {
	createInlineThinkingState,
	flushInlineThinkingState,
	processInlineThinkingChunk,
} from "./stream-protocol";
import {
	BROWSER_STREAM_TIMING_MARKS,
	type BrowserStreamTimingRecord,
	parseServerTimingHeader,
	recordDurationStreamTimelineMark,
	type StreamTimelineTerminalPayload,
	type StreamTimelineTimingRecord,
} from "./stream-timeline";

export interface StreamMetadata {
	thinkingTokenCount?: number;
	responseTokenCount?: number;
	totalTokenCount?: number;
	totalCostUsdMicros?: number;
	totalTokens?: number;
	thinking?: string;
	wasStopped?: boolean;
	completionWarning?: string;
	upstreamFinishReason?: string;
	upstreamRawFinishReason?: string;
	streamClosedWithoutFinish?: boolean;
	userMessageId?: string;
	assistantMessageId?: string;
	modelId?: import("$lib/types").ModelId;
	modelDisplayName?: string;
	providerDisplayName?: string;
	providerIconUrl?: string;
	depthMetadata?: import("$lib/types").DepthMetadata;
	contextStatus?: import("$lib/types").ConversationContextStatus;
	contextSources?: import("$lib/types").ContextSourcesState | null;
	activeWorkingSet?: import("$lib/types").ArtifactSummary[];
	taskState?: import("$lib/types").TaskState | null;
	contextDebug?: import("$lib/types").ContextDebugState | null;
	messageEvidence?: import("$lib/types").MessageEvidenceSummary | null;
	generatedFiles?: import("$lib/types").ChatGeneratedFile[];
	fileProductionJobs?: import("$lib/types").FileProductionJob[];
	contextCompressionSnapshots?: import("$lib/types").ContextCompressionMarker[];
	generationDurationMs?: number;
	serverTimeline?: StreamTimelineTerminalPayload;
}

export interface StreamTimingSnapshot {
	streamId: string;
	url: string;
	serverTiming?: string | null;
	parsedServerTiming?: StreamTimelineTimingRecord;
	serverTimeline?: StreamTimelineTerminalPayload;
	outcome: "success" | "error" | "stopped" | "closed";
	phases: BrowserStreamTimingRecord;
}

export type StreamFinishPart = Extract<UiMessageStreamPart, { type: "finish" }>;

export interface StreamCallbacks {
	onToken: (chunk: string) => void;
	onThinking: (chunk: string) => void;
	onEnd: (fullText: string, metadata?: StreamMetadata) => void;
	onError: (error: Error) => void;
	onFinishPart?: (part: StreamFinishPart) => void;
	onTiming?: (timing: StreamTimingSnapshot) => void;
	onWaiting?: () => void;
	onToolCall?: (
		name: string,
		input: Record<string, unknown>,
		status: "running" | "done",
		details?: {
			callId?: string;
			outputSummary?: string | null;
			sourceType?: import("$lib/types").EvidenceSourceType | null;
			candidates?: import("$lib/types").ToolEvidenceCandidate[];
			metadata?: Record<string, string | number | boolean | null>;
		},
	) => void;
	onResponseActivity?: (entry: ResponseActivityEntry) => void;
}

export type { ModelId };

export interface StreamHandle {
	stop: () => void;
	detach: () => void;
}

function toStreamError(message: string, code?: string): Error {
	const error = new Error(message) as Error & { code?: string };
	if (code) {
		error.code = code;
	}
	return error;
}

const TOOL_CALLS_BLOCK_PATTERN =
	/<tool_calls>[\r\n]*[\r\n\ta-zA-Z0-9_./:,'"{}\u4e00-\u9fff-]*?<\/tool_calls>/gi;

function buildStreamMetadata(data: unknown): StreamMetadata | undefined {
	const parsed =
		data && typeof data === "object" ? (data as Record<string, unknown>) : {};
	const nextMetadata: StreamMetadata = {
		thinkingTokenCount: parsed.thinkingTokenCount as
			| StreamMetadata["thinkingTokenCount"]
			| undefined,
		responseTokenCount: parsed.responseTokenCount as
			| StreamMetadata["responseTokenCount"]
			| undefined,
		totalTokenCount: parsed.totalTokenCount as
			| StreamMetadata["totalTokenCount"]
			| undefined,
		totalCostUsdMicros: parsed.totalCostUsdMicros as
			| StreamMetadata["totalCostUsdMicros"]
			| undefined,
		totalTokens: parsed.totalTokens as
			| StreamMetadata["totalTokens"]
			| undefined,
		thinking: parsed.thinking as StreamMetadata["thinking"] | undefined,
		wasStopped: parsed.wasStopped as StreamMetadata["wasStopped"] | undefined,
		completionWarning: parsed.completionWarning as
			| StreamMetadata["completionWarning"]
			| undefined,
		upstreamFinishReason: parsed.upstreamFinishReason as
			| StreamMetadata["upstreamFinishReason"]
			| undefined,
		upstreamRawFinishReason: parsed.upstreamRawFinishReason as
			| StreamMetadata["upstreamRawFinishReason"]
			| undefined,
		streamClosedWithoutFinish: parsed.streamClosedWithoutFinish as
			| StreamMetadata["streamClosedWithoutFinish"]
			| undefined,
		userMessageId: parsed.userMessageId as
			| StreamMetadata["userMessageId"]
			| undefined,
		assistantMessageId: parsed.assistantMessageId as
			| StreamMetadata["assistantMessageId"]
			| undefined,
		modelId: parsed.modelId as StreamMetadata["modelId"] | undefined,
		modelDisplayName: parsed.modelDisplayName as
			| StreamMetadata["modelDisplayName"]
			| undefined,
		providerDisplayName: parsed.providerDisplayName as
			| StreamMetadata["providerDisplayName"]
			| undefined,
		providerIconUrl: parsed.providerIconUrl as
			| StreamMetadata["providerIconUrl"]
			| undefined,
		depthMetadata: parsed.depthMetadata as
			| StreamMetadata["depthMetadata"]
			| undefined,
		contextStatus: parsed.contextStatus as
			| StreamMetadata["contextStatus"]
			| undefined,
		contextSources: parsed.contextSources as
			| StreamMetadata["contextSources"]
			| undefined,
		activeWorkingSet: parsed.activeWorkingSet as
			| StreamMetadata["activeWorkingSet"]
			| undefined,
		taskState: parsed.taskState as StreamMetadata["taskState"] | undefined,
		contextDebug: parsed.contextDebug as
			| StreamMetadata["contextDebug"]
			| undefined,
		messageEvidence: parsed.messageEvidence as
			| StreamMetadata["messageEvidence"]
			| undefined,
		generatedFiles: parsed.generatedFiles as
			| StreamMetadata["generatedFiles"]
			| undefined,
		fileProductionJobs: parsed.fileProductionJobs as
			| StreamMetadata["fileProductionJobs"]
			| undefined,
		contextCompressionSnapshots: parsed.contextCompressionSnapshots as
			| StreamMetadata["contextCompressionSnapshots"]
			| undefined,
		generationDurationMs: parsed.generationDurationMs as
			| StreamMetadata["generationDurationMs"]
			| undefined,
		serverTimeline: parsed.serverTimeline as
			| StreamMetadata["serverTimeline"]
			| undefined,
	};
	return Object.values(nextMetadata).some((value) => value !== undefined)
		? nextMetadata
		: undefined;
}

function isResponseActivityKind(
	value: unknown,
): value is ResponseActivityEntry["kind"] {
	return (
		value === "depth" ||
		value === "deliberation" ||
		value === "context" ||
		value === "tool" ||
		value === "source" ||
		value === "drafting" ||
		value === "fallback" ||
		value === "file"
	);
}

function isResponseActivityStatus(
	value: unknown,
): value is ResponseActivityEntry["status"] {
	return value === "running" || value === "done" || value === "error";
}

function isResponseActivitySourceType(
	value: unknown,
): value is NonNullable<ResponseActivityEntry["sourceType"]> {
	return (
		value === "web" ||
		value === "document" ||
		value === "memory" ||
		value === "tool"
	);
}

function buildResponseActivityEntry(
	data: unknown,
): ResponseActivityEntry | null {
	const parsed =
		data && typeof data === "object" ? (data as Record<string, unknown>) : {};
	if (
		typeof parsed.id !== "string" ||
		!parsed.id ||
		!isResponseActivityKind(parsed.kind) ||
		!isResponseActivityStatus(parsed.status)
	) {
		return null;
	}

	return {
		id: parsed.id,
		kind: parsed.kind,
		status: parsed.status,
		...(typeof parsed.label === "string" ? { label: parsed.label } : {}),
		...(typeof parsed.detail === "string" ? { detail: parsed.detail } : {}),
		...(typeof parsed.callId === "string" ? { callId: parsed.callId } : {}),
		...(typeof parsed.toolName === "string"
			? { toolName: parsed.toolName }
			: {}),
		...(isResponseActivitySourceType(parsed.sourceType)
			? { sourceType: parsed.sourceType }
			: {}),
		...(parsed.kind === "context" &&
		isNormalChatContextPreparationActivityClass(parsed.contextPreparationClass)
			? { contextPreparationClass: parsed.contextPreparationClass }
			: {}),
		...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
		...(typeof parsed.url === "string" ? { url: parsed.url } : {}),
		...(typeof parsed.count === "number" ? { count: parsed.count } : {}),
		...(typeof parsed.passIndex === "number"
			? { passIndex: parsed.passIndex }
			: {}),
		...(typeof parsed.passTotal === "number"
			? { passTotal: parsed.passTotal }
			: {}),
		...(typeof parsed.passKind === "string"
			? { passKind: parsed.passKind }
			: {}),
		...(typeof parsed.occurredAt === "number"
			? { occurredAt: parsed.occurredAt }
			: {}),
	};
}

export async function checkForOrphanedStream(
	conversationId: string,
): Promise<string | null> {
	try {
		const res = await fetch(
			`/api/chat/stream/status?conversationId=${encodeURIComponent(conversationId)}`,
		);
		if (!res.ok) return null;
		const data = await res.json();
		return data.hasOrphanedStream ? data.streamId : null;
	} catch {
		return null;
	}
}

export interface StreamBufferInfo {
	exists: boolean;
	userMessage?: string;
	reasoningDepth?: import("$lib/types").ReasoningDepth;
	tokenCount?: number;
	thinkingCount?: number;
	toolCallCount?: number;
	activityCount?: number;
	createdAt?: number;
}

export async function getStreamBufferInfo(
	streamId: string,
	conversationId: string,
): Promise<StreamBufferInfo | null> {
	try {
		const res = await fetch(
			`/api/chat/stream/buffer?streamId=${encodeURIComponent(streamId)}&conversationId=${encodeURIComponent(conversationId)}`,
		);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

async function requestServerSideStreamStop(streamId: string): Promise<void> {
	try {
		await fetch("/api/chat/stream/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ streamId }),
		});
	} catch {
		/* noop */
	}
}

export type StreamChatOptions = {
	modelId?: ModelId;
	skipPersistUserMessage?: boolean;
	attachmentIds?: string[];
	linkedSources?: import("$lib/types").LinkedContextSource[];
	pendingSkill?: import("$lib/types").PendingSkillSelection | null;
	reasoningDepth?: import("$lib/types").ReasoningDepth;
	forceWebSearch?: boolean;
	// Issue 7.2 — composer connection capability selection for this turn.
	// undefined/omitted means "no client selection" — the server falls back
	// to the user's defaultOn set.
	enabledConnectionCapabilities?: string[];
	activeDocumentArtifactId?: string;
	personalityProfileId?: string | null;
	retryAssistantMessageId?: string;
	retryUserMessageId?: string;
	retryUserMessage?: string;
	confirmForkedSourceHistoryMutation?: boolean;
	reconnectToStreamId?: string;
	reconnectUserMessage?: string;
};

export function streamChat(
	message: string,
	conversationId: string,
	callbacks: StreamCallbacks,
	options?: StreamChatOptions,
): StreamHandle {
	const {
		modelId,
		skipPersistUserMessage,
		attachmentIds,
		linkedSources,
		pendingSkill,
		reasoningDepth,
		forceWebSearch,
		enabledConnectionCapabilities,
		activeDocumentArtifactId,
		personalityProfileId,
		retryAssistantMessageId,
		retryUserMessageId,
		retryUserMessage,
		confirmForkedSourceHistoryMutation,
		reconnectToStreamId,
		reconnectUserMessage,
	} = options ?? {};
	const controller = new AbortController();
	const streamId = reconnectToStreamId ?? crypto.randomUUID();
	const timingStart =
		typeof performance !== "undefined" && typeof performance.now === "function"
			? performance.now()
			: Date.now();
	const timingPhases: StreamTimingSnapshot["phases"] = {
		[BROWSER_STREAM_TIMING_MARKS.FETCH_START]: 0,
	};
	let serverTiming: string | null = null;
	let parsedServerTiming: StreamTimelineTimingRecord | undefined;
	let streamUrl = "/api/chat/stream";
	let timingReported = false;
	let stopRequested = false;
	let detached = false;
	let fullText = "";
	let latestMetadata: StreamMetadata | undefined;
	let terminalPartSeen = false;
	let finishPartReported = false;
	let completed = false;
	const inlineThinkingState = createInlineThinkingState();
	let isReplaying = false;
	const replayTokenBuffer: string[] = [];
	const replayThinkingBuffer: string[] = [];

	function emitInlineChunk(chunk: string) {
		void processInlineThinkingChunk(inlineThinkingState, chunk, {
			onVisible(visibleChunk) {
				fullText += visibleChunk;
				callbacks.onToken(visibleChunk);
			},
			onThinking(thinkingChunk) {
				callbacks.onThinking(thinkingChunk);
			},
		});
	}

	function flushInlineBufferAtEnd() {
		void flushInlineThinkingState(inlineThinkingState, {
			onVisible(visibleChunk) {
				fullText += visibleChunk;
				callbacks.onToken(visibleChunk);
			},
			onThinking(thinkingChunk) {
				callbacks.onThinking(thinkingChunk);
			},
		});
	}

	function elapsedMs(): number {
		const now =
			typeof performance !== "undefined" &&
			typeof performance.now === "function"
				? performance.now()
				: Date.now();
		return Math.max(0, now - timingStart);
	}

	function markTimingPhase(name: keyof BrowserStreamTimingRecord) {
		recordDurationStreamTimelineMark(timingPhases, name, elapsedMs());
	}

	function reportTiming(outcome: StreamTimingSnapshot["outcome"]) {
		if (timingReported) return;
		timingReported = true;
		callbacks.onTiming?.({
			streamId,
			url: streamUrl,
			serverTiming,
			...(parsedServerTiming
				? { parsedServerTiming: { ...parsedServerTiming } }
				: {}),
			...(latestMetadata?.serverTimeline
				? { serverTimeline: latestMetadata.serverTimeline }
				: {}),
			outcome,
			phases: { ...timingPhases },
		});
	}

	function finishSuccessfully(metadata?: StreamMetadata): boolean {
		if (completed) {
			return true;
		}
		completed = true;
		markTimingPhase(BROWSER_STREAM_TIMING_MARKS.END);
		flushInlineBufferAtEnd();
		reportTiming("success");
		callbacks.onEnd(fullText, metadata);
		return true;
	}

	function emitThinkingChunk(rawThinking: string) {
		const thinkingChunk = rawThinking.replace(TOOL_CALLS_BLOCK_PATTERN, "");
		if (!thinkingChunk) {
			return;
		}
		markTimingPhase(BROWSER_STREAM_TIMING_MARKS.FIRST_THINKING);
		if (isReplaying) {
			replayThinkingBuffer.push(thinkingChunk);
		} else {
			callbacks.onThinking(thinkingChunk);
		}
	}

	function emitToolCall(data: unknown) {
		const parsed =
			data && typeof data === "object" ? (data as Record<string, unknown>) : {};
		markTimingPhase(BROWSER_STREAM_TIMING_MARKS.FIRST_TOOL_CALL);
		callbacks.onToolCall?.(
			parsed.name as string,
			(parsed.input as Record<string, unknown> | undefined) ?? {},
			parsed.status as "running" | "done",
			{
				callId: parsed.callId as string | undefined,
				outputSummary: parsed.outputSummary as string | null | undefined,
				sourceType: parsed.sourceType as
					| import("$lib/types").EvidenceSourceType
					| null
					| undefined,
				candidates: parsed.candidates as
					| import("$lib/types").ToolEvidenceCandidate[]
					| undefined,
				metadata: parsed.metadata as
					| Record<string, string | number | boolean | null>
					| undefined,
			},
		);
	}

	function emitResponseActivity(data: unknown) {
		markTimingPhase(BROWSER_STREAM_TIMING_MARKS.FIRST_RESPONSE_ACTIVITY);
		const entry = buildResponseActivityEntry(data);
		if (!entry) return;
		callbacks.onResponseActivity?.(entry);
	}

	function startReplayBuffer() {
		isReplaying = true;
		replayTokenBuffer.length = 0;
		replayThinkingBuffer.length = 0;
		console.info("[STREAM] Replay started");
	}

	function flushReplayBuffer() {
		console.info(
			"[STREAM] Replay ended, flushing",
			replayTokenBuffer.length,
			"tokens,",
			replayThinkingBuffer.length,
			"thinking chunks",
		);
		isReplaying = false;
		for (const chunk of replayTokenBuffer) {
			emitInlineChunk(chunk);
		}
		for (const chunk of replayThinkingBuffer) {
			callbacks.onThinking(chunk);
		}
		void flushInlineThinkingState(inlineThinkingState, {
			onVisible(visibleChunk) {
				fullText += visibleChunk;
				callbacks.onToken(visibleChunk);
			},
			onThinking(thinkingChunk) {
				callbacks.onThinking(thinkingChunk);
			},
		});
	}

	function emitWaiting() {
		console.info("[STREAM] Waiting for original stream to complete");
		flushInlineBufferAtEnd();
		callbacks.onWaiting?.();
	}

	(async () => {
		try {
			const url = retryAssistantMessageId
				? "/api/chat/retry"
				: "/api/chat/stream";
			streamUrl = url;
			const body = retryAssistantMessageId
				? JSON.stringify({
						conversationId,
						assistantMessageId: retryAssistantMessageId,
						userMessageId: retryUserMessageId,
						userMessage: retryUserMessage ?? message,
						streamId,
						model: modelId,
						reasoningDepth,
						attachmentIds,
						activeDocumentArtifactId,
						personalityProfileId,
						confirmForkedSourceHistoryMutation:
							confirmForkedSourceHistoryMutation === true ? true : undefined,
					})
				: JSON.stringify({
						message,
						conversationId,
						streamId,
						model: modelId,
						skipPersistUserMessage,
						attachmentIds,
						linkedSources,
						pendingSkill,
						reasoningDepth,
						forceWebSearch: forceWebSearch === true ? true : undefined,
						enabledConnectionCapabilities,
						activeDocumentArtifactId,
						personalityProfileId,
						reconnectToStreamId,
						userMessage: reconnectUserMessage,
					});
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
				signal: controller.signal,
			});
			markTimingPhase(BROWSER_STREAM_TIMING_MARKS.RESPONSE_HEADERS);
			serverTiming = res.headers.get("Server-Timing");
			parsedServerTiming = serverTiming
				? parseServerTimingHeader(serverTiming)
				: undefined;

			if (!res.ok) {
				let errorMessage = `HTTP ${res.status}`;
				let errorCode: string | undefined;
				try {
					const json = await res.json();
					errorMessage = json.error ?? errorMessage;
					errorCode = json.code;
				} catch {
					/* noop */
				}
				markTimingPhase(BROWSER_STREAM_TIMING_MARKS.ERROR);
				reportTiming("error");
				callbacks.onError(toStreamError(errorMessage, errorCode));
				return;
			}

			if (!res.body) {
				markTimingPhase(BROWSER_STREAM_TIMING_MARKS.ERROR);
				reportTiming("error");
				callbacks.onError(toStreamError("Response has no body"));
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			const processAiSdkUiFrame = (frame: AiSdkUiStreamFrame): boolean => {
				if (frame.kind === "done") {
					return finishSuccessfully(latestMetadata);
				}

				const { part } = frame;
				switch (part.type) {
					case "text-delta": {
						const chunk =
							typeof part.delta === "string"
								? part.delta
								: typeof part.text === "string"
									? part.text
									: "";
						if (chunk) {
							markTimingPhase(BROWSER_STREAM_TIMING_MARKS.FIRST_TOKEN);
							if (isReplaying) {
								replayTokenBuffer.push(chunk);
							} else {
								emitInlineChunk(chunk);
							}
						}
						return false;
					}

					case "reasoning-delta": {
						const rawThinking =
							typeof part.delta === "string"
								? part.delta
								: typeof part.text === "string"
									? part.text
									: "";
						emitThinkingChunk(rawThinking);
						return false;
					}

					case "data-stream-metadata":
						latestMetadata = buildStreamMetadata(
							extractAiSdkUiStreamMetadataData(part),
						);
						return false;

					case "data-tool-call": {
						emitToolCall(part.data);
						return false;
					}

					case "data-response-activity": {
						emitResponseActivity(part.data);
						return false;
					}

					case "data-stream-error": {
						const parsed =
							part.data && typeof part.data === "object"
								? (part.data as Record<string, unknown>)
								: {};
						const errorMessage =
							(typeof part.data === "string" && part.data) ||
							(typeof parsed.message === "string" && parsed.message) ||
							(typeof parsed.error === "string" && parsed.error) ||
							"Stream error";
						const errorCode =
							typeof parsed.code === "string" ? parsed.code : undefined;
						markTimingPhase(BROWSER_STREAM_TIMING_MARKS.ERROR);
						reportTiming("error");
						callbacks.onError(toStreamError(errorMessage, errorCode));
						return true;
					}

					case "error": {
						const errorMessage =
							(typeof part.errorText === "string" && part.errorText) ||
							(typeof part.error === "string" && part.error) ||
							"Stream error";
						markTimingPhase(BROWSER_STREAM_TIMING_MARKS.ERROR);
						reportTiming("error");
						callbacks.onError(toStreamError(errorMessage));
						return true;
					}

					case "data-replay-start":
						startReplayBuffer();
						return false;

					case "data-replay-end":
						flushReplayBuffer();
						return false;

					case "data-waiting":
						emitWaiting();
						return false;

					case "finish":
						if (!finishPartReported) {
							finishPartReported = true;
							callbacks.onFinishPart?.(part as StreamFinishPart);
						}
						terminalPartSeen = true;
						return false;

					default:
						return false;
				}
			};

			const drainBuffer = (isFinalChunk = false): boolean => {
				const result = consumeAiSdkUiStreamFrames(buffer);
				buffer = result.remaining;

				for (const frame of result.frames) {
					if (processAiSdkUiFrame(frame)) {
						return true;
					}
				}

				if (isFinalChunk) {
					buffer = "";
				}
				return false;
			};

			try {
				while (true) {
					const { done, value } = await reader.read();

					if (done) {
						buffer += decoder.decode();
						if (drainBuffer(true)) {
							break;
						}
						if (terminalPartSeen) {
							finishSuccessfully(latestMetadata);
							break;
						}
						markTimingPhase(BROWSER_STREAM_TIMING_MARKS.END);
						reportTiming("closed");
						callbacks.onError(
							toStreamError("Stream closed before a terminal completion event"),
						);
						break;
					}

					markTimingPhase(BROWSER_STREAM_TIMING_MARKS.FIRST_BYTE);
					buffer += decoder.decode(value, { stream: true });
					if (drainBuffer()) {
						return;
					}
				}
			} finally {
				reader.releaseLock();
			}
		} catch (err) {
			if (detached) {
				return;
			}
			if (stopRequested) {
				markTimingPhase(BROWSER_STREAM_TIMING_MARKS.STOP);
				markTimingPhase(BROWSER_STREAM_TIMING_MARKS.END);
				reportTiming("stopped");
				callbacks.onEnd(fullText, { wasStopped: true });
			} else if (err instanceof Error) {
				markTimingPhase(BROWSER_STREAM_TIMING_MARKS.ERROR);
				reportTiming("error");
				callbacks.onError(err);
			} else {
				markTimingPhase(BROWSER_STREAM_TIMING_MARKS.ERROR);
				reportTiming("error");
				callbacks.onError(toStreamError(String(err)));
			}
		}
	})();

	return {
		stop() {
			if (stopRequested || detached) {
				return;
			}
			stopRequested = true;
			markTimingPhase(BROWSER_STREAM_TIMING_MARKS.STOP);
			void requestServerSideStreamStop(streamId);
			controller.abort();
		},
		detach() {
			if (stopRequested || detached) {
				return;
			}
			detached = true;
			controller.abort();
		},
	};
}
