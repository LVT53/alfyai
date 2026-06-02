import {
	createInlineThinkingState,
	flushInlineThinkingState,
	processInlineThinkingChunk,
} from "./stream-protocol";

export interface StreamMetadata {
	thinkingTokenCount?: number;
	responseTokenCount?: number;
	totalTokenCount?: number;
	thinking?: string;
	wasStopped?: boolean;
	userMessageId?: string;
	assistantMessageId?: string;
	modelId?: import("$lib/types").ModelId;
	modelDisplayName?: string;
	contextStatus?: import("$lib/types").ConversationContextStatus;
	contextSources?: import("$lib/types").ContextSourcesState | null;
	activeWorkingSet?: import("$lib/types").ArtifactSummary[];
	taskState?: import("$lib/types").TaskState | null;
	contextDebug?: import("$lib/types").ContextDebugState | null;
	messageEvidence?: import("$lib/types").MessageEvidenceSummary | null;
	generatedFiles?: import("$lib/types").ChatGeneratedFile[];
	contextCompressionSnapshots?: import("$lib/types").ContextCompressionMarker[];
}

export interface StreamTimingSnapshot {
	streamId: string;
	url: string;
	serverTiming?: string | null;
	outcome: "success" | "error" | "stopped" | "closed";
	phases: {
		fetchStartMs: number;
		responseHeadersMs?: number;
		firstByteMs?: number;
		firstTokenMs?: number;
		firstThinkingMs?: number;
		firstToolCallMs?: number;
		endMs?: number;
		errorMs?: number;
	};
}

export interface StreamCallbacks {
	onToken: (chunk: string) => void;
	onThinking: (chunk: string) => void;
	onEnd: (fullText: string, metadata?: StreamMetadata) => void;
	onError: (error: Error) => void;
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
}

export type { ModelId } from "$lib/types";

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
		thinking: parsed.thinking as StreamMetadata["thinking"] | undefined,
		wasStopped: parsed.wasStopped as StreamMetadata["wasStopped"] | undefined,
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
		contextCompressionSnapshots: parsed.contextCompressionSnapshots as
			| StreamMetadata["contextCompressionSnapshots"]
			| undefined,
	};
	return Object.values(nextMetadata).some((value) => value !== undefined)
		? nextMetadata
		: undefined;
}

function findNextSseBlockDelimiter(
	value: string,
): { index: number; length: number } | null {
	const delimiters = ["\r\n\r\n", "\n\n", "\r\r"] as const;
	let next: { index: number; length: number } | null = null;

	for (const delimiter of delimiters) {
		const index = value.indexOf(delimiter);
		if (index === -1) {
			continue;
		}
		if (!next || index < next.index) {
			next = { index, length: delimiter.length };
		}
	}

	return next;
}

type AiSdkUiStreamFrame =
	| { kind: "done"; rawData: string }
	| { kind: "part"; part: Record<string, unknown>; rawData: string };

function decodeAiSdkUiStreamFrameBlock(
	block: string,
): AiSdkUiStreamFrame | null {
	const dataLines: string[] = [];
	let namedEventSeen = false;

	for (const rawLine of block.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line || line.startsWith(":")) {
			continue;
		}

		const separatorIndex = line.indexOf(":");
		const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
		if (field === "event") {
			namedEventSeen = true;
			continue;
		}
		if (field !== "data") {
			continue;
		}

		let value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1);
		}
		dataLines.push(value);
	}

	if (namedEventSeen) {
		return null;
	}

	if (dataLines.length === 0) {
		return null;
	}

	const rawData = dataLines.join("\n").trim();
	if (rawData === "[DONE]") {
		return { kind: "done", rawData };
	}

	try {
		const parsed = JSON.parse(rawData);
		if (
			!parsed ||
			typeof parsed !== "object" ||
			typeof parsed.type !== "string"
		) {
			return null;
		}
		return { kind: "part", part: parsed as Record<string, unknown>, rawData };
	} catch {
		return null;
	}
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
	tokenCount?: number;
	thinkingCount?: number;
	toolCallCount?: number;
}

