type JsonPrimitive = string | number | boolean | null;
type JsonValue =
	| JsonPrimitive
	| { [key: string]: JsonValue | undefined }
	| JsonValue[];

export type ProviderStreamFamily =
	| "deepseek-v4"
	| "xiaomi-mimo"
	| "kimi-k2"
	| "glm-5"
	| "qwen-3";

export type OpenAICompatibleToolCallDelta = {
	index?: number | string;
	id?: JsonValue;
	type?: "function" | string;
	function?: {
		name?: string;
		arguments?: string;
		[key: string]: JsonValue | undefined;
	};
	[key: string]: JsonValue | undefined;
};

export type OpenAICompatibleStreamDelta = {
	role?: string;
	content?: string | null;
	reasoning_content?: string;
	reasoning?: string;
	tool_calls?: OpenAICompatibleToolCallDelta[];
	[key: string]: JsonValue | undefined;
};

export type OpenAICompatibleStreamChoice = {
	index: number | string;
	delta: OpenAICompatibleStreamDelta;
	finish_reason: string | null;
	[key: string]: JsonValue | undefined;
};

export type OpenAICompatibleStreamUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
	reasoning_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
		[key: string]: JsonValue | undefined;
	};
	completion_tokens_details?: {
		reasoning_tokens?: number;
		[key: string]: JsonValue | undefined;
	};
	[key: string]: JsonValue | undefined;
};

export type OpenAICompatibleStreamChunk = {
	id: string;
	object: "chat.completion.chunk" | string;
	created: number;
	model: string;
	choices: OpenAICompatibleStreamChoice[];
	usage?: OpenAICompatibleStreamUsage | null;
	[key: string]: JsonValue | undefined;
};

export type ProviderStreamDataFrame =
	| OpenAICompatibleStreamChunk
	| Record<string, unknown>
	| "[DONE]";

export type ProviderStreamFixtureFrame = {
	data: ProviderStreamDataFrame;
	event?: string;
};

export type ExpectedProviderToolCall = {
	id?: string;
	name: string;
	argumentsText: string;
	input?: Record<string, JsonValue>;
};

export type ProviderUsageFrameLocation =
	| "top-level-empty-choices"
	| "top-level-finish-chunk"
	| "choice-finish";

export type ExpectedProviderUsageFrame = {
	location: ProviderUsageFrameLocation;
	usage: OpenAICompatibleStreamUsage;
};

export type ProviderStreamFixture = {
	id: string;
	providerFamily: ProviderStreamFamily;
	providerName: string;
	providerDisplayName: string;
	baseUrl: string;
	model: string;
	description: string;
	frames: ProviderStreamFixtureFrame[];
	expected: {
		rawEventStream: string;
		rawDataFrames: string[];
		textDeltas: string[];
		reasoningDeltas: string[];
		toolCalls: ExpectedProviderToolCall[];
		usageFrames: ExpectedProviderUsageFrame[];
		usage?: OpenAICompatibleStreamUsage;
		finishReason?: string;
		responseModelName: string;
	};
};

type ProviderStreamFixtureInput = Omit<ProviderStreamFixture, "expected"> & {
	expected?: Partial<
		Omit<ProviderStreamFixture["expected"], "rawEventStream" | "rawDataFrames">
	>;
};

export type FixtureEventStreamOptions = {
	chunkBoundaries?: number[];
};

const DEFAULT_CREATED = 1_780_000_000;

function chunk(
	params: {
		id: string;
		model: string;
		delta?: OpenAICompatibleStreamDelta;
		finishReason?: string | null;
		usage?: OpenAICompatibleStreamUsage | null;
		choiceUsage?: OpenAICompatibleStreamUsage;
		choiceIndex?: number | string;
		created?: number;
	} & Record<string, JsonValue | undefined>,
): OpenAICompatibleStreamChunk {
	const {
		id,
		model,
		delta = {},
		finishReason = null,
		usage,
		choiceUsage,
		choiceIndex = 0,
		created = DEFAULT_CREATED,
		...metadata
	} = params;

	return {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [
			{
				index: choiceIndex,
				delta,
				finish_reason: finishReason,
				...(choiceUsage ? { usage: choiceUsage } : {}),
			},
		],
		...(usage !== undefined ? { usage } : {}),
		...metadata,
	};
}

