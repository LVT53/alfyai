import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
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

export function createOpenAICompatibleProviderHarness(
	options: OpenAICompatibleProviderHarnessOptions = {},
): OpenAICompatibleProviderHarness {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	let server: Server | undefined;
	let origin = "";
	let nextRequestId = 1;
	const requests: CapturedOpenAICompatibleRequest[] = [];

	async function start(): Promise<void> {
		if (server) return;

		server = createServer((request, response) => {
			void handleRequest(request, response);
		});

		await new Promise<void>((resolve, reject) => {
			const pendingServer = server;
			if (!pendingServer) {
				reject(
					new Error(
						"Fake OpenAI-compatible provider failed to create an HTTP server.",
					),
				);
				return;
			}

			const rejectListen = (error: Error) => {
				pendingServer.off("listening", resolveListen);
				server = undefined;
				origin = "";
				reject(
					new Error(
						`Fake OpenAI-compatible provider failed to listen: ${error.message}`,
					),
				);
			};

			const resolveListen = () => {
				pendingServer.off("error", rejectListen);
				resolve();
			};

			pendingServer.once("error", rejectListen);
			pendingServer.once("listening", resolveListen);
			pendingServer.listen(port, host);
		});

		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error(
				"Fake OpenAI-compatible provider did not bind to a TCP port.",
			);
		}
		origin = `http://${host}:${address.port}`;
	}

	async function stop(): Promise<void> {
		if (!server) return;
		const activeServer = server;
		server = undefined;
		origin = "";

		await new Promise<void>((resolve, reject) => {
			activeServer.close((error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	function reset(): Promise<void> {
		requests.length = 0;
		nextRequestId = 1;
		return Promise.resolve();
	}

	async function handleRequest(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");

		if (request.method === "OPTIONS") {
			writeNoContent(response);
			return;
		}

		if (request.method === "GET" && url.pathname === "/v1/models") {
			captureRequest(request, url.pathname, undefined);
			writeJson(response, 200, {
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
			return;
		}

		if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
			const body = await readJsonBody(request);
			const captured = captureRequest(request, url.pathname, body);
			const scenario = request.headers["x-ai-smoke-scenario"];

			if (scenario === AI_SMOKE_SCENARIOS.rateLimit) {
				writeJson(response, 429, {
					error: {
						message: "Fake provider rate limit exceeded.",
						type: "rate_limit_error",
						code: "rate_limit_exceeded",
					},
				});
				return;
			}

			if (scenario === AI_SMOKE_SCENARIOS.serverError) {
				writeJson(response, 500, {
					error: {
						message: "Fake provider internal server error.",
						type: "server_error",
						code: "internal_server_error",
					},
				});
				return;
			}

			if (isJsonObject(body) && body.stream === true) {
				if (scenario === AI_SMOKE_SCENARIOS.reasoning) {
					writeReasoningChatCompletionStream(response);
					return;
				}
				if (scenario === AI_SMOKE_SCENARIOS.toolRoundtrip) {
					if (hasToolResultMessage(body)) {
						writeToolFinalChatCompletionStream(response);
						return;
					}

					writeToolCallChatCompletionStream(response);
					return;
				}
				if (scenario === AI_SMOKE_SCENARIOS.toolRoundtripMissingToolCallId) {
					if (hasToolResultMessage(body)) {
						writeToolFinalChatCompletionStream(response);
						return;
					}

					writeToolCallWithoutIdChatCompletionStream(response);
					return;
				}
				if (scenario === AI_SMOKE_SCENARIOS.slowChunks) {
					await writeSlowChatCompletionStream(response);
					return;
				}
				if (scenario === AI_SMOKE_SCENARIOS.emptyOutput) {
					writeEmptyChatCompletionStream(response);
					return;
				}
				if (scenario === AI_SMOKE_SCENARIOS.timeoutAbort) {
					writeTimeoutAbortChatCompletionStream(response, captured);
					return;
				}

				writeChatCompletionStream(response);
				return;
			}

			writeJson(response, 200, {
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
			return;
		}

		if (request.method === "GET" && url.pathname === "/__ai-smoke/requests") {
			writeJson(response, 200, { requests });
			return;
		}

		if (request.method === "POST" && url.pathname === "/__ai-smoke/reset") {
			await reset();
			writeNoContent(response);
			return;
		}

		writeJson(response, 404, { error: "Not found" });
	}

	function captureRequest(
		request: IncomingMessage,
		path: string,
		body: unknown,
	): CapturedOpenAICompatibleRequest {
		const captured: CapturedOpenAICompatibleRequest = {
			id: nextRequestId++,
			method: request.method ?? "GET",
			path,
			authorization: request.headers.authorization
				? "Bearer [redacted]"
				: undefined,
			scenario: headerValue(request.headers["x-ai-smoke-scenario"]),
			body,
			aborted: false,
		};

		request.on("aborted", () => {
			captured.aborted = true;
		});

		requests.push(captured);
		return captured;
	}

	return {
		get origin() {
			if (!origin)
				throw new Error(
					"Fake OpenAI-compatible provider has not been started.",
				);
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	const rawBody = Buffer.concat(chunks).toString("utf8");
	if (!rawBody) return undefined;
	return JSON.parse(rawBody);
}

function writeJson(
	response: ServerResponse,
	status: number,
	body: unknown,
): void {
	response.writeHead(status, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Content-Type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(body));
}

function writeNoContent(response: ServerResponse): void {
	response.writeHead(204, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
	});
	response.end();
}

function writeChatCompletionStream(response: ServerResponse): void {
	const chunkBase = {
		id: "chatcmpl_fake_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_002,
		model: AI_SMOKE_MODEL_ID,
	};

	response.writeHead(200, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Content-Type": "text/event-stream; charset=utf-8",
	});

	writeServerSentEvent(response, {
		...chunkBase,
		choices: [
			{
				index: 0,
				delta: { role: "assistant" },
				finish_reason: null,
			},
		],
	});
	writeServerSentEvent(response, {
		...chunkBase,
		choices: [
			{
				index: 0,
				delta: { content: AI_SMOKE_STREAM_TEXT },
				finish_reason: null,
			},
		],
	});
	writeServerSentEvent(response, {
		...chunkBase,
		choices: [
			{
				index: 0,
				delta: {},
				finish_reason: "stop",
			},
		],
	});
	response.end("data: [DONE]\n\n");
}

function writeTimeoutAbortChatCompletionStream(
	response: ServerResponse,
	captured: CapturedOpenAICompatibleRequest,
): void {
	response.writeHead(200, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Content-Type": "text/event-stream; charset=utf-8",
	});
	response.write(": fake provider holding stream open\n\n");
	response.flushHeaders();

	const markAbort = () => {
		captured.aborted = true;
	};
	response.once("close", markAbort);

	setTimeout(() => {
		if (!response.destroyed) {
			response.write(": still waiting for client abort\n\n");
		}
	}, AI_SMOKE_ABORT_DELAY_MS).unref?.();
}

function writeEmptyChatCompletionStream(response: ServerResponse): void {
	const chunkBase = {
		id: "chatcmpl_fake_empty_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_007,
		model: AI_SMOKE_MODEL_ID,
	};

	response.writeHead(200, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Content-Type": "text/event-stream; charset=utf-8",
	});

	writeServerSentEvent(response, {
		...chunkBase,
		choices: [
			{
				index: 0,
				delta: { role: "assistant" },
				finish_reason: null,
			},
		],
	});
	writeServerSentEvent(response, {
		...chunkBase,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: {
			prompt_tokens: 10,
			completion_tokens: 0,
			total_tokens: 10,
		},
	});
	response.end("data: [DONE]\n\n");
}

async function writeSlowChatCompletionStream(
	response: ServerResponse,
): Promise<void> {
	const chunkBase = {
		id: "chatcmpl_fake_slow_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_006,
		model: AI_SMOKE_MODEL_ID,
	};

	response.writeHead(200, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Content-Type": "text/event-stream; charset=utf-8",
	});

	writeServerSentEvent(response, {
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
	writeServerSentEvent(response, {
		...chunkBase,
		choices: [
			{
				index: 0,
				delta: { content: AI_SMOKE_STREAM_TEXT },
				finish_reason: null,
			},
		],
	});
	await delay(AI_SMOKE_SLOW_CHUNK_DELAY_MS);
	writeServerSentEvent(response, {
		...chunkBase,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	});
	response.end("data: [DONE]\n\n");
}

function writeToolCallChatCompletionStream(response: ServerResponse): void {
	const chunkBase = {
		id: "chatcmpl_fake_tool_call_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_004,
		model: AI_SMOKE_MODEL_ID,
	};

	response.writeHead(200, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Content-Type": "text/event-stream; charset=utf-8",
	});

	writeServerSentEvent(response, {
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
	});
	writeServerSentEvent(response, {
		...chunkBase,
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		usage: {
			prompt_tokens: 11,
			completion_tokens: 7,
			total_tokens: 18,
		},
	});
	response.end("data: [DONE]\n\n");
}

function writeToolCallWithoutIdChatCompletionStream(
	response: ServerResponse,
): void {
	const chunkBase = {
		id: "chatcmpl_fake_tool_call_without_id_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_004,
		model: AI_SMOKE_MODEL_ID,
	};

	response.writeHead(200, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Content-Type": "text/event-stream; charset=utf-8",
	});

	writeServerSentEvent(response, {
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
	});
	writeServerSentEvent(response, {
		...chunkBase,
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		usage: {
			prompt_tokens: 11,
			completion_tokens: 7,
			total_tokens: 18,
		},
	});
	response.end("data: [DONE]\n\n");
}

function writeToolFinalChatCompletionStream(response: ServerResponse): void {
	const chunkBase = {
		id: "chatcmpl_fake_tool_final_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_005,
		model: AI_SMOKE_MODEL_ID,
	};

	response.writeHead(200, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Content-Type": "text/event-stream; charset=utf-8",
	});

	writeServerSentEvent(response, {
		...chunkBase,
		choices: [
			{
				index: 0,
				delta: { content: AI_SMOKE_TOOL_FINAL_TEXT },
				finish_reason: null,
			},
		],
	});
	writeServerSentEvent(response, {
		...chunkBase,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: {
			prompt_tokens: 13,
			completion_tokens: 5,
			total_tokens: 18,
		},
	});
	response.end("data: [DONE]\n\n");
}

function writeReasoningChatCompletionStream(response: ServerResponse): void {
	const chunkBase = {
		id: "chatcmpl_fake_reasoning_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_003,
		model: AI_SMOKE_MODEL_ID,
	};

	response.writeHead(200, {
		"Access-Control-Allow-Headers": "authorization, content-type",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Content-Type": "text/event-stream; charset=utf-8",
	});

	writeServerSentEvent(response, {
		...chunkBase,
		choices: [
			{
				index: 0,
				delta: { reasoning_content: AI_SMOKE_STREAM_REASONING_TEXT },
				finish_reason: null,
			},
		],
	});
	writeServerSentEvent(response, {
		...chunkBase,
		choices: [
			{
				index: 0,
				delta: { content: AI_SMOKE_STREAM_TEXT },
				finish_reason: null,
			},
		],
	});
	writeServerSentEvent(response, {
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
	});
	response.end("data: [DONE]\n\n");
}

function writeServerSentEvent(response: ServerResponse, body: unknown): void {
	response.write(`data: ${JSON.stringify(body)}\n\n`);
}

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

function headerValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}
