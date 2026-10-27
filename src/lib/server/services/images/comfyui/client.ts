/**
 * The ComfyUI client: plain fetch plus one WebSocket per client, nothing else.
 *
 * It speaks only the routes the picture pipeline needs (/upload/image,
 * /prompt, /queue, /history/{id}, /view, /interrupt, /free). The base URL is
 * the operator's COMFYUI_URL; nothing a model writes ever becomes an address.
 * The socket only adds progress events; polling decides every outcome.
 */

import { randomUUID } from "node:crypto";
import { type ComfyImageRef, type ComfyUiClient, ComfyUiError } from "./types";

export {
	type ComfyCancelResult,
	type ComfyEvent,
	type ComfyGraph,
	type ComfyImageRef,
	type ComfyUiClient,
	ComfyUiError,
	type ComfyUiErrorCode,
} from "./types";

const SOCKET_OPEN_WAIT_MS = 1000;
const BACKLOG_PROMPTS = 50;
const BACKLOG_MESSAGES = 200;

type SocketMessage = { type: string; data: Record<string, unknown> };
type QueueEntry = { number: number; promptId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageRef(value: unknown): value is ComfyImageRef {
	return (
		isRecord(value) &&
		typeof value.filename === "string" &&
		typeof value.subfolder === "string" &&
		(value.type === "input" || value.type === "output" || value.type === "temp")
	);
}

function parseQueueList(value: unknown): QueueEntry[] {
	if (!Array.isArray(value)) {
		throw new ComfyUiError("bad_response", "queue list is not an array");
	}
	return value.map((entry) => {
		if (
			!Array.isArray(entry) ||
			typeof entry[0] !== "number" ||
			typeof entry[1] !== "string"
		) {
			throw new ComfyUiError("bad_response", "queue entry has the wrong shape");
		}
		return { number: entry[0], promptId: entry[1] };
	});
}

export function createComfyUiClient(options: {
	baseUrl: string;
	fetchImpl?: typeof fetch;
	webSocketImpl?: typeof WebSocket;
	pollMs?: number;
	requestTimeoutMs?: number;
}): ComfyUiClient {
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? fetch;
	const pollMs = options.pollMs ?? 1000;
	const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
	const clientId = randomUUID();

	let socket: WebSocket | null = null;
	let socketOpening: Promise<void> | null = null;
	const listeners = new Map<string, (message: SocketMessage) => void>();
	const backlog = new Map<string, SocketMessage[]>();

	function onSocketMessage(raw: unknown): void {
		if (typeof raw !== "string") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		if (
			!isRecord(parsed) ||
			typeof parsed.type !== "string" ||
			!isRecord(parsed.data)
		) {
			return;
		}
		const promptId = parsed.data.prompt_id;
		if (typeof promptId !== "string") return;
		const message = { type: parsed.type, data: parsed.data };
		const listener = listeners.get(promptId);
		if (listener) {
			listener(message);
			return;
		}
		let list = backlog.get(promptId);
		if (!list) {
			if (backlog.size >= BACKLOG_PROMPTS) {
				const oldest = backlog.keys().next().value;
				if (oldest !== undefined) backlog.delete(oldest);
			}
			list = [];
			backlog.set(promptId, list);
		}
		if (list.length < BACKLOG_MESSAGES) list.push(message);
	}

	function ensureSocket(): Promise<void> {
		if (socket) return Promise.resolve();
		if (socketOpening) return socketOpening;
		const Impl = options.webSocketImpl ?? globalThis.WebSocket;
		const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws?clientId=${clientId}`;
		socketOpening = new Promise<void>((resolve) => {
			let ws: WebSocket;
			try {
				ws = new Impl(wsUrl);
			} catch {
				resolve();
				return;
			}
			const timer = setTimeout(() => {
				if (!socket) {
					try {
						ws.close();
					} catch {
						// already closed
					}
				}
				resolve();
			}, SOCKET_OPEN_WAIT_MS);
			ws.addEventListener("open", () => {
				clearTimeout(timer);
				socket = ws;
				resolve();
			});
			ws.addEventListener("message", (event) => onSocketMessage(event.data));
			const lost = () => {
				clearTimeout(timer);
				if (socket === ws) socket = null;
				resolve();
			};
			ws.addEventListener("close", lost);
			ws.addEventListener("error", lost);
		}).finally(() => {
			socketOpening = null;
		});
		return socketOpening;
	}

	async function request(
		path: string,
		init: RequestInit = {},
		signal?: AbortSignal,
	): Promise<Response> {
		const timeout = AbortSignal.timeout(requestTimeoutMs);
		try {
			return await fetchImpl(`${baseUrl}${path}`, {
				...init,
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new ComfyUiError(
				"unreachable",
				`ComfyUI did not answer ${path}`,
				error instanceof Error ? error.message : undefined,
			);
		}
	}

	async function readJson(response: Response, path: string): Promise<unknown> {
		try {
			return await response.json();
		} catch {
			throw new ComfyUiError("bad_response", `${path} did not return JSON`);
		}
	}

	async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
		const response = await request(path, {}, signal);
		if (!response.ok) {
			throw new ComfyUiError(
				"bad_response",
				`${path} answered ${response.status}`,
			);
		}
		return readJson(response, path);
	}

	async function readQueue(signal?: AbortSignal): Promise<{
		running: QueueEntry[];
		pending: QueueEntry[];
	}> {
		const body = await getJson("/queue", signal);
		if (!isRecord(body)) {
			throw new ComfyUiError("bad_response", "/queue is not an object");
		}
		return {
			running: parseQueueList(body.queue_running),
			pending: parseQueueList(body.queue_pending),
		};
	}

	function aheadOf(
		queue: { running: QueueEntry[]; pending: QueueEntry[] },
		promptId: string,
	): number | null {
		const all = [...queue.running, ...queue.pending];
		const ours = all.find((entry) => entry.promptId === promptId);
		if (!ours) return null;
		return all.filter((entry) => entry.number < ours.number).length;
	}

	type HistoryState =
		| { state: "unknown" }
		| { state: "failed"; detail: unknown }
		| { state: "done"; images: ComfyImageRef[] };

	async function readHistory(
		promptId: string,
		signal?: AbortSignal,
	): Promise<HistoryState> {
		const path = `/history/${encodeURIComponent(promptId)}`;
		const body = await getJson(path, signal);
		if (!isRecord(body)) {
			throw new ComfyUiError("bad_response", "history is not an object");
		}
		const entry = body[promptId];
		if (entry === undefined) return { state: "unknown" };
		if (!isRecord(entry)) {
			throw new ComfyUiError("bad_response", "history entry is not an object");
		}
		const status = isRecord(entry.status) ? entry.status : null;
		if (status?.status_str === "error") {
			return { state: "failed", detail: status.messages };
		}
		if (!isRecord(entry.outputs)) return { state: "unknown" };
		const images: ComfyImageRef[] = [];
		for (const node of Object.values(entry.outputs)) {
			if (isRecord(node) && Array.isArray(node.images)) {
				for (const image of node.images) {
					if (isImageRef(image)) {
						images.push({
							filename: image.filename,
							subfolder: image.subfolder,
							type: image.type,
						});
					}
				}
			}
		}
		return { state: "done", images };
	}

	return {
		async uploadImage(bytes, name) {
			const form = new FormData();
			form.set("image", new Blob([new Uint8Array(bytes)]), name);
			form.set("type", "input");
			form.set("overwrite", "true");
			const response = await request("/upload/image", {
				method: "POST",
				body: form,
			});
			if (!response.ok) {
				throw new ComfyUiError(
					"bad_response",
					`/upload/image answered ${response.status}`,
				);
			}
			const body = await readJson(response, "/upload/image");
			if (!isRecord(body) || typeof body.name !== "string") {
				throw new ComfyUiError("bad_response", "upload answer has no name");
			}
			return {
				filename: body.name,
				subfolder: typeof body.subfolder === "string" ? body.subfolder : "",
				type: "input",
			};
		},

		async submit(graph) {
			await ensureSocket();
			const response = await request("/prompt", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt: graph, client_id: clientId }),
			});
			if (response.status === 400) {
				const body = await readJson(response, "/prompt").catch(() => null);
				throw new ComfyUiError(
					"rejected",
					"ComfyUI refused the graph",
					isRecord(body) ? (body.node_errors ?? body.error) : undefined,
				);
			}
			if (!response.ok) {
				throw new ComfyUiError(
					"bad_response",
					`/prompt answered ${response.status}`,
				);
			}
			const body = await readJson(response, "/prompt");
			if (!isRecord(body) || typeof body.prompt_id !== "string") {
				throw new ComfyUiError("bad_response", "/prompt answer has no id");
			}
			return { promptId: body.prompt_id };
		},

		async follow(promptId, { signal, deadlineMs, onEvent }) {
			const deadline = Date.now() + deadlineMs;
			let queuedAhead: number | null = null;
			let started = false;
			let socketFailure: ComfyUiError | null = null;
			// Ends the poll pause early. A finished or failed render says so on the
			// socket, so the follower looks at the history at once instead of
			// sitting out the rest of its poll interval.
			let wakePoll: (() => void) | null = null;
			// A wake that lands while the loop is reading the queue or history (no
			// pause to end) is kept, so the next pause returns at once.
			let woken = false;

			const emitQueued = (ahead: number) => {
				if (queuedAhead === ahead) return;
				if (started) return;
				queuedAhead = ahead;
				onEvent({ type: "queued", ahead });
			};
			const emitStarted = () => {
				if (started) return;
				emitQueued(0);
				started = true;
				onEvent({ type: "started" });
			};
			const handle = (message: SocketMessage) => {
				if (
					message.type === "execution_success" ||
					message.type === "execution_error" ||
					message.type === "execution_interrupted" ||
					(message.type === "executing" && message.data.node === null)
				) {
					woken = true;
					wakePoll?.();
				}
				if (message.type === "execution_start") emitStarted();
				else if (message.type === "progress") {
					const { value, max } = message.data;
					if (typeof value === "number" && typeof max === "number") {
						emitStarted();
						onEvent({ type: "progress", value, max });
					}
				} else if (
					message.type === "execution_error" ||
					message.type === "execution_interrupted"
				) {
					socketFailure = new ComfyUiError(
						"execution_failed",
						`ComfyUI reported ${message.type}`,
						message.data,
					);
				}
			};

			// The first poll goes before any socket message so "queued" leads.
			const wait = (ms: number) =>
				new Promise<void>((resolve, reject) => {
					if (woken) {
						woken = false;
						resolve();
						return;
					}
					const finish = () => {
						woken = false;
						clearTimeout(timer);
						wakePoll = null;
						signal.removeEventListener("abort", onAbort);
						resolve();
					};
					const onAbort = () => {
						clearTimeout(timer);
						wakePoll = null;
						reject(signal.reason);
					};
					const timer = setTimeout(finish, ms);
					wakePoll = finish;
					signal.addEventListener("abort", onAbort, { once: true });
				});

			try {
				let misses = 0;
				let first = true;
				while (true) {
					signal.throwIfAborted();
					if (Date.now() >= deadline) {
						throw new ComfyUiError("timeout", "ComfyUI took too long");
					}
					const queue = await readQueue(signal);
					const ahead = aheadOf(queue, promptId);
					if (ahead !== null) {
						misses = 0;
						if (queue.running.some((e) => e.promptId === promptId)) {
							emitQueued(0);
							emitStarted();
						} else {
							emitQueued(ahead);
						}
					}
					if (first) {
						first = false;
						listeners.set(promptId, handle);
						for (const message of backlog.get(promptId) ?? []) handle(message);
						backlog.delete(promptId);
					}
					if (socketFailure) throw socketFailure;
					const history = await readHistory(promptId, signal);
					if (history.state === "failed") {
						throw new ComfyUiError(
							"execution_failed",
							"ComfyUI could not render the picture",
							history.detail,
						);
					}
					if (history.state === "done") {
						if (history.images.length === 0) {
							throw new ComfyUiError(
								"missing_result",
								"ComfyUI finished without a picture",
							);
						}
						emitStarted();
						onEvent({ type: "done", images: history.images });
						return history.images;
					}
					if (ahead === null) {
						misses += 1;
						if (misses >= 2) {
							throw new ComfyUiError(
								"missing_result",
								"ComfyUI no longer knows this prompt",
							);
						}
					}
					await wait(Math.max(0, Math.min(pollMs, deadline - Date.now())));
				}
			} finally {
				listeners.delete(promptId);
				backlog.delete(promptId);
			}
		},

		async fetchImage(ref) {
			const query = new URLSearchParams({
				filename: ref.filename,
				subfolder: ref.subfolder,
				type: ref.type,
			});
			const response = await request(`/view?${query.toString()}`);
			if (!response.ok) {
				throw new ComfyUiError(
					"bad_response",
					`/view answered ${response.status}`,
				);
			}
			return new Uint8Array(await response.arrayBuffer());
		},

		async cancel(promptId, { interrupt }) {
			const queue = await readQueue();
			if (queue.pending.some((entry) => entry.promptId === promptId)) {
				const response = await request("/queue", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ delete: [promptId] }),
				});
				if (!response.ok) {
					throw new ComfyUiError(
						"bad_response",
						`/queue answered ${response.status}`,
					);
				}
				return "deleted";
			}
			if (queue.running.some((entry) => entry.promptId === promptId)) {
				if (!interrupt) return "running";
				const response = await request("/interrupt", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ prompt_id: promptId }),
				});
				if (!response.ok) {
					throw new ComfyUiError(
						"bad_response",
						`/interrupt answered ${response.status}`,
					);
				}
				return "interrupted";
			}
			return "not_found";
		},

		async queueSize() {
			const queue = await readQueue();
			return queue.running.length + queue.pending.length;
		},

		async free() {
			const response = await request("/free", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ unload_models: true, free_memory: true }),
			});
			if (!response.ok) {
				throw new ComfyUiError(
					"bad_response",
					`/free answered ${response.status}`,
				);
			}
		},

		close() {
			const ws = socket;
			socket = null;
			listeners.clear();
			backlog.clear();
			try {
				ws?.close();
			} catch {
				// already closed
			}
		},
	};
}