function usageChunk(
	params: {
		id: string;
		model: string;
		usage: OpenAICompatibleStreamUsage;
		created?: number;
	} & Record<string, JsonValue | undefined>,
): OpenAICompatibleStreamChunk {
	const { id, model, usage, created = DEFAULT_CREATED, ...metadata } = params;
	return {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [],
		usage,
		...metadata,
	};
}

function dataFrame(data: ProviderStreamDataFrame): ProviderStreamFixtureFrame {
	return { data };
}

function defineFixture(
	input: ProviderStreamFixtureInput,
): ProviderStreamFixture {
	const rawEventStream = encodeFixtureEventStream(input.frames);
	return {
		...input,
		expected: {
			textDeltas: [],
			reasoningDeltas: [],
			toolCalls: [],
			usageFrames: [],
			responseModelName: input.model,
			...input.expected,
			rawEventStream,
			rawDataFrames: parseFixtureEventStreamData(rawEventStream),
		},
	};
}

export const providerStreamFixtures = {
	deepseekV4ReasoningText: defineFixture({
		id: "deepseek-v4-reasoning-text",
		providerFamily: "deepseek-v4",
		providerName: "deepseek",
		providerDisplayName: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		model: "deepseek-v4-pro",
		description: "DeepSeek V4-style reasoning and text deltas with usage.",
		frames: [
			dataFrame(
				chunk({
					id: "deepseek-v4-chunk-1",
					model: "deepseek-v4-pro",
					delta: { reasoning_content: "Inspect provider evidence. " },
					system_fingerprint: "fp_deepseek_v4",
				}),
			),
			dataFrame(
				chunk({
					id: "deepseek-v4-chunk-2",
					model: "deepseek-v4-pro",
					delta: { content: "DeepSeek answer." },
					system_fingerprint: "fp_deepseek_v4",
				}),
			),
			dataFrame(
				chunk({
					id: "deepseek-v4-chunk-3",
					model: "deepseek-v4-pro",
					finishReason: "stop",
					usage: null,
					system_fingerprint: "fp_deepseek_v4",
				}),
			),
			dataFrame(
				usageChunk({
					id: "deepseek-v4-usage",
					model: "deepseek-v4-pro",
					usage: {
						prompt_tokens: 17,
						completion_tokens: 5,
						total_tokens: 22,
						completion_tokens_details: { reasoning_tokens: 3 },
					},
					system_fingerprint: "fp_deepseek_v4",
				}),
			),
			dataFrame("[DONE]"),
		],
		expected: {
			textDeltas: ["DeepSeek answer."],
			reasoningDeltas: ["Inspect provider evidence. "],
			usage: {
				prompt_tokens: 17,
				completion_tokens: 5,
				total_tokens: 22,
				completion_tokens_details: { reasoning_tokens: 3 },
			},
			usageFrames: [
				{
					location: "top-level-empty-choices",
					usage: {
						prompt_tokens: 17,
						completion_tokens: 5,
						total_tokens: 22,
						completion_tokens_details: { reasoning_tokens: 3 },
					},
				},
			],
			finishReason: "stop",
		},
	}),
	xiaomiMiMoArgumentsBeforeName: defineFixture({
		id: "xiaomi-mimo-arguments-before-name",
		providerFamily: "xiaomi-mimo",
		providerName: "mimo",
		providerDisplayName: "Xiaomi MiMo",
		baseUrl: "https://api.xiaomimimo.example/v1",
		model: "mimo-v4-thinking",
		description:
			"MiMo-style tool call streams arguments before the function name and sends a non-string id.",
		frames: [
			dataFrame(
				chunk({
					id: "mimo-chunk-1",
					model: "mimo-v4-thinking",
					delta: {
						reasoning_content: "Need a file-producing tool. ",
						tool_calls: [
							{
								index: 0,
								id: 42,
								type: "function",
								function: { arguments: '{"title":' },
							},
						],
					},
					mimo_trace_id: "mimo-trace-1",
				}),
			),
			dataFrame(
				chunk({
					id: "mimo-chunk-2",
					model: "mimo-v4-thinking",
					delta: {
						tool_calls: [
							{
								index: 0,
								type: "function",
								function: {
									name: "produce_file",
									arguments: '"MiMo report"}',
								},
							},
						],
					},
					mimo_trace_id: "mimo-trace-1",
				}),
			),
			dataFrame(
				chunk({
					id: "mimo-chunk-3",
					model: "mimo-v4-thinking",
					finishReason: "tool_calls",
					usage: {
						prompt_tokens: 21,
						completion_tokens: 9,
						total_tokens: 30,
					},
					mimo_trace_id: "mimo-trace-1",
				}),
			),
			dataFrame("[DONE]"),
		],
		expected: {
			reasoningDeltas: ["Need a file-producing tool. "],
			toolCalls: [
				{
					id: "call_compat_0",
					name: "produce_file",
					argumentsText: '{"title":"MiMo report"}',
					input: { title: "MiMo report" },
				},
			],
			usage: {
				prompt_tokens: 21,
				completion_tokens: 9,
				total_tokens: 30,
			},
			usageFrames: [
				{
					location: "top-level-finish-chunk",
					usage: {
						prompt_tokens: 21,
						completion_tokens: 9,
						total_tokens: 30,
					},
				},
			],
			finishReason: "tool_calls",
		},
	}),
	xiaomiMiMoFinalText: defineFixture({
		id: "xiaomi-mimo-final-text",
		providerFamily: "xiaomi-mimo",
		providerName: "mimo",
		providerDisplayName: "Xiaomi MiMo",
		baseUrl: "https://api.xiaomimimo.example/v1",
		model: "mimo-v4-thinking",
		description: "MiMo-style final text response after a tool result step.",
		frames: [
			dataFrame(
				chunk({
					id: "mimo-final-chunk-1",
					model: "mimo-v4-thinking",
					delta: { content: "Queued the MiMo report." },
					mimo_trace_id: "mimo-trace-2",
				}),
			),
			dataFrame(
				chunk({
					id: "mimo-final-chunk-2",
					model: "mimo-v4-thinking",
					finishReason: "stop",
					usage: {
						prompt_tokens: 13,
						completion_tokens: 5,
						total_tokens: 18,
					},
					mimo_trace_id: "mimo-trace-2",
				}),
			),
			dataFrame("[DONE]"),
		],
		expected: {
			textDeltas: ["Queued the MiMo report."],
			usage: {
				prompt_tokens: 13,
				completion_tokens: 5,
				total_tokens: 18,
			},
			usageFrames: [
				{
					location: "top-level-finish-chunk",
					usage: {
						prompt_tokens: 13,
						completion_tokens: 5,
						total_tokens: 18,
					},
				},
			],
			finishReason: "stop",
		},
	}),
	kimiK2SplitArguments: defineFixture({
		id: "kimi-k2-split-arguments",
		providerFamily: "kimi-k2",
		providerName: "moonshot",
		providerDisplayName: "Kimi",
		baseUrl: "https://api.moonshot.ai/v1",
		model: "kimi-k2.6",
		description: "Kimi K2.X-style split tool arguments with provider metadata.",
		frames: [
			dataFrame(
				chunk({
					id: "kimi-k2-chunk-1",
					model: "kimi-k2.6",
					delta: { content: "Preparing Kimi tool call. " },
					service_tier: "standard",
				}),
			),
			dataFrame(
				chunk({
					id: "kimi-k2-chunk-2",
					model: "kimi-k2.6",
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call-kimi-1",
								type: "function",
								function: {
									name: "produce_file",
									arguments: '{"title"',
								},
							},
						],
					},
					service_tier: "standard",
				}),
			),
			dataFrame(
				chunk({
					id: "kimi-k2-chunk-3",
					model: "kimi-k2.6",
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call-kimi-1",
								type: "function",
								function: { arguments: ':"Kimi deck"}' },
							},
						],
					},
					service_tier: "standard",
				}),
			),
			dataFrame(
				chunk({
					id: "kimi-k2-chunk-4",
					model: "kimi-k2.6",
					finishReason: "tool_calls",
					choiceUsage: {
						prompt_tokens: 24,
						completion_tokens: 8,
						total_tokens: 32,
					},
					service_tier: "standard",
				}),
			),
			dataFrame("[DONE]"),
		],
		expected: {
			textDeltas: ["Preparing Kimi tool call. "],
			toolCalls: [
				{
					id: "call-kimi-1",
					name: "produce_file",
					argumentsText: '{"title":"Kimi deck"}',
					input: { title: "Kimi deck" },
				},
			],
			usage: {
				prompt_tokens: 24,
				completion_tokens: 8,
				total_tokens: 32,
			},
			usageFrames: [
				{
					location: "choice-finish",
					usage: {
						prompt_tokens: 24,
						completion_tokens: 8,
						total_tokens: 32,
					},
				},
			],
			finishReason: "tool_calls",
		},
	}),
	glm5ParameterlessTool: defineFixture({
		id: "glm-5-parameterless-tool",
		providerFamily: "glm-5",
		providerName: "zhipu",
		providerDisplayName: "GLM",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		model: "glm-5-plus",
		description:
			"GLM 5.X-style parameterless tool call that needs a delayed {} argument chunk.",
		frames: [
			dataFrame(
				chunk({
					id: "glm-5-chunk-1",
					model: "glm-5-plus",
					delta: {
						tool_calls: [
							{
								index: 0,
								id: null,
								type: "function",
								function: {
									name: "memory_context",
									arguments: "",
								},
							},
						],
					},
					request_id: "glm-request-1",
				}),
			),
			dataFrame(
				chunk({
					id: "glm-5-chunk-2",
					model: "glm-5-plus",
					finishReason: "tool_calls",
					usage: {
						prompt_tokens: 18,
						completion_tokens: 4,
						total_tokens: 22,
					},
					request_id: "glm-request-1",
				}),
			),
			dataFrame("[DONE]"),
		],
		expected: {
			toolCalls: [
				{
					id: "call_compat_0",
					name: "memory_context",
					argumentsText: "{}",
					input: {},
				},
			],
			usage: {
				prompt_tokens: 18,
				completion_tokens: 4,
				total_tokens: 22,
			},
			usageFrames: [
				{
					location: "top-level-finish-chunk",
					usage: {
						prompt_tokens: 18,
						completion_tokens: 4,
						total_tokens: 22,
					},
				},
			],
			finishReason: "tool_calls",
		},
	}),
	qwen3ReasoningUsage: defineFixture({
		id: "qwen-3-reasoning-usage",
		providerFamily: "qwen-3",
		providerName: "dashscope",
		providerDisplayName: "Qwen Cloud",
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		model: "qwen3.6-plus",
		description: "Qwen 3.X-style thinking stream with usage metadata.",
		frames: [
			dataFrame(
				chunk({
					id: "qwen-3-chunk-1",
					model: "qwen3.6-plus",
					delta: { reasoning_content: "Use preserved thinking. " },
					request_id: "qwen-request-1",
				}),
			),
			dataFrame(
				chunk({
					id: "qwen-3-chunk-2",
					model: "qwen3.6-plus",
					delta: { content: "Qwen answer." },
					request_id: "qwen-request-1",
				}),
			),
			dataFrame(
				chunk({
					id: "qwen-3-chunk-3",
					model: "qwen3.6-plus",
					finishReason: "stop",
					usage: null,
					request_id: "qwen-request-1",
				}),
			),
			dataFrame(
				usageChunk({
					id: "qwen-3-usage",
					model: "qwen3.6-plus",
					usage: {
						prompt_tokens: 19,
						completion_tokens: 6,
						total_tokens: 25,
						prompt_tokens_details: { cached_tokens: 2 },
					},
					request_id: "qwen-request-1",
				}),
			),
			dataFrame("[DONE]"),
		],
		expected: {
			textDeltas: ["Qwen answer."],
			reasoningDeltas: ["Use preserved thinking. "],
			usage: {
				prompt_tokens: 19,
				completion_tokens: 6,
				total_tokens: 25,
				prompt_tokens_details: { cached_tokens: 2 },
			},
			usageFrames: [
				{
					location: "top-level-empty-choices",
					usage: {
						prompt_tokens: 19,
						completion_tokens: 6,
						total_tokens: 25,
						prompt_tokens_details: { cached_tokens: 2 },
					},
				},
			],
			finishReason: "stop",
		},
	}),
} as const satisfies Record<string, ProviderStreamFixture>;

