/**
 * A fake ComfyUI on a real loopback HTTP + WebSocket server. Node built-ins
 * and sharp only, so Playwright specs can import it by relative path.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import sharp from "sharp";
import type { ComfyGraph } from "../types";

export type FakeRenderInput = {
	graph: ComfyGraph;
	images: Uint8Array[];
	seed: number;
	width: number;
	height: number;
};

export type FakeComfyUiOptions = {
	steps?: number;
	stepDelayMs?: number;
	startDelayMs?: number;
	fail?: "reject" | "execution";
	render?: (input: FakeRenderInput) => Promise<Uint8Array>;
};

export type FakeRequest = {
	method: string;
	path: string;
	json?: unknown;
	/** Text fields of a multipart body. */
	fields?: Record<string, string>;
};

export type FakePromptStatus = "pending" | "running" | "done" | "failed";

export interface FakeComfyUi {
	readonly baseUrl: string;
	readonly requests: FakeRequest[];
	readonly prompts: Map<string, FakePromptStatus>;
	readonly uploads: Map<string, Uint8Array>;
	setOptions(next: FakeComfyUiOptions): void;
	holdQueue(held: boolean): void;
	restart(): void;
	close(): Promise<void>;
}

type Prompt = {
	id: string;
	number: number;
	graph: ComfyGraph;
	clientId: string;
	status: FakePromptStatus;
	aborted: boolean;
};

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function textFrame(text: string): Buffer {
	const payload = Buffer.from(text);
	const length = payload.length;
	let header: Buffer;
	if (length < 126) header = Buffer.from([0x81, length]);
	else if (length < 65_536) {
		header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
}

function parseMultipart(
	body: Buffer,
	contentType: string,
): {
	fields: Record<string, string>;
	files: { name: string; filename: string; bytes: Buffer }[];
} {
	const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
	const fields: Record<string, string> = {};
	const files: { name: string; filename: string; bytes: Buffer }[] = [];
	if (!boundary) return { fields, files };
	const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
	let position = body.indexOf(delimiter);
	while (position !== -1) {
		const start = position + delimiter.length;
		if (body.subarray(start, start + 2).toString() === "--") break;
		const next = body.indexOf(delimiter, start);
		if (next === -1) break;
		const part = body.subarray(start + 2, next - 2);
		const split = part.indexOf("\r\n\r\n");
		if (split !== -1) {
			const head = part.subarray(0, split).toString();
			const content = part.subarray(split + 4);
			const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
			const filename = /filename="([^"]*)"/.exec(head)?.[1];
			if (filename !== undefined)
				files.push({ name, filename, bytes: content });
			else fields[name] = content.toString();
		}
		position = next;
	}
	return { fields, files };
}

function findNumber(graph: ComfyGraph, keys: string[], fallback: number) {
	for (const node of Object.values(graph)) {
		for (const key of keys) {
			const value = node.inputs?.[key];
			if (typeof value === "number") return value;
		}
	}
	return fallback;
}

function seedColor(seed: number): [number, number, number] {
	return [
		(seed * 53 + 40) % 256,
		(seed * 97 + 90) % 256,
		(seed * 29 + 160) % 256,
	];
}

async function defaultRender(input: FakeRenderInput): Promise<Uint8Array> {
	const [r, g, b] = seedColor(input.seed);
	const first = input.images[0];
	if (first) {
		const { data, info } = await sharp(first)
			.removeAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		const side = Math.max(
			1,
			Math.floor(Math.min(info.width, info.height) * 0.2),
		);
		const x0 = Math.floor((info.width - side) / 2);
		const y0 = Math.floor((info.height - side) / 2);
		for (let y = y0; y < y0 + side; y++) {
			for (let x = x0; x < x0 + side; x++) {
				const at = (y * info.width + x) * 3;
				data[at] = r;
				data[at + 1] = g;
				data[at + 2] = b;
			}
		}
		return sharp(data, {
			raw: { width: info.width, height: info.height, channels: 3 },
		})
			.png()
			.toBuffer();
	}
	const { width, height } = input;
	const data = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 3;
			const t = x / Math.max(1, width - 1);
			data[at] = Math.round(r * (1 - t) + 255 * t * 0.5);
			data[at + 1] = Math.round(g * (1 - y / Math.max(1, height - 1)));
			data[at + 2] = b;
		}
	}
	return sharp(data, { raw: { width, height, channels: 3 } })
		.png()
		.toBuffer();
}

