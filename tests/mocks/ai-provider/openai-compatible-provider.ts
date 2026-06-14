import {
	AI_SMOKE_ABORT_DELAY_MS,
	AI_SMOKE_MODEL_ID,
	AI_SMOKE_PLAIN_TEXT,
	AI_SMOKE_REASONING_TEXT,
	AI_SMOKE_SCENARIOS,
	AI_SMOKE_SLOW_CHUNK_DELAY_MS,
	AI_SMOKE_STREAM_REASONING_TEXT,
	AI_SMOKE_STREAM_TEXT,
	AI_SMOKE_TOOL_FINAL_TEXT,
	AI_SMOKE_TOOL_NAME,
} from "../../fixtures/ai/openai-compatible-scenarios";

const TOOL_CALL_ID = "call_fake_report_1";
const TOOL_CALL_INPUT = { title: "Deterministic fake report" };

export interface CapturedOpenAICompatibleRequest {
	id: number;
	method: string;
	path: string;
	authorization?: string;
	scenario?: string;
	body?: unknown;
	aborted: boolean;
}

export interface OpenAICompatibleProviderHarness {
	readonly origin: string;
	readonly baseURL: string;
	start(): Promise<void>;
	stop(): Promise<void>;
	reset(): Promise<void>;
	requests(): CapturedOpenAICompatibleRequest[];
}

export interface OpenAICompatibleProviderHarnessOptions {
	host?: string;
	port?: number;
}

const CORS_HEADERS = {
	"Access-Control-Allow-Headers": "authorization, content-type",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Origin": "*",
} as const;

const STREAM_HEADERS = {
	...CORS_HEADERS,
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
	"Content-Type": "text/event-stream; charset=utf-8",
} as const;

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasToolResultMessage(body: Record<string, unknown>): boolean {
	const messages = body.messages;
	return (
		Array.isArray(messages) &&
		messages.some(
			(message) =>
				isJsonObject(message) &&
				message.role === "tool" &&
				typeof message.tool_call_id === "string",
		)
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function toEventLine(body: unknown): string {
	return `data: ${typeof body === "string" ? body : JSON.stringify(body)}\n\n`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			...CORS_HEADERS,
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

function noContentResponse(): Response {
	return new Response(null, {
		status: 204,
		headers: CORS_HEADERS,
	});
}

function streamResponse(frames: unknown[]): Response {
	return new Response(
		`${frames.map(toEventLine).join("")}${toEventLine("[DONE]")}`,
		{
			status: 200,
			headers: STREAM_HEADERS,
		},
	);
}

function slowStreamResponse(signal: AbortSignal): Response {
	const encoder = new TextEncoder();
	const chunkBase = {
		id: "chatcmpl_fake_slow_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_006,
		model: AI_SMOKE_MODEL_ID,
	};

	const stream = new ReadableStream<Uint8Array>({
		start: async (controller) => {
			const onAbort = () => {
				controller.error(
					signal.reason instanceof DOMException
						? signal.reason
						: new DOMException("The operation was aborted.", "AbortError"),
				);
			};
			signal.addEventListener("abort", onAbort, { once: true });

			const writeChunk = (frame: unknown) => {
				controller.enqueue(encoder.encode(toEventLine(frame)));
			};

			try {
				await delay(AI_SMOKE_SLOW_CHUNK_DELAY_MS);
				writeChunk({
					...chunkBase,
					choices: [
						{
							index: 0,
							delta: { role: "assistant" },
							finish_reason: null,
						},
					],
				});
				await delay(AI_SMOKE_SLOW_CHUNK_DELAY_MS);
				writeChunk({
					...chunkBase,
					choices: [
						{
							index: 0,
							delta: { content: AI_SMOKE_STREAM_TEXT },
							finish_reason: null,
						},
					],
				});
				writeChunk({
					...chunkBase,
					choices: [
						{
							index: 0,
							delta: {},
							finish_reason: "stop",
						},
					],
				});
				controller.enqueue(encoder.encode(toEventLine("[DONE]")));
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});

	return new Response(stream, {
		status: 200,
		headers: STREAM_HEADERS,
	});
}

function timeoutAbortStreamResponse(
	captured: CapturedOpenAICompatibleRequest,
	signal: AbortSignal,
): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start: (controller) => {
			const markAbort = () => {
				captured.aborted = true;
				controller.error(
					signal.reason instanceof DOMException
						? signal.reason
						: new DOMException("The operation was aborted.", "AbortError"),
				);
			};
			signal.addEventListener("abort", markAbort, { once: true });
			controller.enqueue(
				encoder.encode(": fake provider holding stream open\\n\\n"),
			);
			setTimeout(() => {
				if (!captured.aborted) {
					controller.enqueue(
						encoder.encode(": still waiting for client abort\\n\\n"),
					);
				}
			}, AI_SMOKE_ABORT_DELAY_MS).unref?.();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: STREAM_HEADERS,
	});
}

function buildTextStreamResponse(): Response {
	const chunkBase = {
		id: "chatcmpl_fake_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_002,
		model: AI_SMOKE_MODEL_ID,
	};

	return streamResponse([
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: { role: "assistant" },
					finish_reason: null,
				},
			],
		},
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: { content: AI_SMOKE_STREAM_TEXT },
					finish_reason: null,
				},
			],
		},
		{
			...chunkBase,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
	]);
}