export const providerStreamFixtureCatalog = Object.values(
	providerStreamFixtures,
);

export const normalizerProviderStreamFixtureCatalog = [
	providerStreamFixtures.deepseekV4ReasoningText,
	providerStreamFixtures.xiaomiMiMoArgumentsBeforeName,
	providerStreamFixtures.kimiK2SplitArguments,
	providerStreamFixtures.glm5ParameterlessTool,
	providerStreamFixtures.qwen3ReasoningUsage,
] as const satisfies readonly ProviderStreamFixture[];

export function createFixtureEventStreamResponse(
	fixture: ProviderStreamFixture,
	options: FixtureEventStreamOptions = {},
): Response {
	return createFixtureEventStreamResponseFromText(
		fixture.expected.rawEventStream,
		options,
	);
}

export function createFixtureEventStreamResponseFromDataFrames(
	frames: readonly ProviderStreamDataFrame[],
	options: FixtureEventStreamOptions = {},
): Response {
	return createFixtureEventStreamResponseFromText(
		encodeFixtureEventStream(frames.map((data) => ({ data }))),
		options,
	);
}

export function createFixtureEventStreamResponseFromText(
	body: string,
	options: FixtureEventStreamOptions = {},
): Response {
	return new Response(
		options.chunkBoundaries?.length
			? chunkedTextStream(body, options.chunkBoundaries)
			: body,
		{
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		},
	);
}

