type SyntheticToolCallIdFactory = () => string;

type StreamNormalizerState = {
	toolCallIds: Map<string, string>;
	toolCalls: Map<string, ToolCallStreamState>;
};

type ToolCallStreamState = {
	id: string;
	name?: string;
	emitted: boolean;
	argumentsText: string;
	pendingArguments: string;
	injectedParameterlessArguments: boolean;
};

const OMIT_SERVER_SENT_EVENT = Symbol("omit-server-sent-event");

export function createOpenAICompatibleStreamNormalizingFetch(
	baseFetch: typeof fetch = fetch,
): typeof fetch {
	let nextSyntheticToolCallId = 0;

	return async (input, init) => {
		const response = await baseFetch(input, init);
		if (!isEventStreamResponse(response) || !response.body) return response;

		const state: StreamNormalizerState = {
			toolCallIds: new Map(),
			toolCalls: new Map(),
		};
		const normalizedBody = normalizeOpenAICompatibleEventStream(
			response.body,
			state,
			() => `call_compat_${nextSyntheticToolCallId++}`,
		);

		return new Response(normalizedBody, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}

function isEventStreamResponse(response: Response): boolean {
	return (
		response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("text/event-stream") ?? false
	);
}

function normalizeOpenAICompatibleEventStream(
	body: ReadableStream<Uint8Array>,
	state: StreamNormalizerState,
	createSyntheticId: SyntheticToolCallIdFactory,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";

	const textStream = body.pipeThrough(
		new TransformStream<Uint8Array, string>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				enqueueCompleteServerSentEvents(controller, state, createSyntheticId);
			},
			flush(controller) {
				buffer += decoder.decode();
				if (buffer) {
					controller.enqueue(
						normalizeServerSentEvent(buffer, state, createSyntheticId),
					);
					buffer = "";
				}
			},
		}),
	);

	return textStream.pipeThrough(
		new TransformStream<string, Uint8Array>({
			transform(chunk, controller) {
				controller.enqueue(encoder.encode(chunk));
			},
		}),
	);

	function enqueueCompleteServerSentEvents(
		controller: TransformStreamDefaultController<string>,
		normalizerState: StreamNormalizerState,
		syntheticIdFactory: SyntheticToolCallIdFactory,
	): void {
		let boundary = findNextServerSentEventBoundary(buffer);
		while (boundary) {
			const rawEvent = buffer.slice(0, boundary.eventEnd);
			buffer = buffer.slice(boundary.nextEventStart);
			controller.enqueue(
				normalizeServerSentEvent(
					rawEvent + boundary.separator,
					normalizerState,
					syntheticIdFactory,
				),
			);
			boundary = findNextServerSentEventBoundary(buffer);
		}
	}
}

function findNextServerSentEventBoundary(
	value: string,
): { eventEnd: number; nextEventStart: number; separator: string } | null {
	const lfIndex = value.indexOf("\n\n");
	const crlfIndex = value.indexOf("\r\n\r\n");

	if (lfIndex === -1 && crlfIndex === -1) return null;
	if (crlfIndex !== -1 && (lfIndex === -1 || crlfIndex < lfIndex)) {
		return {
			eventEnd: crlfIndex,
			nextEventStart: crlfIndex + "\r\n\r\n".length,
			separator: "\r\n\r\n",
		};
	}

	return {
		eventEnd: lfIndex,
		nextEventStart: lfIndex + "\n\n".length,
		separator: "\n\n",
	};
}

function normalizeServerSentEvent(
	rawEvent: string,
	state: StreamNormalizerState,
	createSyntheticId: SyntheticToolCallIdFactory,
): string {
	const separator = rawEvent.endsWith("\r\n\r\n")
		? "\r\n\r\n"
		: rawEvent.endsWith("\n\n")
			? "\n\n"
			: "";
	const eventBody = separator ? rawEvent.slice(0, -separator.length) : rawEvent;
	const newline = eventBody.includes("\r\n") ? "\r\n" : "\n";
	const lines = eventBody.split(/\r?\n/);
	const dataLineIndexes = lines
		.map((line, index) => (line.startsWith("data:") ? index : -1))
		.filter((index) => index !== -1);

	if (dataLineIndexes.length !== 1) return rawEvent;

	const dataLineIndex = dataLineIndexes[0];
	const payload = lines[dataLineIndex].slice("data:".length).trimStart();
	if (payload === "[DONE]") {
		return `${formatSyntheticServerSentEvents(
			createParameterlessToolCallArgumentChunks(undefined, state),
			separator,
		)}${rawEvent}`;
	}
	if (!payload) return rawEvent;

	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return rawEvent;
	}

	const normalized = normalizeChatCompletionChunkToolCalls(
		parsed,
		state,
		createSyntheticId,
	);
	if (normalized === OMIT_SERVER_SENT_EVENT) return "";
	const parameterlessArgumentEvents = formatSyntheticServerSentEvents(
		createParameterlessToolCallArgumentChunks(
			normalized === parsed ? parsed : normalized,
			state,
		),
		separator,
	);
	if (normalized === parsed) return `${parameterlessArgumentEvents}${rawEvent}`;

	lines[dataLineIndex] = `data: ${JSON.stringify(normalized)}`;
	return `${parameterlessArgumentEvents}${lines.join(newline)}${separator}`;
}

