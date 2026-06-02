export type AiSdkUiStreamFixturePart = Record<string, unknown>;

export type AiSdkUiStreamFixturePayload = AiSdkUiStreamFixturePart | "[DONE]";

export const AI_SDK_UI_STREAM_TEXT_ID = "answer";
export const AI_SDK_UI_STREAM_REASONING_ID = "reasoning";

export const aiSdkUiStreamContractToolCall = {
	callId: "tool-call-1",
	name: "web_search",
	input: { query: "current evidence" },
	status: "done",
	outputSummary: "Found current sources",
	sourceType: "web",
	candidates: [
		{
			id: "source-1",
			title: "Current source",
			url: "https://example.com/current",
			sourceType: "web",
		},
	],
	metadata: { resultCount: 1 },
} as const;

export const aiSdkUiStreamContractMetadata = {
	thinkingTokenCount: 3,
	responseTokenCount: 2,
	totalTokenCount: 5,
	assistantMessageId: "assistant-message-1",
	modelDisplayName: "Fixture Model",
} as const;

export const aiSdkUiStreamContractParts = {
	textStart: {
		type: "text-start",
		id: AI_SDK_UI_STREAM_TEXT_ID,
	},
	textDeltaHello: {
		type: "text-delta",
		id: AI_SDK_UI_STREAM_TEXT_ID,
		delta: "Hello",
	},
	textDeltaWorld: {
		type: "text-delta",
		id: AI_SDK_UI_STREAM_TEXT_ID,
		delta: " world",
	},
	textEnd: {
		type: "text-end",
		id: AI_SDK_UI_STREAM_TEXT_ID,
	},
	reasoningStart: {
		type: "reasoning-start",
		id: AI_SDK_UI_STREAM_REASONING_ID,
	},
	reasoningDelta: {
		type: "reasoning-delta",
		id: AI_SDK_UI_STREAM_REASONING_ID,
		delta: "Need current evidence.",
	},
	reasoningEnd: {
		type: "reasoning-end",
		id: AI_SDK_UI_STREAM_REASONING_ID,
	},
	toolCall: {
		type: "data-tool-call",
		data: aiSdkUiStreamContractToolCall,
		transient: true,
	},
	statusData: {
		type: "data-status",
		data: { phase: "searching" },
		transient: true,
	},
	metadata: {
		type: "data-stream-metadata",
		data: aiSdkUiStreamContractMetadata,
		transient: true,
	},
	replayStart: {
		type: "data-replay-start",
		data: {
			tokenCount: 1,
			thinkingCount: 1,
			toolCallCount: 0,
			userMessage: "original question",
		},
		transient: true,
	},
	replayEnd: {
		type: "data-replay-end",
		data: {},
		transient: true,
	},
	waiting: {
		type: "data-waiting",
		data: {},
		transient: true,
	},
	finish: {
		type: "finish",
		finishReason: "stop",
	},
} as const;

export const aiSdkUiStreamContractSequence = [
	aiSdkUiStreamContractParts.textStart,
	aiSdkUiStreamContractParts.reasoningStart,
	aiSdkUiStreamContractParts.reasoningDelta,
	aiSdkUiStreamContractParts.reasoningEnd,
	aiSdkUiStreamContractParts.textDeltaHello,
	aiSdkUiStreamContractParts.textDeltaWorld,
	aiSdkUiStreamContractParts.textEnd,
	aiSdkUiStreamContractParts.toolCall,
	aiSdkUiStreamContractParts.statusData,
	aiSdkUiStreamContractParts.metadata,
	aiSdkUiStreamContractParts.finish,
	"[DONE]",
] as const satisfies readonly AiSdkUiStreamFixturePayload[];

export const aiSdkUiStreamReplaySequence = [
	aiSdkUiStreamContractParts.replayStart,
	aiSdkUiStreamContractParts.textDeltaHello,
	aiSdkUiStreamContractParts.reasoningDelta,
	aiSdkUiStreamContractParts.replayEnd,
	aiSdkUiStreamContractParts.waiting,
	aiSdkUiStreamContractParts.finish,
	"[DONE]",
] as const satisfies readonly AiSdkUiStreamFixturePayload[];

export const aiSdkUiStreamCloseAfterFinishSequence = [
	aiSdkUiStreamContractParts.textDeltaHello,
	aiSdkUiStreamContractParts.finish,
] as const satisfies readonly AiSdkUiStreamFixturePayload[];

export const malformedAiSdkUiStreamFrames = [
	'data: {"type":"text-delta","id":"answer","delta":\n\n',
	'data: {"delta":"missing type"}\n\n',
	"data: 42\n\n",
] as const;

export const oldBrowserSseNamedTokenEvent =
	'event: token\ndata: {"type":"text-delta","id":"answer","delta":"legacy token"}\n\n';

export const oldBrowserSseNamedEndEvent =
	'event: end\ndata: {"type":"finish","finishReason":"stop"}\n\n';

export function encodeAiSdkUiFixtureFrame(
	payload: AiSdkUiStreamFixturePayload,
): string {
	return `data: ${
		payload === "[DONE]" ? payload : JSON.stringify(payload)
	}\n\n`;
}

export function encodeAiSdkUiFixtureFrames(
	payloads: readonly AiSdkUiStreamFixturePayload[],
): string[] {
	return payloads.map((payload) => encodeAiSdkUiFixtureFrame(payload));
}