function buildReasoningStreamResponse(): Response {
	const chunkBase = {
		id: "chatcmpl_fake_reasoning_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_003,
		model: AI_SMOKE_MODEL_ID,
	};

	return streamResponse([
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: { reasoning_content: AI_SMOKE_STREAM_REASONING_TEXT },
					finish_reason: null,
				},
			],
		},
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: { content: AI_SMOKE_STREAM_TEXT },
					finish_reason: null,
				},
			],
		},
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 12,
				completion_tokens: 5,
				total_tokens: 17,
			},
		},
	]);
}

function buildToolCallStreamResponse(): Response {
	const chunkBase = {
		id: "chatcmpl_fake_tool_call_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_004,
		model: AI_SMOKE_MODEL_ID,
	};

	return streamResponse([
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: TOOL_CALL_ID,
								type: "function",
								function: {
									name: AI_SMOKE_TOOL_NAME,
									arguments: JSON.stringify(TOOL_CALL_INPUT),
								},
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: "tool_calls",
				},
			],
			usage: {
				prompt_tokens: 11,
				completion_tokens: 7,
				total_tokens: 18,
			},
		},
	]);
}

function buildToolCallWithoutIdStreamResponse(): Response {
	const chunkBase = {
		id: "chatcmpl_fake_tool_call_without_id_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_004,
		model: AI_SMOKE_MODEL_ID,
	};

	return streamResponse([
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								type: "function",
								function: {
									name: AI_SMOKE_TOOL_NAME,
									arguments: JSON.stringify(TOOL_CALL_INPUT),
								},
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: "tool_calls",
				},
			],
			usage: {
				prompt_tokens: 11,
				completion_tokens: 7,
				total_tokens: 18,
			},
		},
	]);
}

function buildToolFinalStreamResponse(): Response {
	const chunkBase = {
		id: "chatcmpl_fake_tool_final_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_005,
		model: AI_SMOKE_MODEL_ID,
	};

	return streamResponse([
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: { content: AI_SMOKE_TOOL_FINAL_TEXT },
					finish_reason: null,
				},
			],
		},
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 13,
				completion_tokens: 5,
				total_tokens: 18,
			},
		},
	]);
}

function buildEmptyStreamResponse(): Response {
	const chunkBase = {
		id: "chatcmpl_fake_empty_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_007,
		model: AI_SMOKE_MODEL_ID,
	};

	return streamResponse([
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: { role: "assistant" },
					finish_reason: null,
				},
			],
		},
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 0,
				total_tokens: 10,
			},
		},
	]);
}