function normalizeChatCompletionChunkToolCalls(
	value: unknown,
	state: StreamNormalizerState,
	createSyntheticId: SyntheticToolCallIdFactory,
): unknown {
	if (!isRecord(value) || !Array.isArray(value.choices)) return value;

	let changed = false;
	const choices = value.choices.flatMap((choice, choicePosition) => {
		if (!isRecord(choice) || !isRecord(choice.delta)) return [choice];
		const toolCalls = choice.delta.tool_calls;
		if (!Array.isArray(toolCalls)) return [choice];

		const choiceIndex = idPart(choice.index, choicePosition);
		let choiceChanged = false;
		const normalizedToolCalls = toolCalls.flatMap(
			(toolCall, toolCallPosition) => {
				if (!isRecord(toolCall)) return [toolCall];
				const toolCallIndex = idPart(toolCall.index, toolCallPosition);
				const stateKey = `${choiceIndex}:${toolCallIndex}`;
				const syntheticId = normalizeToolCallId(
					toolCall,
					state,
					stateKey,
					createSyntheticId,
				);
				const toolCallState = getToolCallState(state, stateKey, syntheticId);
				const functionDelta = isRecord(toolCall.function)
					? toolCall.function
					: undefined;
				const name =
					typeof functionDelta?.name === "string" &&
					functionDelta.name.length > 0
						? functionDelta.name
						: undefined;
				const argumentsDelta =
					typeof functionDelta?.arguments === "string"
						? functionDelta.arguments
						: undefined;

				if (name) toolCallState.name = name;
				if (!toolCallState.name) {
					if (argumentsDelta != null) {
						toolCallState.pendingArguments += argumentsDelta;
					}
					changed = true;
					choiceChanged = true;
					return [];
				}

				if (!toolCallState.emitted) {
					const argumentsText =
						toolCallState.pendingArguments + (argumentsDelta ?? "");
					toolCallState.pendingArguments = "";
					toolCallState.argumentsText += argumentsText;
					toolCallState.emitted = true;
					changed = true;
					choiceChanged = true;
					return [
						{
							...toolCall,
							id: toolCallState.id,
							function: {
								...functionDelta,
								name: toolCallState.name,
								arguments: argumentsText,
							},
						},
					];
				}

				if (argumentsDelta != null) {
					toolCallState.argumentsText += argumentsDelta;
				}

				if (toolCall.id === toolCallState.id) return [toolCall];
				changed = true;
				choiceChanged = true;
				return [{ ...toolCall, id: toolCallState.id }];
			},
		);

		if (!choiceChanged) return [choice];
		if (
			normalizedToolCalls.length === 0 &&
			Object.keys(choice.delta).length === 1
		) {
			return [];
		}
		return [
			{
				...choice,
				delta: {
					...choice.delta,
					tool_calls: normalizedToolCalls,
				},
			},
		];
	});

	if (!changed) return value;
	if (choices.length === 0) return OMIT_SERVER_SENT_EVENT;
	return { ...value, choices };
}

function normalizeToolCallId(
	toolCall: Record<string, unknown>,
	state: StreamNormalizerState,
	stateKey: string,
	createSyntheticId: SyntheticToolCallIdFactory,
): string {
	const existingId = toolCall.id;
	if (typeof existingId === "string") {
		state.toolCallIds.set(stateKey, existingId);
		return existingId;
	}

	let syntheticId = state.toolCallIds.get(stateKey);
	if (!syntheticId) {
		syntheticId = createSyntheticId();
		state.toolCallIds.set(stateKey, syntheticId);
	}
	return syntheticId;
}

function getToolCallState(
	state: StreamNormalizerState,
	stateKey: string,
	id: string,
): ToolCallStreamState {
	const existing = state.toolCalls.get(stateKey);
	if (existing) {
		existing.id = id;
		return existing;
	}

	const created: ToolCallStreamState = {
		id,
		emitted: false,
		argumentsText: "",
		pendingArguments: "",
		injectedParameterlessArguments: false,
	};
	state.toolCalls.set(stateKey, created);
	return created;
}

function createParameterlessToolCallArgumentChunks(
	value: unknown,
	state: StreamNormalizerState,
): unknown[] {
	if (value !== undefined && !chunkFinishesToolCalls(value)) return [];

	const choices = Array.from(state.toolCalls.entries()).flatMap(
		([stateKey, toolCallState]) => {
			if (
				!toolCallState.emitted ||
				!toolCallState.name ||
				toolCallState.argumentsText.length > 0 ||
				toolCallState.pendingArguments.length > 0 ||
				toolCallState.injectedParameterlessArguments
			) {
				return [];
			}

			toolCallState.injectedParameterlessArguments = true;
			toolCallState.argumentsText = "{}";
			const [choiceIndex, toolCallIndex] = stateKey.split(":");
			return [
				{
					index: numberFromIdPart(choiceIndex, 0),
					delta: {
						tool_calls: [
							{
								index: numberFromIdPart(toolCallIndex, 0),
								id: toolCallState.id,
								type: "function",
								function: { arguments: "{}" },
							},
						],
					},
					finish_reason: null,
				},
			];
		},
	);

	if (choices.length === 0) return [];
	const base = isRecord(value) ? value : {};
	return [{ ...base, choices }];
}

function chunkFinishesToolCalls(value: unknown): boolean {
	if (!isRecord(value) || !Array.isArray(value.choices)) return false;
	return value.choices.some(
		(choice) => isRecord(choice) && choice.finish_reason === "tool_calls",
	);
}

function formatSyntheticServerSentEvents(
	chunks: unknown[],
	separator: string,
): string {
	return chunks
		.map((chunk) => `data: ${JSON.stringify(chunk)}${separator || "\n\n"}`)
		.join("");
}

function numberFromIdPart(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function idPart(value: unknown, fallback: number): string {
	if (typeof value === "string" || typeof value === "number") {
		return String(value);
	}
	return String(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
