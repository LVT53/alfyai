import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
	AI_SMOKE_ABORT_DELAY_MS,
	AI_SMOKE_CREATE_ARTIFACT_FINAL_TEXT,
	AI_SMOKE_CREATE_ARTIFACT_MARKDOWN,
	AI_SMOKE_CREATE_ARTIFACT_MARKER,
	AI_SMOKE_CREATE_ARTIFACT_TITLE,
	AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT,
	AI_SMOKE_EDIT_ARTIFACT_MARKER,
	AI_SMOKE_MODEL_ID,
	AI_SMOKE_PLAIN_TEXT,
	AI_SMOKE_PROJECT_FILE_PROBE_PREFIX,
	AI_SMOKE_READ_PROJECT_FILE_FINAL_TEXT,
	AI_SMOKE_READ_PROJECT_FILE_MARKER,
	AI_SMOKE_READ_PROJECT_FILE_TOOL_NAME,
	AI_SMOKE_REASONING_TEXT,
	AI_SMOKE_SCENARIOS,
	AI_SMOKE_SLOW_CHUNK_DELAY_MS,
	AI_SMOKE_STANDING_INSTRUCTION_MARKER,
	AI_SMOKE_STANDING_INSTRUCTION_TEXT,
	AI_SMOKE_STREAM_REASONING_TEXT,
	AI_SMOKE_STREAM_TEXT,
	AI_SMOKE_SUGGEST_INSTRUCTION_FINAL_TEXT,
	AI_SMOKE_SUGGEST_INSTRUCTION_TOOL_NAME,
	AI_SMOKE_TOOL_FINAL_TEXT,
	AI_SMOKE_TOOL_NAME,
	decodeEditArtifactScenarioPayload,
} from "../../fixtures/ai/openai-compatible-scenarios";

const TOOL_CALL_ID = "call_fake_report_1";
const TOOL_CALL_INPUT = { title: "Deterministic fake report" };
const READ_PROJECT_FILE_CALL_ID = "call_fake_read_project_file_1";
const SUGGEST_INSTRUCTION_CALL_ID = "call_fake_suggest_instruction_1";
const SUGGEST_INSTRUCTION_CALL_INPUT = {
	text: AI_SMOKE_STANDING_INSTRUCTION_TEXT,
	scope: "personal",
};
const EDIT_ARTIFACT_CALL_ID = "call_fake_edit_artifact_1";
const CREATE_ARTIFACT_CALL_ID = "call_fake_create_artifact_1";

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

async function readRequestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function toRequestHeaders(request: IncomingMessage): Headers {
	const headers = new Headers();
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		const name = request.rawHeaders[index];
		const value = request.rawHeaders[index + 1];
		if (name && value !== undefined) {
			headers.append(name, value);
		}
	}
	return headers;
}

async function writeResponse(
	serverResponse: ServerResponse,
	response: Response,
): Promise<void> {
	serverResponse.writeHead(
		response.status,
		Object.fromEntries(response.headers.entries()),
	);

	if (!response.body) {
		serverResponse.end();
		return;
	}

	try {
		for await (const chunk of response.body) {
			if (!serverResponse.write(Buffer.from(chunk))) {
				await once(serverResponse, "drain");
			}
		}
		serverResponse.end();
	} catch (error) {
		if (!serverResponse.destroyed) {
			serverResponse.destroy(error instanceof Error ? error : undefined);
		}
	}
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

/**
 * The standing-instruction scenario: the model calls the app's real
 * `suggest_instruction` tool, the app executes it against the real registry
 * (and so records the offer on the turn), and the follow-up request — the one
 * carrying the tool result — answers in text.
 *
 * Requested by the message text rather than a header, because the app path has
 * no way to send one (see the marker's comment in the fixtures).
 */
function bodyAsksForStandingInstruction(body: unknown): boolean {
	return JSON.stringify(body).includes(AI_SMOKE_STANDING_INSTRUCTION_MARKER);
}

function buildSuggestInstructionToolCallStreamResponse(): Response {
	const chunkBase = {
		id: "chatcmpl_fake_suggest_instruction_call_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_006,
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
								id: SUGGEST_INSTRUCTION_CALL_ID,
								type: "function",
								function: {
									name: AI_SMOKE_SUGGEST_INSTRUCTION_TOOL_NAME,
									arguments: JSON.stringify(SUGGEST_INSTRUCTION_CALL_INPUT),
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

function buildSuggestInstructionFinalStreamResponse(): Response {
	const chunkBase = {
		id: "chatcmpl_fake_suggest_instruction_final_stream",
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
					delta: { content: AI_SMOKE_SUGGEST_INSTRUCTION_FINAL_TEXT },
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
				prompt_tokens: 21,
				completion_tokens: 9,
				total_tokens: 30,
			},
		},
	]);
}

/**
 * T8 live: a real `edit_artifact` call against a Document the test seeded
 * directly (never through this fake model — `read_artifact`'s snapshot-write
 * is exercised by that direct setup call, not scripted here). The message
 * itself carries the exact block ids/hash the test's setup already resolved
 * (see the marker's own comment in the fixtures) — this scenario just reads
 * them back out and forwards them verbatim as the tool call's arguments.
 */
function bodyAsksForEditArtifact(body: unknown): boolean {
	return JSON.stringify(body).includes(AI_SMOKE_EDIT_ARTIFACT_MARKER);
}

function findEditArtifactPayload(body: unknown) {
	return decodeEditArtifactScenarioPayload(JSON.stringify(body));
}

function buildEditArtifactToolCallStreamResponse(
	payload: NonNullable<ReturnType<typeof findEditArtifactPayload>>,
): Response {
	const chunkBase = {
		id: "chatcmpl_fake_edit_artifact_call_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_009,
		model: AI_SMOKE_MODEL_ID,
	};
	const args = {
		artifactId: payload.artifactId,
		summary: "Scripted edit",
		patches: [
			{
				op: "replaceBlock",
				blockId: payload.applyBlockId,
				baseHash: payload.applyBaseHash,
				text: "Book the hotel by Friday.",
			},
			{
				op: "replaceBlock",
				blockId: payload.refuseBlockId,
				// Deliberately wrong: this op is refused as block_changed —
				// the fake model has no way to know the real hash, which is
				// exactly the point (a hash it never read must never apply).
				baseHash: "stale-hash-the-model-never-actually-read",
				text: "This should never land.",
			},
		],
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
								id: EDIT_ARTIFACT_CALL_ID,
								type: "function",
								function: {
									name: "edit_artifact",
									arguments: JSON.stringify(args),
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
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
		},
	]);
}