export async function createFakeComfyUi(
	initial: FakeComfyUiOptions = {},
): Promise<FakeComfyUi> {
	let options: FakeComfyUiOptions = { ...initial };
	let held = false;
	let counter = 0;
	let generation = 0;
	let current: Prompt | null = null;
	const requests: FakeRequest[] = [];
	const prompts = new Map<string, FakePromptStatus>();
	const records = new Map<string, Prompt>();
	const uploads = new Map<string, Uint8Array>();
	const history = new Map<string, unknown>();
	const files = new Map<string, Uint8Array>();
	const sockets = new Map<Duplex, string>();

	function send(clientId: string, type: string, data: Record<string, unknown>) {
		const frame = textFrame(JSON.stringify({ type, data }));
		for (const [socket, id] of sockets) {
			if (id === clientId && !socket.destroyed) socket.write(frame);
		}
	}

	function queueBody() {
		const entry = (p: Prompt) => [p.number, p.id, p.graph, {}, []];
		const all = [...records.values()].sort((a, b) => a.number - b.number);
		return {
			queue_running: all.filter((p) => p.status === "running").map(entry),
			queue_pending: all.filter((p) => p.status === "pending").map(entry),
		};
	}

	async function run(prompt: Prompt, gen: number) {
		const alive = () => gen === generation && !prompt.aborted;
		const steps = options.steps ?? 4;
		await sleep(options.startDelayMs ?? 0);
		let failed = false;
		if (alive()) {
			send(prompt.clientId, "execution_start", { prompt_id: prompt.id });
			for (let step = 1; step <= steps && alive(); step++) {
				await sleep(options.stepDelayMs ?? 5);
				if (!alive()) break;
				send(prompt.clientId, "progress", {
					prompt_id: prompt.id,
					node: "3",
					value: step,
					max: steps,
				});
			}
		}
		if (gen !== generation) return;
		if (prompt.aborted) {
			failed = true;
			send(prompt.clientId, "execution_interrupted", { prompt_id: prompt.id });
		} else if (options.fail === "execution") {
			failed = true;
			send(prompt.clientId, "execution_error", {
				prompt_id: prompt.id,
				exception_message: "fake failure",
			});
		}
		if (failed) {
			history.set(prompt.id, {
				outputs: {},
				status: { status_str: "error", completed: false, messages: [] },
			});
		} else {
			const inputs: Uint8Array[] = [];
			for (const node of Object.values(prompt.graph)) {
				const name = node.inputs?.image;
				if (node.class_type === "LoadImage" && typeof name === "string") {
					const bytes = uploads.get(name);
					if (bytes) inputs.push(bytes);
				}
			}
			const render = options.render ?? defaultRender;
			const png = await render({
				graph: prompt.graph,
				images: inputs,
				seed: findNumber(prompt.graph, ["seed", "noise_seed"], 0),
				width: findNumber(prompt.graph, ["width"], 1248),
				height: findNumber(prompt.graph, ["height"], 832),
			});
			if (gen !== generation) return;
			const filename = `fake_${prompt.id}.png`;
			files.set(`temp/${filename}`, png);
			history.set(prompt.id, {
				outputs: {
					"9": { images: [{ filename, subfolder: "", type: "temp" }] },
				},
				status: { status_str: "success", completed: true, messages: [] },
			});
			send(prompt.clientId, "execution_success", { prompt_id: prompt.id });
		}
		prompt.status = failed ? "failed" : "done";
		prompts.set(prompt.id, prompt.status);
		records.delete(prompt.id);
		current = null;
		pump();
	}

	function pump() {
		if (current || held) return;
		const next = [...records.values()]
			.filter((p) => p.status === "pending")
			.sort((a, b) => a.number - b.number)[0];
		if (!next) return;
		next.status = "running";
		prompts.set(next.id, "running");
		current = next;
		run(next, generation).catch(() => {
			if (current === next) current = null;
		});
	}

	async function readBody(req: IncomingMessage): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks);
	}

	function reply(res: ServerResponse, status: number, body: unknown) {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	}

	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://fake");
		const path = url.pathname;
		const method = req.method ?? "GET";
		const body = await readBody(req).catch(() => null);
		if (!body) return;
		const contentType = req.headers["content-type"] ?? "";
		try {
			if (method === "POST" && path === "/upload/image") {
				const form = parseMultipart(body, contentType);
				requests.push({ method, path, fields: form.fields });
				const file = form.files[0];
				if (!file) return reply(res, 400, { error: "no image" });
				uploads.set(file.filename, new Uint8Array(file.bytes));
				return reply(res, 200, {
					name: file.filename,
					subfolder: form.fields.subfolder ?? "",
					type: form.fields.type ?? "input",
				});
			}
			const json =
				body.length && contentType.includes("json")
					? JSON.parse(body.toString())
					: undefined;
			requests.push({ method, path, ...(json === undefined ? {} : { json }) });
			if (method === "POST" && path === "/prompt") {
				if (options.fail === "reject") {
					return reply(res, 400, {
						error: {
							type: "prompt_outputs_failed_validation",
							message: "rejected",
						},
						node_errors: { "3": { errors: [{ type: "fake_rejection" }] } },
					});
				}
				const id = randomUUID();
				const prompt: Prompt = {
					id,
					number: counter++,
					graph: json.prompt,
					clientId: String(json.client_id ?? ""),
					status: "pending",
					aborted: false,
				};
				records.set(id, prompt);
				prompts.set(id, "pending");
				reply(res, 200, {
					prompt_id: id,
					number: prompt.number,
					node_errors: {},
				});
				pump();
				return;
			}
			if (method === "GET" && path === "/queue") {
				return reply(res, 200, queueBody());
			}
			if (method === "POST" && path === "/queue") {
				for (const id of (json?.delete as string[] | undefined) ?? []) {
					const prompt = records.get(id);
					if (prompt?.status === "pending") {
						records.delete(id);
						prompts.delete(id);
					}
				}
				return reply(res, 200, {});
			}
			if (method === "POST" && path === "/interrupt") {
				if (current && (!json?.prompt_id || json.prompt_id === current.id)) {
					current.aborted = true;
				}
				return reply(res, 200, {});
			}
			if (method === "POST" && path === "/free") return reply(res, 200, {});
			if (method === "GET" && path === "/system_stats") {
				return reply(res, 200, { system: { os: "fake" }, devices: [] });
			}
			if (method === "GET" && path.startsWith("/history/")) {
				const id = decodeURIComponent(path.slice("/history/".length));
				const entry = history.get(id);
				return reply(res, 200, entry === undefined ? {} : { [id]: entry });
			}
			if (method === "GET" && path === "/view") {
				const type = url.searchParams.get("type") ?? "output";
				const name = url.searchParams.get("filename") ?? "";
				const bytes =
					type === "input" ? uploads.get(name) : files.get(`${type}/${name}`);
				if (!bytes) return reply(res, 404, { error: "not found" });
				res.writeHead(200, { "content-type": "image/png" });
				return void res.end(Buffer.from(bytes));
			}
			reply(res, 404, { error: "no such route" });
		} catch (error) {
			reply(res, 500, { error: String(error) });
		}
	});

	server.on("upgrade", (req, socket) => {
		const key = req.headers["sec-websocket-key"];
		const url = new URL(req.url ?? "/", "http://fake");
		if (url.pathname !== "/ws" || typeof key !== "string") {
			socket.destroy();
			return;
		}
		const accept = createHash("sha1")
			.update(key + WS_GUID)
			.digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		sockets.set(socket, url.searchParams.get("clientId") ?? "");
		socket.on("data", (data) => {
			if (data.length > 0 && (data[0] & 0x0f) === 0x8) {
				socket.end(Buffer.from([0x88, 0x00]));
			}
		});
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => sockets.delete(socket));
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		prompts,
		uploads,
		setOptions(next) {
			options = { ...options, ...next };
		},
		holdQueue(value) {
			held = value;
			if (!held) pump();
		},
		restart() {
			generation += 1;
			current = null;
			records.clear();
			prompts.clear();
			history.clear();
			files.clear();
		},
		async close() {
			generation += 1;
			for (const socket of sockets.keys()) socket.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
