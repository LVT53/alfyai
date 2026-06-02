type SyntheticToolCallIdFactory = () => string;

type ToolCallIdState = {
	toolCallIds: Map<string, string>;
};

export function createOpenAICompatibleStreamNormalizingFetch(
	baseFetch: typeof fetch = fetch,
): typeof fetch {
	let nextSyntheticToolCallId = 0;

	return async (input, init) => {
		const response = await baseFetch(input, init);
		if (!isEventStreamResponse(response) || !response.body) return response;

		const state: ToolCallIdState = { toolCallIds: new Map() };
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
	state: ToolCallIdState,
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
		normalizerState: ToolCallIdState,
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
	state: ToolCallIdState,
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
	if (payload === "[DONE]" || !payload) return rawEvent;

	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return rawEvent;
	}

	const normalized = normalizeChatCompletionChunkToolCallIds(
		parsed,
		state,
		createSyntheticId,
	);
	if (normalized === parsed) return rawEvent;

	lines[dataLineIndex] = `data: ${JSON.stringify(normalized)}`;
	return `${lines.join(newline)}${separator}`;
}

function normalizeChatCompletionChunkToolCallIds(
	value: unknown,
	state: ToolCallIdState,
	createSyntheticId: SyntheticToolCallIdFactory,
): unknown {
	if (!isRecord(value) || !Array.isArray(value.choices)) return value;

	let changed = false;
	const choices = value.choices.map((choice, choicePosition) => {
		if (!isRecord(choice) || !isRecord(choice.delta)) return choice;
		const toolCalls = choice.delta.tool_calls;
		if (!Array.isArray(toolCalls)) return choice;

		const choiceIndex = idPart(choice.index, choicePosition);
		let choiceChanged = false;
		const normalizedToolCalls = toolCalls.map((toolCall, toolCallPosition) => {
			if (!isRecord(toolCall)) return toolCall;
			const toolCallIndex = idPart(toolCall.index, toolCallPosition);
			const stateKey = `${choiceIndex}:${toolCallIndex}`;
			const existingId = toolCall.id;

			if (typeof existingId === "string") {
				state.toolCallIds.set(stateKey, existingId);
				return toolCall;
			}

			let syntheticId = state.toolCallIds.get(stateKey);
			if (!syntheticId) {
				syntheticId = createSyntheticId();
				state.toolCallIds.set(stateKey, syntheticId);
			}

			changed = true;
			choiceChanged = true;
			return { ...toolCall, id: syntheticId };
		});

		if (!choiceChanged) return choice;
		return {
			...choice,
			delta: {
				...choice.delta,
				tool_calls: normalizedToolCalls,
			},
		};
	});

	if (!changed) return value;
	return { ...value, choices };
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