export function parseFixtureEventStreamData(rawEventStream: string): string[] {
	return rawEventStream
		.split(/\r?\n\r?\n/)
		.map((event) => event.trim())
		.filter(Boolean)
		.flatMap((event) => {
			const dataLines = event
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice("data:".length).trimStart());
			return dataLines.length > 0 ? [dataLines.join("\n")] : [];
		});
}

export function parseFixtureEventStreamJson(
	rawEventStream: string,
): ProviderStreamDataFrame[] {
	return parseFixtureEventStreamData(rawEventStream).map((frame) =>
		frame === "[DONE]"
			? "[DONE]"
			: (JSON.parse(frame) as Record<string, unknown>),
	);
}

export function collectFixtureTextDeltas(
	frames: readonly ProviderStreamDataFrame[],
): string[] {
	return collectDeltaStrings(frames, "content");
}

export function collectFixtureReasoningDeltas(
	frames: readonly ProviderStreamDataFrame[],
): string[] {
	return [
		...collectDeltaStrings(frames, "reasoning_content"),
		...collectDeltaStrings(frames, "reasoning"),
	];
}

export function collectFixtureToolCalls(
	frames: readonly ProviderStreamDataFrame[],
): ExpectedProviderToolCall[] {
	const toolCalls = new Map<string, ExpectedProviderToolCall>();

	for (const delta of iterateFixtureToolCallDeltas(frames)) {
		mergeFixtureToolCallDelta(toolCalls, delta);
	}

	return Array.from(toolCalls.values());
}

