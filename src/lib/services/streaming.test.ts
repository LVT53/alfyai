import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	aiSdkUiStreamCloseAfterFinishSequence,
	aiSdkUiStreamContractMetadata,
	aiSdkUiStreamContractSequence,
	aiSdkUiStreamContractToolCall,
	aiSdkUiStreamReplaySequence,
	encodeAiSdkUiFixtureFrames,
	malformedAiSdkUiStreamFrames,
	oldBrowserSseNamedTokenEvent,
} from "../../../tests/fixtures/ai-sdk-ui-stream-contract";
import type { StreamCallbacks, StreamMetadata } from "./streaming";
import { streamChat } from "./streaming";
import {
	buildControlledFetchResponse,
	endEvent,
	errorEvent,
	flushMicrotasks,
	makeCallbacks,
	makeEventLogCallbacks,
	parseLastStreamRequestBody,
	runStreamAndWait,
	runStreamWithMockedResponse,
	thinkingEvent,
	tokenEvent,
	uiFrame,
} from "./streaming.test-helpers";

describe("streamChat", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("decodes the shared AI SDK UI stream contract fixture end-to-end", async () => {
		const onToolCall = vi.fn();
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: encodeAiSdkUiFixtureFrames(aiSdkUiStreamContractSequence),
			callbacks: {
				...makeCallbacks(),
				onToolCall,
			},
		});
		await done;

		expect(cb.onThinking).toHaveBeenCalledWith("Need current evidence.");
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Hello");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, " world");
		expect(onToolCall).toHaveBeenCalledWith(
			aiSdkUiStreamContractToolCall.name,
			aiSdkUiStreamContractToolCall.input,
			aiSdkUiStreamContractToolCall.status,
			{
				callId: aiSdkUiStreamContractToolCall.callId,
				outputSummary: aiSdkUiStreamContractToolCall.outputSummary,
				sourceType: aiSdkUiStreamContractToolCall.sourceType,
				candidates: aiSdkUiStreamContractToolCall.candidates,
				metadata: aiSdkUiStreamContractToolCall.metadata,
			},
		);
		expect(cb.onEnd).toHaveBeenCalledWith(
			"Hello world",
			aiSdkUiStreamContractMetadata,
		);
	});

	it("ignores old Browser SSE named token events without partial rendering", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [oldBrowserSseNamedTokenEvent, uiFrame("[DONE]")],
		});
		await done;

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();
		expect(cb.onEnd).toHaveBeenCalledWith("", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("ignores malformed AI SDK UI stream fixture frames without partial rendering", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [...malformedAiSdkUiStreamFrames, uiFrame("[DONE]")],
		});
		await done;

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();
		expect(cb.onEnd).toHaveBeenCalledWith("", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("finishes successfully when the stream closes after the finish fixture frame", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: encodeAiSdkUiFixtureFrames(
				aiSdkUiStreamCloseAfterFinishSequence,
			),
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Hello", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("buffers the shared replay fixture until replay-end before waiting", async () => {
		const consoleInfo = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);

		const events: string[] = [];
		const { done } = runStreamWithMockedResponse({
			responseChunks: encodeAiSdkUiFixtureFrames(aiSdkUiStreamReplaySequence),
			callbacks: makeEventLogCallbacks(events),
		});
		await done;

		expect(events).toEqual([
			"token:Hello",
			"thinking:Need current evidence.",
			"waiting",
			"end:Hello",
		]);
		consoleInfo.mockRestore();
	});

	it("calls onToken for AI SDK UI text-delta frames and ends on [DONE]", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({ type: "text-delta", id: "text-1", delta: "Hello" }),
				uiFrame({ type: "text-delta", id: "text-1", delta: " world" }),
				uiFrame("[DONE]"),
			],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Hello");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, " world");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello world", undefined);
	});

	it("maps AI SDK UI reasoning, metadata, and finish frames onto existing callbacks", async () => {
		const metadata = {
			thinkingTokenCount: 4,
			responseTokenCount: 5,
			totalTokenCount: 9,
			assistantMessageId: "assistant-1",
			modelDisplayName: "Model 1",
		};
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "reasoning-delta",
					id: "reasoning-1",
					delta: "Need to reason",
				}),
				uiFrame({ type: "text-delta", id: "text-1", delta: "Answer" }),
				uiFrame({
					type: "data-stream-metadata",
					data: metadata,
					transient: true,
				}),
				uiFrame({ type: "finish" }),
			],
		});
		await done;

		expect(cb.onThinking).toHaveBeenCalledOnce();
		expect(cb.onThinking).toHaveBeenCalledWith("Need to reason");
		expect(cb.onToken).toHaveBeenCalledWith("Answer");
		expect(cb.onEnd).toHaveBeenCalledWith("Answer", metadata);
	});

	it("calls terminal callbacks once when finish is followed by DONE", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("Answer"), endEvent()],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledOnce();
		expect(cb.onEnd).toHaveBeenCalledWith("Answer", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("reports the decoded finish part once before DONE while preserving single onEnd completion", async () => {
		const events: string[] = [];
		const callbacks = {
			...makeCallbacks(),
			onFinishPart: vi.fn((part: { finishReason?: string }) => {
				events.push(`finish:${part.finishReason ?? ""}`);
			}),
		};
		callbacks.onEnd.mockImplementation((fullText) => {
			events.push(`end:${fullText}`);
		});

		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				tokenEvent("Answer"),
				uiFrame({ type: "finish", finishReason: "stop" }),
				uiFrame({ type: "finish", finishReason: "stop" }),
				uiFrame("[DONE]"),
			],
			callbacks,
		});
		await done;

		expect(callbacks.onFinishPart).toHaveBeenCalledOnce();
		expect(callbacks.onFinishPart).toHaveBeenCalledWith({
			type: "finish",
			finishReason: "stop",
		});
		expect(callbacks.onEnd).toHaveBeenCalledOnce();
		expect(callbacks.onEnd).toHaveBeenCalledWith("Answer", undefined);
		expect(events).toEqual(["finish:stop", "end:Answer"]);
	});

	it("maps AI SDK UI tool-call data parts onto the existing tool callback", async () => {
		const onToolCall = vi.fn();
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-tool-call",
					data: {
						callId: "call-1",
						name: "web_search",
						input: { query: "OpenAI news" },
						status: "running",
						outputSummary: null,
						sourceType: "web",
						candidates: [
							{
								id: "src-1",
								title: "OpenAI",
								url: "https://openai.com",
								sourceType: "web",
							},
						],
						metadata: { count: 1 },
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			],
			callbacks: {
				...makeCallbacks(),
				onToolCall,
			},
		});
		await done;

		expect(onToolCall).toHaveBeenCalledWith(
			"web_search",
			{ query: "OpenAI news" },
			"running",
			{
				callId: "call-1",
				outputSummary: null,
				sourceType: "web",
				candidates: [
					{
						id: "src-1",
						title: "OpenAI",
						url: "https://openai.com",
						sourceType: "web",
					},
				],
				metadata: { count: 1 },
			},
		);
	});

	it("maps AI SDK UI response-activity data parts onto the activity callback", async () => {
		const onResponseActivity = vi.fn();
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "context-ready",
						kind: "context",
						status: "done",
						count: 3,
						occurredAt: 123,
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			],
			callbacks: {
				...makeCallbacks(),
				onResponseActivity,
			},
		});
		await done;

		expect(onResponseActivity).toHaveBeenCalledWith({
			id: "context-ready",
			kind: "context",
			status: "done",
			count: 3,
			occurredAt: 123,
		});
	});

	it("preserves only known sanitized context preparation classes on response activity", async () => {
		const onResponseActivity = vi.fn();
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "context-preparing",
						kind: "context",
						status: "running",
						contextPreparationClass: "context-retrieval",
						stageId: "constructed_context",
						label: "Diagnostic context retrieval",
						detail: "raw_stage=constructed_context",
					},
					transient: true,
				}),
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "context-preparing",
						kind: "context",
						status: "running",
						contextPreparationClass: "prompt_budget",
						stageId: "prompt_budget",
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			],
			callbacks: {
				...makeCallbacks(),
				onResponseActivity,
			},
		});
		await done;

		expect(onResponseActivity).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				id: "context-preparing",
				kind: "context",
				status: "running",
				contextPreparationClass: "context-retrieval",
			}),
		);
		expect(onResponseActivity.mock.calls[0]?.[0]).not.toHaveProperty("stageId");
		expect(onResponseActivity).toHaveBeenNthCalledWith(2, {
			id: "context-preparing",
			kind: "context",
			status: "running",
		});
	});

	it("maps deliberation response-activity events onto the activity callback", async () => {
		const onResponseActivity = vi.fn();
		const { done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-response-activity",
					data: {
						id: "deliberation-pass-1",
						kind: "deliberation",
						status: "running",
						label: "Reviewing context and sources",
						occurredAt: 456,
					},
					transient: true,
				}),
				uiFrame("[DONE]"),
			],
			callbacks: {
				...makeCallbacks(),
				onResponseActivity,
			},
		});
		await done;

		expect(onResponseActivity).toHaveBeenCalledWith({
			id: "deliberation-pass-1",
			kind: "deliberation",
			status: "running",
			label: "Reviewing context and sources",
			occurredAt: 456,
		});
	});

	it("maps AI SDK UI stream-error data parts onto onError with code", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-stream-error",
					data: {
						message: "Upstream failed",
						code: "UPSTREAM_FAILURE",
					},
					transient: true,
				}),
			],
		});
		await done;

		const error = cb.onError.mock.calls[0]?.[0] as
			| (Error & { code?: string })
			| undefined;
		expect(error?.message).toBe("Upstream failed");
		expect(error?.code).toBe("UPSTREAM_FAILURE");
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("buffers AI SDK UI replayed chunks until replay end before waiting", async () => {
		const controlled = buildControlledFetchResponse();
		const consoleInfo = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);

		const events: string[] = [];
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			response: controlled.response,
			callbacks: makeEventLogCallbacks(events),
		});

		await flushMicrotasks();
		controlled.enqueue(
			uiFrame({ type: "data-replay-start", data: {}, transient: true }),
			uiFrame({ type: "text-delta", id: "text-1", delta: "Buffered" }),
			uiFrame({
				type: "reasoning-delta",
				id: "reasoning-1",
				delta: "Reasoning",
			}),
		);
		await flushMicrotasks();

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();

		controlled.enqueue(
			uiFrame({ type: "data-replay-end", data: {}, transient: true }),
			uiFrame({ type: "data-waiting", data: {}, transient: true }),
			uiFrame("[DONE]"),
		);
		controlled.close();
		await done;

		expect(events).toEqual([
			"token:Buffered",
			"thinking:Reasoning",
			"waiting",
			"end:Buffered",
		]);
		consoleInfo.mockRestore();
	});

	it("calls onToken for each AI SDK UI text delta chunk", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("Hello"), tokenEvent(" world"), endEvent()],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Hello");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, " world");
	});

	it("handles AI SDK UI frames split across network chunks", async () => {
		const tokenFrame = tokenEvent("Hello from split frame");
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				tokenFrame.slice(0, 17),
				tokenFrame.slice(17),
				endEvent(),
			],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledOnce();
		expect(cb.onToken).toHaveBeenCalledWith("Hello from split frame");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello from split frame", undefined);
	});

	it("does not render a trailing AI SDK UI frame that closes before the SSE block delimiter", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("partial without delimiter").trimEnd()],
		});
		await done;

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();
		expect(cb.onEnd).not.toHaveBeenCalled();
		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError.mock.calls[0]?.[0]).toMatchObject({
			message: "Stream closed before a terminal completion event",
		});
	});

	it("includes forceWebSearch in the stream request body for the current turn", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent()],
			options: { forceWebSearch: true },
		});
		await done;

		const requestBody = parseLastStreamRequestBody(mockFetch);
		expect(requestBody).toMatchObject({
			message: "test message",
			conversationId: "conv-1",
			forceWebSearch: true,
		});
	});

	it("calls onEnd with full concatenated text", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("Hello"), tokenEvent(" world"), endEvent()],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledOnce();
		expect(cb.onEnd).toHaveBeenCalledWith("Hello world", undefined);
		expect(cb.onError).not.toHaveBeenCalled();
	});

	it("calls onThinking for AI SDK UI reasoning chunks", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				thinkingEvent("Need to reason first"),
				tokenEvent("Final answer"),
				endEvent({ thinking: "Need to reason first" }),
			],
			callbacks: {
				...makeCallbacks(),
				onThinking: vi.fn(),
			},
		});
		await done;

		expect(cb.onThinking).toHaveBeenCalledOnce();
		expect(cb.onThinking).toHaveBeenCalledWith("Need to reason first");
		expect(cb.onEnd).toHaveBeenCalledWith("Final answer", {
			thinking: "Need to reason first",
		});
	});

	it("preserves AI SDK text-field fallback and strips leaked tool calls from reasoning", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "text-delta",
					id: "text-1",
					text: "Hello from text field",
				}),
				uiFrame({
					type: "reasoning-delta",
					id: "reasoning-1",
					text: "Internal<tool_calls>{}</tool_calls> reasoning",
				}),
				endEvent(),
			],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledWith("Hello from text field");
		expect(cb.onThinking).toHaveBeenCalledWith("Internal reasoning");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello from text field", undefined);
	});

	it("routes inline <thinking> tags from text deltas into onThinking", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				tokenEvent("Before<thinking>Need to reason</thinking>After"),
				endEvent(),
			],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Before");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, "After");
		expect(cb.onThinking).toHaveBeenCalledOnce();
		expect(cb.onThinking).toHaveBeenCalledWith("Need to reason");
		expect(cb.onEnd).toHaveBeenCalledWith("BeforeAfter", undefined);
	});

	it("handles inline <thinking> tags split across token events", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				tokenEvent("Start<th"),
				tokenEvent("inking>Need"),
				tokenEvent(" to search</thin"),
				tokenEvent("king>End"),
				endEvent(),
			],
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledTimes(2);
		expect(cb.onToken).toHaveBeenNthCalledWith(1, "Start");
		expect(cb.onToken).toHaveBeenNthCalledWith(2, "End");
		expect(cb.onThinking).toHaveBeenCalledTimes(2);
		expect(cb.onThinking).toHaveBeenNthCalledWith(1, "Need");
		expect(cb.onThinking).toHaveBeenNthCalledWith(2, " to search");
		expect(cb.onEnd).toHaveBeenCalledWith("StartEnd", undefined);
	});

	it("parses AI SDK UI stream metadata from the data part", async () => {
		const endMetadata = {
			thinkingTokenCount: 2,
			responseTokenCount: 3,
			totalTokenCount: 5,
			wasStopped: false,
			modelDisplayName: "Model 1",
			depthMetadata: {
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
				modelId: "model1",
				modelDisplayName: "Model 1",
			},
			contextSources: {
				conversationId: "conv-1",
				userId: "user-1",
				activeCount: 1,
				inferredCount: 0,
				selectedCount: 1,
				pinnedCount: 0,
				excludedCount: 0,
				reduced: false,
				compacted: false,
				groups: [],
				updatedAt: 1777140000000,
			},
			contextCompressionSnapshots: [
				{
					id: "snapshot-1",
					trigger: "automatic",
					status: "valid",
					sourceEndMessageId: "message-3",
					createdAt: 1777140000100,
					updatedAt: 1777140000200,
					estimatedTokens: 120,
					sourceTokenEstimate: 420,
				},
			],
		} as Partial<StreamMetadata>;
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("Hello"), endEvent(endMetadata)],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Hello", endMetadata);
	});

	it("parses trailing AI SDK UI stream metadata when the stream closes without a final blank line", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				tokenEvent("Hello"),
				endEvent({
					assistantMessageId: "assistant-1",
					wasStopped: false,
				}).trimEnd(),
			],
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith("Hello", {
			assistantMessageId: "assistant-1",
			wasStopped: false,
		});
	});

	it("reports opt-in client timing without changing token parsing or logging by default", async () => {
		const consoleInfo = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [": prelude\n", "\n", tokenEvent("Hello"), endEvent()],
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onToken).toHaveBeenCalledWith("Hello");
		expect(cb.onEnd).toHaveBeenCalledWith("Hello", undefined);
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "/api/chat/stream",
				streamId: expect.any(String),
				phases: expect.objectContaining({
					fetchStartMs: 0,
					responseHeadersMs: expect.any(Number),
					firstByteMs: expect.any(Number),
					firstTokenMs: expect.any(Number),
					endMs: expect.any(Number),
				}),
			}),
		);
		expect(consoleInfo).not.toHaveBeenCalled();
		consoleInfo.mockRestore();
	});

	it("correlates browser timing with Server-Timing and terminal server timeline metadata", async () => {
		const serverTimingHeader =
			'route_parse;dur=1.0, capacity;dur=-2, preflight;desc="ok";dur=3.5';
		const serverTimeline = {
			version: 1,
			server: {
				route_parse: 1,
				prelude: 6,
				first_visible_token: 24,
				end: 40,
			},
		};
		const metadata = {
			generationDurationMs: 40,
			serverTimeline,
		} as Partial<StreamMetadata>;
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			response: new Response(
				[
					uiFrame({
						type: "data-response-activity",
						data: {
							id: "context-preparing",
							kind: "context",
							status: "running",
							occurredAt: 1777140000000,
						},
						transient: true,
					}),
					tokenEvent("Hello"),
					endEvent(metadata),
				].join(""),
				{
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Server-Timing": serverTimingHeader,
					},
				},
			),
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onEnd).toHaveBeenCalledWith(
			"Hello",
			expect.objectContaining({
				generationDurationMs: 40,
				serverTimeline,
			}),
		);
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "success",
				serverTiming: serverTimingHeader,
				parsedServerTiming: {
					route_parse: 1,
					preflight: 3.5,
				},
				serverTimeline,
				phases: expect.objectContaining({
					responseHeadersMs: expect.any(Number),
					firstByteMs: expect.any(Number),
					firstActivityMs: expect.any(Number),
					firstTokenMs: expect.any(Number),
					endMs: expect.any(Number),
				}),
			}),
		);
	});

	it("threads the active workspace document id into the streaming request body", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent()],
			options: { activeDocumentArtifactId: "artifact-focused-1" },
		});
		await done;

		expect(mockFetch).toHaveBeenCalledWith(
			"/api/chat/stream",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: expect.any(String),
			}),
		);
		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.activeDocumentArtifactId).toBe("artifact-focused-1");
		expect(parsedBody.conversationId).toBe("conv-1");
	});

	it("threads pending skills into the streaming request body", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			message: "use this skill",
			responseChunks: [endEvent()],
			options: {
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Research Pack",
				},
			},
		});
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.pendingSkill).toEqual({
			id: "skill-1",
			ownership: "user",
			displayName: "Research Pack",
		});
	});

	it("threads Reasoning depth into the streaming request body", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			responseChunks: [endEvent()],
			options: { reasoningDepth: "off" },
		});
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.reasoningDepth).toBe("off");
		expect(parsedBody).not.toHaveProperty("thinkingMode");
	});

	it("threads the active workspace document id into retry requests too", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			message: "ignored",
			responseChunks: [endEvent()],
			options: {
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				activeDocumentArtifactId: "artifact-focused-2",
			},
		});
		await done;

		expect(mockFetch).toHaveBeenCalledWith(
			"/api/chat/retry",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: expect.any(String),
			}),
		);
		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.assistantMessageId).toBe("assistant-msg-1");
		expect(parsedBody.userMessageId).toBe("user-msg-1");
		expect(parsedBody.userMessage).toBe("historical user text");
		expect(parsedBody.activeDocumentArtifactId).toBe("artifact-focused-2");
	});

	it("threads Reasoning depth into retry requests", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			message: "ignored",
			responseChunks: [endEvent()],
			options: {
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				reasoningDepth: "max",
			},
		});
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.reasoningDepth).toBe("max");
		expect(parsedBody).not.toHaveProperty("thinkingMode");
	});

	it("threads confirmed forked source-history mutation into retry requests", async () => {
		const { mockFetch, done } = runStreamWithMockedResponse({
			message: "ignored",
			responseChunks: [endEvent()],
			options: {
				retryAssistantMessageId: "assistant-msg-1",
				retryUserMessageId: "user-msg-1",
				retryUserMessage: "historical user text",
				confirmForkedSourceHistoryMutation: true,
			},
		});
		await done;

		const parsedBody = parseLastStreamRequestBody(mockFetch);
		expect(parsedBody.confirmForkedSourceHistoryMutation).toBe(true);
	});

	it("parses tool-call details and assistant evidence metadata", async () => {
		const onToolCall = vi.fn();
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({
					type: "data-tool-call",
					transient: true,
					data: {
						name: "web_search",
						input: { query: "OpenAI news" },
						status: "done",
						outputSummary: "Found sources",
						sourceType: "web",
						candidates: [
							{
								id: "src-1",
								title: "OpenAI",
								url: "https://openai.com",
								sourceType: "web",
							},
						],
					},
				}),
				tokenEvent("Hello"),
				endEvent({
					messageEvidence: {
						structuredWebSearch: true,
						groups: [
							{
								sourceType: "web",
								label: "Web Search",
								reranked: true,
								confidence: 88,
								items: [
									{
										id: "src-1",
										title: "OpenAI",
										sourceType: "web",
										status: "selected",
										url: "https://openai.com",
									},
								],
							},
						],
					},
				}),
			],
			callbacks: {
				...makeCallbacks(),
				onToolCall,
			},
		});
		await done;

		expect(onToolCall).toHaveBeenCalledWith(
			"web_search",
			{ query: "OpenAI news" },
			"done",
			{
				outputSummary: "Found sources",
				sourceType: "web",
				candidates: [
					{
						id: "src-1",
						title: "OpenAI",
						url: "https://openai.com",
						sourceType: "web",
					},
				],
			},
		);
		expect(cb.onEnd).toHaveBeenCalledWith("Hello", {
			messageEvidence: {
				structuredWebSearch: true,
				groups: [
					{
						sourceType: "web",
						label: "Web Search",
						reranked: true,
						confidence: 88,
						items: [
							{
								id: "src-1",
								title: "OpenAI",
								sourceType: "web",
								status: "selected",
								url: "https://openai.com",
							},
						],
					},
				],
			},
		});
	});

	it("calls onError on network failure", async () => {
		const mockFetch = vi.mocked(fetch);
		mockFetch.mockRejectedValue(new Error("Network failure"));

		const cb = makeCallbacks();
		const done = runStreamAndWait(
			"test message",
			"conv-1",
			cb as unknown as StreamCallbacks,
		);
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Network failure" }),
		);
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("calls onError when response is not ok", async () => {
		const serverTimingHeader = "route_parse;dur=2.0, preflight;dur=4.5";
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			response: new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: {
					"Content-Type": "application/json",
					"Server-Timing": serverTimingHeader,
				},
			}),
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Unauthorized" }),
		);
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "error",
				serverTiming: serverTimingHeader,
				parsedServerTiming: {
					route_parse: 2,
					preflight: 4.5,
				},
				phases: expect.objectContaining({
					responseHeadersMs: expect.any(Number),
					errorMs: expect.any(Number),
				}),
			}),
		);
	});

	it("reports error timing when an ok response has no body", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			response: new Response(null, { status: 200 }),
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Response has no body" }),
		);
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "error",
				phases: expect.objectContaining({
					responseHeadersMs: expect.any(Number),
					errorMs: expect.any(Number),
				}),
			}),
		);
	});

	it("calls onError when stream emits error event", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [errorEvent({ message: "Something went wrong" })],
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Something went wrong" }),
		);
		expect(cb.onEnd).not.toHaveBeenCalled();
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "error",
				phases: expect.objectContaining({
					firstByteMs: expect.any(Number),
					errorMs: expect.any(Number),
				}),
			}),
		);
	});

	it("uses stream error fallback fields and preserves the error code", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				errorEvent({ error: "Fallback failure", code: "UPSTREAM_TIMEOUT" }),
			],
		});
		await done;

		const error = cb.onError.mock.calls[0]?.[0] as
			| (Error & { code?: string })
			| undefined;
		expect(error?.message).toBe("Fallback failure");
		expect(error?.code).toBe("UPSTREAM_TIMEOUT");
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("maps native AI SDK UI error parts onto onError", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [
				uiFrame({ type: "error", errorText: "upstream exploded" }),
			],
		});
		await done;

		expect(cb.onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "upstream exploded" }),
		);
		expect(cb.onEnd).not.toHaveBeenCalled();
	});

	it("buffers replayed token and thinking chunks until replay-end before waiting", async () => {
		const controlled = buildControlledFetchResponse();
		const consoleInfo = vi
			.spyOn(console, "info")
			.mockImplementation(() => undefined);

		const events: string[] = [];
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			response: controlled.response,
			callbacks: {
				...makeEventLogCallbacks(events),
				onTiming: vi.fn(),
			},
		});

		await flushMicrotasks();
		controlled.enqueue(
			uiFrame({ type: "data-replay-start", data: {}, transient: true }),
			tokenEvent("Buffered"),
			thinkingEvent("Reasoning"),
		);
		await flushMicrotasks();

		expect(cb.onToken).not.toHaveBeenCalled();
		expect(cb.onThinking).not.toHaveBeenCalled();

		controlled.enqueue(
			uiFrame({ type: "data-replay-end", data: {}, transient: true }),
			uiFrame({ type: "data-waiting", data: {}, transient: true }),
			endEvent(),
		);
		controlled.close();
		await done;

		expect(events).toEqual([
			"token:Buffered",
			"thinking:Reasoning",
			"waiting",
			"end:Buffered",
		]);
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "success",
				phases: expect.not.objectContaining({
					stopMs: expect.any(Number),
				}),
			}),
		);
		consoleInfo.mockRestore();
	});

	it("calls onError when the stream closes without a terminal event", async () => {
		const { callbacks: cb, done } = runStreamWithMockedResponse({
			responseChunks: [tokenEvent("partial")],
			callbacks: {
				...makeCallbacks(),
				onTiming: vi.fn(),
			},
		});
		await done;

		expect(cb.onEnd).not.toHaveBeenCalled();
		expect(cb.onError).toHaveBeenCalledOnce();
		expect(cb.onError.mock.calls[0]?.[0]).toMatchObject({
			message: "Stream closed before a terminal completion event",
		});
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "closed",
				phases: expect.objectContaining({
					firstByteMs: expect.any(Number),
					endMs: expect.any(Number),
				}),
			}),
		);
	});

	it("stop() requests a server stop and does not call onError", async () => {
		const mockFetch = vi.mocked(fetch);

		let abortReject!: (err: Error) => void;
		let streamFetchPromise!: Promise<Response>;
		mockFetch.mockImplementation((input) => {
			if (typeof input === "string" && input === "/api/chat/stream/stop") {
				return Promise.resolve(
					new Response(JSON.stringify({ stopped: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
				);
			}

			streamFetchPromise = new Promise<Response>((_resolve, reject) => {
				abortReject = reject;
			});
			return streamFetchPromise;
		});

		const cb = {
			...makeCallbacks(),
			onTiming: vi.fn(),
		};
		const handle = streamChat(
			"test message",
			"conv-1",
			cb as unknown as StreamCallbacks,
		);

		handle.stop();

		abortReject(new DOMException("The user aborted a request.", "AbortError"));

		await streamFetchPromise.catch(() => undefined);
		await flushMicrotasks();

		expect(cb.onError).not.toHaveBeenCalled();
		expect(cb.onTiming).toHaveBeenCalledOnce();
		expect(cb.onTiming).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "stopped",
				phases: expect.objectContaining({
					stopMs: expect.any(Number),
					endMs: expect.any(Number),
				}),
			}),
		);
		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(mockFetch).toHaveBeenNthCalledWith(
			2,
			"/api/chat/stream/stop",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
			}),
		);
		const streamRequest = mockFetch.mock.calls[0]?.[1] as
			| RequestInit
			| undefined;
		const stopRequest = mockFetch.mock.calls[1]?.[1] as RequestInit | undefined;
		expect(streamRequest?.body).toEqual(expect.any(String));
		expect(stopRequest?.body).toEqual(expect.any(String));
		expect(JSON.parse(String(stopRequest?.body)).streamId).toBe(
			JSON.parse(String(streamRequest?.body)).streamId,
		);
	});

	it("detach() aborts the local stream without requesting a server stop or emitting stop metadata", async () => {
		const mockFetch = vi.mocked(fetch);

		let abortReject!: (err: Error) => void;
		let streamFetchPromise!: Promise<Response>;
		mockFetch.mockImplementation(() => {
			streamFetchPromise = new Promise<Response>((_resolve, reject) => {
				abortReject = reject;
			});
			return streamFetchPromise;
		});

		const cb = {
			...makeCallbacks(),
			onTiming: vi.fn(),
		};
		const handle = streamChat(
			"test message",
			"conv-1",
			cb as unknown as StreamCallbacks,
		);

		handle.detach();

		abortReject(new DOMException("The user aborted a request.", "AbortError"));

		await streamFetchPromise.catch(() => undefined);
		await flushMicrotasks();

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(cb.onEnd).not.toHaveBeenCalled();
		expect(cb.onError).not.toHaveBeenCalled();
		expect(cb.onTiming).not.toHaveBeenCalled();
	});
});