function buildEditArtifactFinalStreamResponse(): Response {
	const chunkBase = {
		id: "chatcmpl_fake_edit_artifact_final_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_010,
		model: AI_SMOKE_MODEL_ID,
	};
	return streamResponse([
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: { content: AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT },
					finish_reason: null,
				},
			],
		},
		{
			...chunkBase,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
		},
	]);
}

/**
 * The in-chat card (Feature 2, the cross-kind task): a real `create_artifact`
 * call, scripted with a fixed title/body — unlike T8 live's `edit_artifact`,
 * nothing here depends on ids or hashes the test's own setup resolved first.
 */
function bodyAsksForCreateArtifact(body: unknown): boolean {
	return JSON.stringify(body).includes(AI_SMOKE_CREATE_ARTIFACT_MARKER);
}

function buildCreateArtifactToolCallStreamResponse(): Response {
	const chunkBase = {
		id: "chatcmpl_fake_create_artifact_call_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_011,
		model: AI_SMOKE_MODEL_ID,
	};
	const args = {
		artifactType: "document",
		title: AI_SMOKE_CREATE_ARTIFACT_TITLE,
		body: AI_SMOKE_CREATE_ARTIFACT_MARKDOWN,
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
								id: CREATE_ARTIFACT_CALL_ID,
								type: "function",
								function: {
									name: "create_artifact",
									arguments: JSON.stringify(args),
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
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
		},
	]);
}

function buildCreateArtifactFinalStreamResponse(): Response {
	const chunkBase = {
		id: "chatcmpl_fake_create_artifact_final_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_012,
		model: AI_SMOKE_MODEL_ID,
	};
	return streamResponse([
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: { content: AI_SMOKE_CREATE_ARTIFACT_FINAL_TEXT },
					finish_reason: null,
				},
			],
		},
		{
			...chunkBase,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
		},
	]);
}

/**
 * The read-a-project-file scenario: the model reads a file it found in the
 * prompt's project file list — never a name the user typed — with the app's
 * real `read_generated_file` tool, and the follow-up request, the one carrying
 * the tool result, answers in text. A prompt with no probe file in it gets plain
 * text, so a spec that expected the read fails on its own assertions instead of
 * hanging.
 */
function bodyAsksToReadProjectFile(body: unknown): boolean {
	return JSON.stringify(body).includes(AI_SMOKE_READ_PROJECT_FILE_MARKER);
}

const PROJECT_FILE_PROBE_NAME_RE = new RegExp(
	`${AI_SMOKE_PROJECT_FILE_PROBE_PREFIX}[0-9a-f]{8}\\.txt`,
);

function findProjectFileProbeName(body: unknown): string | null {
	return JSON.stringify(body).match(PROJECT_FILE_PROBE_NAME_RE)?.[0] ?? null;
}