export function collectFixtureUsage(
	frames: readonly ProviderStreamDataFrame[],
): OpenAICompatibleStreamUsage | undefined {
	return collectFixtureUsageFrames(frames).at(-1)?.usage;
}

export function collectFixtureUsageFrames(
	frames: readonly ProviderStreamDataFrame[],
): ExpectedProviderUsageFrame[] {
	return frames.flatMap((frame) => {
		if (!isRecord(frame)) return [];
		const choices = Array.isArray(frame.choices) ? frame.choices : [];
		const topLevelLocation: ProviderUsageFrameLocation =
			choices.length === 0
				? "top-level-empty-choices"
				: "top-level-finish-chunk";
		const topLevelFrames: ExpectedProviderUsageFrame[] = isRecord(frame.usage)
			? [
					{
						location: topLevelLocation,
						usage: frame.usage as OpenAICompatibleStreamUsage,
					},
				]
			: [];
		const choiceFrames: ExpectedProviderUsageFrame[] = choices.flatMap(
			(choice): ExpectedProviderUsageFrame[] =>
				isRecord(choice) && isRecord(choice.usage)
					? [
							{
								location: "choice-finish",
								usage: choice.usage as OpenAICompatibleStreamUsage,
							},
						]
					: [],
		);
		return [...topLevelFrames, ...choiceFrames];
	});
}