export function createOpenAICompatibleProviderHarness(
	options: OpenAICompatibleProviderHarnessOptions = {},
): OpenAICompatibleProviderHarness {
	const host = options.host ?? "127.0.0.1";
	const port = options.port;
	let origin = "";
	let active = false;
	let nextRequestId = 1;
	const requests: CapturedOpenAICompatibleRequest[] = [];
	let originalFetch: typeof fetch | null = null;

	function startMock(): void {
		if (options.host && host !== "127.0.0.1" && host !== "localhost") {
			throw new Error(
				`Fake OpenAI-compatible provider failed to listen: listen EPERM: operation not permitted ${host}`,
			);
		}

		if (origin) {
			return;
		}

		origin = `http://${host}${typeof port === "number" && port > 0 ? `:${port}` : ""}`;
		originalFetch = globalThis.fetch;
		(globalThis as unknown as { fetch: typeof fetch }).fetch = async (
			input: string | URL | globalThis.Request,
			init?: RequestInit,
		): Promise<Response> => {
			if (!origin) {
				return originalFetch(input as RequestInfo, init);
			}

			const request =
				input instanceof globalThis.Request ? input : new Request(input, init);
			const requestUrl = new URL(request.url);
			if (requestUrl.origin !== origin) {
				return originalFetch(input as RequestInfo, init);
			}

			if (request.signal?.aborted) {
				throw (
					request.signal.reason ??
					new DOMException("The operation was aborted.", "AbortError")
				);
			}

			const method = request.method.toUpperCase();
			const path = requestUrl.pathname;
			const scenario = request.headers.get("x-ai-smoke-scenario") ?? undefined;
			const rawBody = request.body ? await request.text() : "";
			let body: unknown;
			if (rawBody) {
				body = JSON.parse(rawBody);
			}

			const captureRequest = (): CapturedOpenAICompatibleRequest => {
				const captured: CapturedOpenAICompatibleRequest = {
					id: nextRequestId++,
					method,
					path,
					authorization: request.headers.get("authorization")
						? "Bearer [redacted]"
						: undefined,
					scenario,
					body,
					aborted: false,
				};
				if (request.signal) {
					request.signal.addEventListener(
						"abort",
						() => {
							captured.aborted = true;
						},
						{ once: true },
					);
				}
				requests.push(captured);
				return captured;
			};

			if (method === "OPTIONS") {
				return noContentResponse();
			}

			if (method === "GET" && path === "/v1/models") {
				captureRequest();
				return jsonResponse({
					object: "list",
					data: [
						{
							id: AI_SMOKE_MODEL_ID,
							object: "model",
							created: 1_700_000_000,
							owned_by: "alfyai-smoke",
						},
					],
				});
			}

			if (method === "POST" && path === "/v1/chat/completions") {
				const captured = captureRequest();
				if (scenario === AI_SMOKE_SCENARIOS.rateLimit) {
					return jsonResponse(
						{
							error: {
								message: "Fake provider rate limit exceeded.",
								type: "rate_limit_error",
								code: "rate_limit_exceeded",
							},
						},
						429,
					);
				}

				if (scenario === AI_SMOKE_SCENARIOS.serverError) {
					return jsonResponse(
						{
							error: {
								message: "Fake provider internal server error.",
								type: "server_error",
								code: "internal_server_error",
							},
						},
						500,
					);
				}

				if (isJsonObject(body) && body.stream === true) {
					if (scenario === AI_SMOKE_SCENARIOS.reasoning) {
						return buildReasoningStreamResponse();
					}
					if (scenario === AI_SMOKE_SCENARIOS.toolRoundtrip) {
						if (hasToolResultMessage(body)) {
							return buildToolFinalStreamResponse();
						}
						return buildToolCallStreamResponse();
					}
					if (scenario === AI_SMOKE_SCENARIOS.toolRoundtripMissingToolCallId) {
						if (hasToolResultMessage(body)) {
							return buildToolFinalStreamResponse();
						}
						return buildToolCallWithoutIdStreamResponse();
					}
					if (scenario === AI_SMOKE_SCENARIOS.slowChunks) {
						return slowStreamResponse(
							request.signal ?? new AbortController().signal,
						);
					}
					if (scenario === AI_SMOKE_SCENARIOS.emptyOutput) {
						return buildEmptyStreamResponse();
					}
					if (scenario === AI_SMOKE_SCENARIOS.timeoutAbort) {
						return timeoutAbortStreamResponse(
							captured,
							request.signal ?? new AbortController().signal,
						);
					}

					return buildTextStreamResponse();
				}

				return jsonResponse({
					id: "chatcmpl_fake_plain",
					object: "chat.completion",
					created: 1_700_000_001,
					model: AI_SMOKE_MODEL_ID,
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content:
									scenario === AI_SMOKE_SCENARIOS.emptyOutput
										? ""
										: AI_SMOKE_PLAIN_TEXT,
								...(scenario === AI_SMOKE_SCENARIOS.reasoning
									? { reasoning_content: AI_SMOKE_REASONING_TEXT }
									: {}),
							},
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 12,
						completion_tokens: 5,
						total_tokens: 17,
					},
				});
			}

			if (method === "GET" && path === "/__ai-smoke/requests") {
				return jsonResponse({ requests });
			}

			if (method === "POST" && path === "/__ai-smoke/reset") {
				await reset();
				return noContentResponse();
			}

			return jsonResponse({ error: "Not found" }, 404);
		};
	}

	async function start(): Promise<void> {
		if (active) return;

		try {
			startMock();
		} catch (error) {
			origin = "";
			throw error instanceof Error
				? error
				: new Error(
						`Fake OpenAI-compatible provider failed to listen: ${String(error)}`,
					);
		}

		active = true;
		await Promise.resolve();
	}

	async function stop(): Promise<void> {
		if (!active) return;
		if (originalFetch) {
			(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		}
		originalFetch = null;
		active = false;
		origin = "";
	}

	function reset(): Promise<void> {
		requests.length = 0;
		nextRequestId = 1;
		return Promise.resolve();
	}

	return {
		get origin() {
			if (!origin) {
				throw new Error(
					"Fake OpenAI-compatible provider has not been started.",
				);
			}
			return origin;
		},
		get baseURL() {
			return `${this.origin}/v1`;
		},
		start,
		stop,
		reset,
		requests: () => requests.map((request) => ({ ...request })),
	};
}