function buildReadProjectFileStreamResponse(
	body: Record<string, unknown>,
): Response {
	const chunkBase = {
		id: "chatcmpl_fake_read_project_file_stream",
		object: "chat.completion.chunk",
		created: 1_700_000_008,
		model: AI_SMOKE_MODEL_ID,
	};
	const answeredWithToolResult = hasToolResultMessage(body);
	const filename = answeredWithToolResult
		? null
		: findProjectFileProbeName(body);
	if (!answeredWithToolResult && !filename) return buildTextStreamResponse();
	// One delta, then the finish frame with usage — the shape every scripted
	// response here takes.
	const delta = filename
		? {
				tool_calls: [
					{
						index: 0,
						id: READ_PROJECT_FILE_CALL_ID,
						type: "function",
						function: {
							name: AI_SMOKE_READ_PROJECT_FILE_TOOL_NAME,
							arguments: JSON.stringify({ filename }),
						},
					},
				],
			}
		: { content: AI_SMOKE_READ_PROJECT_FILE_FINAL_TEXT };
	return streamResponse([
		{
			...chunkBase,
			choices: [{ index: 0, delta, finish_reason: null }],
		},
		{
			...chunkBase,
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: filename ? "tool_calls" : "stop",
				},
			],
			usage: { prompt_tokens: 15, completion_tokens: 6, total_tokens: 21 },
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
	let server: ReturnType<typeof createServer> | null = null;

	async function handleRequest(request: Request): Promise<Response> {
		if (!origin) {
			return jsonResponse({ error: "Fake provider is not running" }, 503);
		}

		if (request.signal?.aborted) {
			throw (
				request.signal.reason ??
				new DOMException("The operation was aborted.", "AbortError")
			);
		}

		const requestUrl = new URL(request.url);
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
				if (bodyAsksToReadProjectFile(body)) {
					return buildReadProjectFileStreamResponse(body);
				}
				if (bodyAsksForStandingInstruction(body)) {
					if (hasToolResultMessage(body)) {
						return buildSuggestInstructionFinalStreamResponse();
					}
					return buildSuggestInstructionToolCallStreamResponse();
				}
				if (bodyAsksForEditArtifact(body)) {
					if (hasToolResultMessage(body)) {
						return buildEditArtifactFinalStreamResponse();
					}
					const payload = findEditArtifactPayload(body);
					if (payload) return buildEditArtifactToolCallStreamResponse(payload);
					return buildTextStreamResponse();
				}
				if (bodyAsksForCreateArtifact(body)) {
					if (hasToolResultMessage(body)) {
						return buildCreateArtifactFinalStreamResponse();
					}
					return buildCreateArtifactToolCallStreamResponse();
				}
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
	}

	async function startMock(): Promise<void> {
		if (options.host && host !== "127.0.0.1" && host !== "localhost") {
			throw new Error(
				`Fake OpenAI-compatible provider failed to listen: listen EPERM: operation not permitted ${host}`,
			);
		}

		if (origin) {
			return;
		}

		server = createServer(async (incomingRequest, serverResponse) => {
			const abortController = new AbortController();
			incomingRequest.on("aborted", () => {
				abortController.abort(
					new DOMException("The operation was aborted.", "AbortError"),
				);
			});
			serverResponse.on("close", () => {
				if (!serverResponse.writableEnded && !abortController.signal.aborted) {
					abortController.abort(
						new DOMException("The operation was aborted.", "AbortError"),
					);
				}
			});

			try {
				if (!incomingRequest.url || !incomingRequest.method) {
					await writeResponse(
						serverResponse,
						jsonResponse({ error: "Bad request" }, 400),
					);
					return;
				}

				const rawBody = await readRequestBody(incomingRequest);
				const request = new Request(`${origin}${incomingRequest.url}`, {
					method: incomingRequest.method,
					headers: toRequestHeaders(incomingRequest),
					body:
						incomingRequest.method === "GET" ||
						incomingRequest.method === "HEAD"
							? undefined
							: rawBody,
					signal: abortController.signal,
				});
				await writeResponse(serverResponse, await handleRequest(request));
			} catch (error) {
				if (!serverResponse.headersSent) {
					await writeResponse(
						serverResponse,
						jsonResponse(
							{
								error:
									error instanceof Error
										? error.message
										: "Internal server error",
							},
							500,
						),
					);
					return;
				}
				if (!serverResponse.destroyed) {
					serverResponse.destroy(error instanceof Error ? error : undefined);
				}
			}
		});

		await new Promise<void>((resolve, reject) => {
			const fail = (error: Error) => {
				server = null;
				reject(error);
			};
			server?.once("error", fail);
			server?.listen(port ?? 0, host, () => {
				server?.off("error", fail);
				const address = server?.address();
				if (!address || typeof address === "string") {
					reject(
						new Error("Fake OpenAI-compatible provider failed to resolve port"),
					);
					return;
				}
				origin = `http://${host}:${(address as AddressInfo).port}`;
				resolve();
			});
		});
	}

	async function start(): Promise<void> {
		if (active) return;

		try {
			await startMock();
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
		if (server) {
			await new Promise<void>((resolve, reject) => {
				server?.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
		server = null;
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