export function collectFixtureFinishReasons(
	frames: readonly ProviderStreamDataFrame[],
): string[] {
	const finishReasons = [];
	for (const chunk of frames) {
		if (!isRecord(chunk) || !Array.isArray(chunk.choices)) continue;
		for (const choice of chunk.choices) {
			if (
				isRecord(choice) &&
				typeof choice.finish_reason === "string" &&
				choice.finish_reason.length > 0
			) {
				finishReasons.push(choice.finish_reason);
			}
		}
	}
	return finishReasons;
}

function encodeFixtureEventStream(
	frames: readonly ProviderStreamFixtureFrame[],
): string {
	return frames
		.map((frame) => {
			const lines = [];
			if (frame.event) lines.push(`event: ${frame.event}`);
			lines.push(
				`data: ${
					frame.data === "[DONE]" ? "[DONE]" : JSON.stringify(frame.data)
				}`,
			);
			return `${lines.join("\n")}\n\n`;
		})
		.join("");
}

function chunkedTextStream(
	text: string,
	chunkBoundaries: readonly number[],
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const chunks = splitTextAtBoundaries(text, chunkBoundaries);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunkText of chunks) {
				controller.enqueue(encoder.encode(chunkText));
			}
			controller.close();
		},
	});
}

function splitTextAtBoundaries(
	text: string,
	chunkBoundaries: readonly number[],
): string[] {
	const sortedBoundaries = [...new Set(chunkBoundaries)]
		.filter((boundary) => boundary > 0 && boundary < text.length)
		.sort((left, right) => left - right);
	const chunks = [];
	let start = 0;
	for (const boundary of sortedBoundaries) {
		chunks.push(text.slice(start, boundary));
		start = boundary;
	}
	chunks.push(text.slice(start));
	return chunks;
}

function collectDeltaStrings(
	frames: readonly ProviderStreamDataFrame[],
	field: string,
): string[] {
	const values = [];
	for (const chunk of frames) {
		if (!isRecord(chunk) || !Array.isArray(chunk.choices)) continue;
		for (const choice of chunk.choices) {
			if (!isRecord(choice) || !isRecord(choice.delta)) continue;
			const value = choice.delta[field];
			if (typeof value === "string" && value.length > 0) values.push(value);
		}
	}
	return values;
}

type FixtureToolCallDelta = {
	stateKey: string;
	rawToolCall: Record<string, unknown>;
};

function* iterateFixtureToolCallDeltas(
	frames: readonly ProviderStreamDataFrame[],
): Generator<FixtureToolCallDelta> {
	for (const chunk of frames) {
		if (!isRecord(chunk) || !Array.isArray(chunk.choices)) continue;
		for (const [choicePosition, choice] of chunk.choices.entries()) {
			yield* iterateFixtureChoiceToolCallDeltas(choice, choicePosition);
		}
	}
}

function* iterateFixtureChoiceToolCallDeltas(
	choice: unknown,
	choicePosition: number,
): Generator<FixtureToolCallDelta> {
	if (!isRecord(choice) || !isRecord(choice.delta)) return;
	const rawToolCalls = choice.delta.tool_calls;
	if (!Array.isArray(rawToolCalls)) return;

	for (const [toolCallPosition, rawToolCall] of rawToolCalls.entries()) {
		if (!isRecord(rawToolCall)) continue;
		yield {
			stateKey: `${choice.index ?? choicePosition}:${
				rawToolCall.index ?? toolCallPosition
			}`,
			rawToolCall,
		};
	}
}

function mergeFixtureToolCallDelta(
	toolCalls: Map<string, ExpectedProviderToolCall>,
	delta: FixtureToolCallDelta,
): void {
	const existing = toolCalls.get(delta.stateKey);
	const functionDelta = isRecord(delta.rawToolCall.function)
		? delta.rawToolCall.function
		: {};
	const name = stringValue(functionDelta.name) ?? existing?.name;
	if (!name && !existing) return;

	toolCalls.set(delta.stateKey, {
		id: stringValue(delta.rawToolCall.id) ?? existing?.id,
		name: name ?? "",
		argumentsText: `${existing?.argumentsText ?? ""}${
			stringValue(functionDelta.arguments) ?? ""
		}`,
	});
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