export async function getStreamBufferInfo(
	streamId: string,
): Promise<StreamBufferInfo | null> {
	try {
		const res = await fetch(
			`/api/chat/stream/buffer?streamId=${encodeURIComponent(streamId)}`,
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
	deepResearchDepth?: import("$lib/types").DeepResearchDepth | null;
	thinkingMode?: import("$lib/types").ThinkingMode;
	forceWebSearch?: boolean;
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
		deepResearchDepth,
		thinkingMode,
		forceWebSearch,
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
	const timingPhases: StreamTimingSnapshot["phases"] = { fetchStartMs: 0 };
	let serverTiming: string | null = null;
	let streamUrl = "/api/chat/stream";
	let timingReported = false;
	let stopRequested = false;
	let detached = false;
	let fullText = "";
	let latestMetadata: StreamMetadata | undefined;
	let terminalPartSeen = false;
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

	function markTimingPhase(name: keyof StreamTimingSnapshot["phases"]) {
		if (timingPhases[name] !== undefined) return;
		timingPhases[name] = elapsedMs();
	}

	function reportTiming(outcome: StreamTimingSnapshot["outcome"]) {
		if (timingReported) return;
		timingReported = true;
		callbacks.onTiming?.({
			streamId,
			url: streamUrl,
			serverTiming,
			outcome,
			phases: { ...timingPhases },
		});
	}

	function finishSuccessfully(metadata?: StreamMetadata): boolean {
		if (completed) {
			return true;
		}
		completed = true;
		markTimingPhase("endMs");
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
		markTimingPhase("firstThinkingMs");
		if (isReplaying) {
			replayThinkingBuffer.push(thinkingChunk);
		} else {
			callbacks.onThinking(thinkingChunk);
		}
	}

	function emitToolCall(data: unknown) {
		const parsed =
			data && typeof data === "object" ? (data as Record<string, unknown>) : {};
		markTimingPhase("firstToolCallMs");
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
						thinkingMode,
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
						pendingSkill: deepResearchDepth ? null : pendingSkill,
						deepResearch: deepResearchDepth
							? { depth: deepResearchDepth }
							: undefined,
						thinkingMode,
						forceWebSearch: forceWebSearch === true ? true : undefined,
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
			markTimingPhase("responseHeadersMs");
			serverTiming = res.headers.get("Server-Timing");

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
				markTimingPhase("errorMs");
				reportTiming("error");
				callbacks.onError(toStreamError(errorMessage, errorCode));
				return;
			}

			if (!res.body) {
				markTimingPhase("errorMs");
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
							markTimingPhase("firstTokenMs");
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
						latestMetadata = buildStreamMetadata(part.data);
						return false;

					case "data-tool-call": {
						emitToolCall(part.data);
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
						markTimingPhase("errorMs");
						reportTiming("error");
						callbacks.onError(toStreamError(errorMessage, errorCode));
						return true;
					}

					case "error": {
						const errorMessage =
							(typeof part.errorText === "string" && part.errorText) ||
							(typeof part.error === "string" && part.error) ||
							"Stream error";
						markTimingPhase("errorMs");
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
						terminalPartSeen = true;
						return false;

					default:
						return false;
				}
			};

			const processEventBlock = (block: string): boolean => {
				const uiFrame = decodeAiSdkUiStreamFrameBlock(block);
				if (uiFrame && processAiSdkUiFrame(uiFrame)) {
					return true;
				}
				return false;
			};

			const drainBuffer = (isFinalChunk = false): boolean => {
				let delimiter = findNextSseBlockDelimiter(buffer);
				while (delimiter) {
					const block = buffer.slice(0, delimiter.index);
					buffer = buffer.slice(delimiter.index + delimiter.length);
					if (processEventBlock(block)) {
						return true;
					}
					delimiter = findNextSseBlockDelimiter(buffer);
				}

				if (!isFinalChunk || !buffer) {
					return false;
				}

				const trailingBlock = buffer;
				buffer = "";
				return processEventBlock(trailingBlock);
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
						flushInlineBufferAtEnd();
						markTimingPhase("endMs");
						reportTiming("closed");
						callbacks.onEnd(fullText);
						break;
					}

					markTimingPhase("firstByteMs");
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
				markTimingPhase("endMs");
				reportTiming("stopped");
				callbacks.onEnd(fullText, { wasStopped: true });
			} else if (err instanceof Error) {
				markTimingPhase("errorMs");
				reportTiming("error");
				callbacks.onError(err);
			} else {
				markTimingPhase("errorMs");
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
