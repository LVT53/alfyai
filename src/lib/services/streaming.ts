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
			let currentEvent:
				| "token"
				| "thinking"
				| "end"
				| "error"
				| "tool_call"
				| "replay_start"
				| "replay_end"
				| "waiting"
				| null = null;

			const processLine = (rawLine: string): boolean => {
				const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

				if (line.startsWith("event: token")) {
					currentEvent = "token";
					return false;
				}
				if (line.startsWith("event: thinking")) {
					currentEvent = "thinking";
					return false;
				}
				if (line.startsWith("event: tool_call")) {
					currentEvent = "tool_call";
					return false;
				}
				if (line.startsWith("event: end")) {
					currentEvent = "end";
					return false;
				}
				if (line.startsWith("event: error")) {
					currentEvent = "error";
					return false;
				}
				if (line.startsWith("event: replay_start")) {
					currentEvent = "replay_start";
					return false;
				}
				if (line.startsWith("event: replay_end")) {
					currentEvent = "replay_end";
					return false;
				}
				if (line.startsWith("event: waiting")) {
					currentEvent = "waiting";
					return false;
				}
				if (line.startsWith("data: ")) {
					const rawData = line.slice("data: ".length);

					if (currentEvent === "token") {
						try {
							const parsed = JSON.parse(rawData);
							const chunk =
								parsed.text ?? (typeof parsed === "string" ? parsed : "");
							if (chunk) {
								markTimingPhase("firstTokenMs");
								if (isReplaying) {
									replayTokenBuffer.push(chunk);
								} else {
									emitInlineChunk(chunk);
								}
							}
						} catch {
							/* noop */
						}
						return false;
					}

					if (currentEvent === "thinking") {
						try {
							const parsed = JSON.parse(rawData);
							const rawThinking =
								parsed.text ?? (typeof parsed === "string" ? parsed : "");
							if (!rawThinking) return false;
							const thinkingChunk = rawThinking.replace(
								/<tool_calls>[\r\n]*[\r\n\ta-zA-Z0-9_./:,'"{}\u4e00-\u9fff-]*?<\/tool_calls>/gi,
								"",
							);
							if (thinkingChunk) {
								markTimingPhase("firstThinkingMs");
								if (isReplaying) {
									replayThinkingBuffer.push(thinkingChunk);
								} else {
									callbacks.onThinking(thinkingChunk);
								}
							}
						} catch {
							/* noop */
						}
						return false;
					}

					if (currentEvent === "tool_call") {
						try {
							const parsed = JSON.parse(rawData);
							markTimingPhase("firstToolCallMs");
							callbacks.onToolCall?.(
								parsed.name,
								parsed.input ?? {},
								parsed.status,
								{
									callId: parsed.callId,
									outputSummary: parsed.outputSummary,
									sourceType: parsed.sourceType,
									candidates: parsed.candidates,
									metadata: parsed.metadata,
								},
							);
						} catch {
							/* noop */
						}
						return false;
					}

					if (currentEvent === "end") {
						let metadata: StreamMetadata | undefined;
						try {
							const parsed = JSON.parse(rawData);
							const nextMetadata: StreamMetadata = {
								thinkingTokenCount: parsed.thinkingTokenCount,
								responseTokenCount: parsed.responseTokenCount,
								totalTokenCount: parsed.totalTokenCount,
								thinking: parsed.thinking,
								wasStopped: parsed.wasStopped,
								userMessageId: parsed.userMessageId,
								assistantMessageId: parsed.assistantMessageId,
								modelId: parsed.modelId,
								modelDisplayName: parsed.modelDisplayName,
								contextStatus: parsed.contextStatus,
								contextSources: parsed.contextSources,
								activeWorkingSet: parsed.activeWorkingSet,
								taskState: parsed.taskState,
								contextDebug: parsed.contextDebug,
								messageEvidence: parsed.messageEvidence,
								generatedFiles: parsed.generatedFiles,
							};
							metadata = Object.values(nextMetadata).some(
								(value) => value !== undefined,
							)
								? nextMetadata
								: undefined;
						} catch {
							/* noop */
						}
						markTimingPhase("endMs");
						flushInlineBufferAtEnd();
						reportTiming("success");
						callbacks.onEnd(fullText, metadata);
						return true;
					}

					if (currentEvent === "error") {
						let errorMessage = "Stream error";
						let errorCode: string | undefined;
						try {
							const parsed = JSON.parse(rawData);
							errorMessage = parsed.message ?? parsed.error ?? errorMessage;
							errorCode = parsed.code;
						} catch {
							errorMessage = rawData || errorMessage;
						}
						markTimingPhase("errorMs");
						reportTiming("error");
						callbacks.onError(toStreamError(errorMessage, errorCode));
						return true;
					}

					if (currentEvent === "replay_start") {
						isReplaying = true;
						replayTokenBuffer.length = 0;
						replayThinkingBuffer.length = 0;
						console.info("[STREAM] Replay started");
						return false;
					}

					if (currentEvent === "replay_end") {
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
						return false;
					}

					if (currentEvent === "waiting") {
						console.info("[STREAM] Waiting for original stream to complete");
						flushInlineBufferAtEnd();
						callbacks.onWaiting?.();
						return false;
					}

					return false;
				}

				if (line === "") {
					currentEvent = null;
				}

				return false;
			};

			const drainBuffer = (isFinalChunk = false): boolean => {
				const lines = buffer.split("\n");
				buffer = isFinalChunk ? "" : (lines.pop() ?? "");

				if (isFinalChunk && lines[lines.length - 1] !== "") {
					lines.push("");
				}

				for (const line of lines) {
					if (processLine(line)) {
						return true;
					}
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
