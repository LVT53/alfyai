// Fake providers for the failover tests: the replies a provider puts on the
// wire (a whole reply, a stream cut in the middle, an HTTP error, a request that
// never answers) and a fetch that routes each request to a script per host and
// records what every provider was sent. Shared by the engine and the
// prepared-turn failover tests; it mocks nothing itself.
export type Transport = "plain" | "streaming";
export const TRANSPORTS: Transport[] = ["plain", "streaming"];

const USAGE = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
const encoder = new TextEncoder();
export const timeoutError = () =>
	Object.assign(new Error("request timed out"), { name: "TimeoutError" });
const toolCall = (call: string | { id: string; name: string }) => ({
	id: typeof call === "string" ? call : call.id,
	type: "function",
	function: {
		name: typeof call === "string" ? "lookup" : call.name,
		arguments: "{}",
	},
});

/** One step of a provider: its words, its reasoning and the tool it calls (by id, or id and name). */
export type Turn = {
	text?: string;
	reasoning?: string;
	call?: string | { id: string; name: string };
};
const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
	`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "actual-test", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: USAGE } : {}) })}\n\n`;
/** What a provider has put on the wire before its answer is finished. */
function openingChunks(turn: Turn): string[] {
	return [
		...(turn.reasoning ? [chunk({ reasoning_content: turn.reasoning })] : []),
		...(turn.text ? [chunk({ content: turn.text })] : []),
		...(turn.call
			? [chunk({ tool_calls: [{ index: 0, ...toolCall(turn.call) }] })]
			: []),
	];
}
/** A whole, well-formed reply of one step. */
export function respond(transport: Transport, turn: Turn): Response {
	if (transport === "plain")
		return new Response(
			JSON.stringify({
				id: "r",
				object: "chat.completion",
				created: 1,
				model: "actual-test",
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: turn.text ?? "",
							...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
							...(turn.call ? { tool_calls: [toolCall(turn.call)] } : {}),
						},
						finish_reason: turn.call ? "tool_calls" : "stop",
					},
				],
				usage: USAGE,
			}),
			{ headers: { "content-type": "application/json" } },
		);
	return new Response(
		[
			...openingChunks(turn),
			chunk({}, turn.call ? "tool_calls" : "stop"),
			"data: [DONE]\n\n",
		].join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
export const httpFailure = (status: number) =>
	new Response(
		JSON.stringify({
			error: { message: "upstream failure", type: "server_error" },
		}),
		{ status, headers: { "content-type": "application/json" } },
	);

export type Ctx = {
	transport: Transport;
	body: Record<string, unknown>;
	signal: AbortSignal | undefined;
};
export type Responder = (ctx: Ctx) => Response | Promise<Response>;
/** Nothing arrives until the caller gives up on the request. */
export const hang: Responder = ({ signal }) =>
	new Promise<Response>((_, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		signal?.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
/** The provider is alive but silent for `ms` before it answers; the caller giving up cuts it. */
export const answerAfter =
	(ms: number, turn: Turn): Responder =>
	({ transport, signal }) =>
		new Promise<Response>((resolve, reject) => {
			const timer = setTimeout(() => resolve(respond(transport, turn)), ms);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(signal.reason);
				},
				{ once: true },
			);
		});
export const failWith =
	(error: () => Error): Responder =>
	() => {
		throw error();
	};
/** A stream that is cut once the test says so, after the engine has seen what came first. */
export function dyingWire(turn: Turn) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
				for (const part of openingChunks(turn)) c.enqueue(encoder.encode(part));
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
	return { response, die: () => controller.error(timeoutError()) };
}

export type Message = {
	role: string;
	content?: unknown;
	reasoning_content?: string;
	tool_calls?: Array<{ id: string }>;
	tool_call_id?: string;
};
export const messagesOf = (body: Record<string, unknown>) =>
	body.messages as Message[];

export function fakeNetwork(transport: Transport) {
	const scripts = new Map<string, Responder[]>();
	const calls: Array<{
		host: string;
		body: Record<string, unknown>;
		text: string;
	}> = [];
	return {
		calls,
		to: (host: string) => calls.filter((c) => c.host === host),
		script(host: string, ...responders: Responder[]) {
			scripts.set(host, [...(scripts.get(host) ?? []), ...responders]);
		},
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const host = new URL(String(input)).host;
			const text = String(init?.body ?? "");
			const body = JSON.parse(text) as Record<string, unknown>;
			calls.push({ host, body, text });
			const responder = scripts.get(host)?.shift();
			if (!responder) throw new Error(`unscripted request to ${host}`);
			return responder({
				transport,
				body,
				signal: init?.signal ?? undefined,
			});
		}) as typeof fetch,
	};
}

/** A provider row as `getProviderWithSecrets` returns it, on a `.invalid` host. */
export const providerRecord = (id: string, host: string) => ({
	id,
	name: `${id}-provider`,
	displayName: id,
	baseUrl: `https://${host}/v1`,
	enabled: true,
	apiKeyEncrypted: "x",
	apiKeyIv: "y",
	iconAssetId: null,
});
/** A provider-model row as `getProviderModel` returns it. */
export const modelRow = (
	id: string,
	providerId: string,
	extra: Record<string, unknown> = {},
) => ({
	id,
	providerId,
	name: id,
	displayName: id,
	enabled: true,
	maxModelContext: 32000,
	maxTokens: 1000,
	reasoningEffort: null,
	thinkingType: null,
	capabilitiesJson: "{}",
	fallbackProviderModelId: null,
	...extra,
});
