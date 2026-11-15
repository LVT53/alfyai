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

/**
 * A real 5 s 24 fps 64x64 h264 mp4, made once with
 * `ffmpeg -f lavfi -i color=c=#336699:s=64x64:d=5:r=24 -c:v libx264
 * -pix_fmt yuv420p -preset veryfast -crf 30 -movflags +faststart`.
 * It is what a video graph answers by default, so the fake serves a clip the
 * runner can decode, chain and sample with ffmpeg without a GPU. A spec or a
 * test that needs another picture in the clip passes `videoBytes`.
 */
export const FAKE_VIDEO_BYTES = new Uint8Array(
	Buffer.from(
		"AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAjQbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAE4gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAB/t0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAE4gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAABOIAAAEAAABAAAAAAdzbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAA8ABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAHHm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAABt5zdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMiBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQAAAMABAAAAwDAPEiWWAEABWjvhHLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAA47AAAAAAAAABhzdHRzAAAAAAAAAAEAAAB4AAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAADyGN0dHMAAAAAAAAAdwAAAAEAAAQAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAKAAAAAAEAAAQAAAAAAQAAAAAAAAABAAACAAAAAAEAAAgAAAAAAgAAAgAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAHgAAAABAAAB9HN0c3oAAAAAAAAAAAAAAHgAAALcAAAADQAAAAwAAAAMAAAADAAAAA4AAAAOAAAADAAAAAwAAAAOAAAADgAAAAwAAAAMAAAADgAAAA4AAAAMAAAADAAAAA4AAAAOAAAADAAAAAwAAAAOAAAADgAAAAwAAAAMAAAADgAAAA4A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",
		"base64",
	),
);

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
	/** Answers `POST /prompt` with an id of its own, ignoring a caller's `prompt_id` (a ComfyUI from before caller-supplied ids). */
	ignorePromptId?: boolean;
	render?: (input: FakeRenderInput) => Promise<Uint8Array>;
	/** The mp4 a video graph (`SaveVideo`) answers with; defaults to `FAKE_VIDEO_BYTES`. */
	videoBytes?: Uint8Array;
	/**
	 * Which history key a video graph's saved clip lands under. ComfyUI's own
	 * `SaveVideo` reports it under `images` with an `animated` marker; some
	 * custom nodes use `videos` or `gifs`. Default `images`.
	 */
	videoOutputKey?: "images" | "videos" | "gifs";
	/** Execution fails for every prompt after the first N (a chain's second segment). */
	failAfterPromptCount?: number;
	/**
	 * The exact progress series to send (one event per entry, `stepDelayMs`
	 * apart) instead of the default `steps` count. A smaller `max` part-way
	 * through is a node/pass reset, which the ETA must survive.
	 */
	progressPlan?: Array<{ value: number; max: number }>;
	/**
	 * Prompts after the first N render their steps and then never finish, so a
	 * test can read the state of a take that is mid-segment. `releaseHanging()`
	 * lets them finish, like a ComfyUI that keeps rendering after the app died.
	 */
	hangAfterPromptCount?: number;
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
	/** Parks every request to `path` (`/upload/image`, `/prompt`) after it is recorded in `requests`, before it is acted on, until released. */
	holdRequests(path: string, held: boolean): void;
	/** Finishes every prompt parked by `hangAfterPromptCount`. */
	releaseHanging(): void;
	restart(): void;
	/** Goes dark for `ms` (every connection is cut), then comes back having forgotten its prompts and results, like a real reload. */
	outage(ms: number): void;
	close(): Promise<void>;
}

type Prompt = {
	id: string;
	number: number;
	graph: ComfyGraph;
	clientId: string;
	status: FakePromptStatus;
	aborted: boolean;
	/** This prompt was submitted over `failAfterPromptCount`. */
	shouldFail: boolean;
	/** This prompt was submitted over `hangAfterPromptCount` and parks before finishing. */
	hangs: boolean;
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
	// A transparent graph is the plain one with the prompt wrapped (templates.ts,
	// wrapTransparentPrompt): the model is asked for an RGBA picture, so the fake
	// answers with one: four channels, the right part of it fully see-through.
	const channels = wantsTransparency(input.graph) ? 4 : 3;
	const data = Buffer.alloc(width * height * channels);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * channels;
			const t = x / Math.max(1, width - 1);
			data[at] = Math.round(r * (1 - t) + 255 * t * 0.5);
			data[at + 1] = Math.round(g * (1 - y / Math.max(1, height - 1)));
			data[at + 2] = b;
			if (channels === 4) data[at + 3] = t >= 0.6 ? 0 : 255;
		}
	}
	return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

/** True when any text input of the graph is the transparent route's wrapped prompt. */
function wantsTransparency(graph: ComfyGraph): boolean {
	return Object.values(graph).some((node) =>
		Object.values(node.inputs ?? {}).some(
			(value) =>
				typeof value === "string" &&
				value.startsWith("This is an RGBA format image with transparency."),
		),
	);
}

export async function createFakeComfyUi(
	initial: FakeComfyUiOptions = {},
): Promise<FakeComfyUi> {
	let options: FakeComfyUiOptions = { ...initial };
	let held = false;
	let counter = 0;
	let submitted = 0;
	let generation = 0;
	let downUntil = 0;
	let current: Prompt | null = null;
	const requests: FakeRequest[] = [];
	const prompts = new Map<string, FakePromptStatus>();
	const records = new Map<string, Prompt>();
	const uploads = new Map<string, Uint8Array>();
	const history = new Map<string, unknown>();
	const files = new Map<string, Uint8Array>();
	const sockets = new Map<Duplex, string>();
	const parked = new Map<string, (() => void)[]>();
	const hangResolvers = new Set<() => void>();
	// Sticky: `releaseHanging()` may be called before a prompt reaches its park
	// point (a test releases the moment the prompt is posted), and every later
	// park must then go straight through.
	let hangsReleased = false;

	/** Resolves at once unless `path` is held, else when it is released. */
	function gate(path: string): Promise<void> {
		const waiting = parked.get(path);
		if (!waiting) return Promise.resolve();
		return new Promise((resolve) => waiting.push(resolve));
	}

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
		const isVideo = Object.values(prompt.graph).some(
			(node) => node.class_type === "SaveVideo",
		);
		await sleep(options.startDelayMs ?? 0);
		let failed = false;
		if (alive()) {
			send(prompt.clientId, "execution_start", { prompt_id: prompt.id });
			const plan = options.progressPlan;
			if (plan && plan.length > 0) {
				for (const event of plan) {
					if (!alive()) break;
					await sleep(options.stepDelayMs ?? 5);
					if (!alive()) break;
					send(prompt.clientId, "progress", {
						prompt_id: prompt.id,
						node: "3",
						value: event.value,
						max: event.max,
					});
				}
			} else {
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
		}
		if (gen !== generation) return;
		if (prompt.hangs && !hangsReleased) {
			await new Promise<void>((resolve) => {
				hangResolvers.add(resolve);
			});
			if (gen !== generation) return;
		}
		if (prompt.aborted) {
			failed = true;
			send(prompt.clientId, "execution_interrupted", { prompt_id: prompt.id });
		} else if (prompt.shouldFail || options.fail === "execution") {
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
		} else if (isVideo) {
			const bytes = options.videoBytes ?? FAKE_VIDEO_BYTES;
			const filename = `fake_${prompt.id}.mp4`;
			files.set(`output/${filename}`, bytes);
			const outputKey = options.videoOutputKey ?? "images";
			const outputId =
				Object.entries(prompt.graph).find(
					([, node]) => node.class_type === "SaveVideo",
				)?.[0] ?? "33";
			history.set(prompt.id, {
				outputs: {
					[outputId]: {
						[outputKey]: [
							{ filename, subfolder: "", type: "output", animated: [true] },
						],
					},
				},
				status: { status_str: "success", completed: true, messages: [] },
			});
			send(prompt.clientId, "execution_success", { prompt_id: prompt.id });
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

	function releaseHanging() {
		hangsReleased = true;
		for (const resolve of hangResolvers) resolve();
		hangResolvers.clear();
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
		if (Date.now() < downUntil) {
			req.destroy();
			return;
		}
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
				await gate(path);
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
				await gate(path);
				if (options.fail === "reject") {
					return reply(res, 400, {
						error: {
							type: "prompt_outputs_failed_validation",
							message: "rejected",
						},
						node_errors: { "3": { errors: [{ type: "fake_rejection" }] } },
					});
				}
				// ComfyUI takes the caller's prompt_id when it sends one.
				const id =
					!options.ignorePromptId &&
					typeof json?.prompt_id === "string" &&
					json.prompt_id !== ""
						? json.prompt_id
						: randomUUID();
				submitted += 1;
				const prompt: Prompt = {
					id,
					number: counter++,
					graph: json.prompt,
					clientId: String(json.client_id ?? ""),
					status: "pending",
					aborted: false,
					shouldFail:
						options.failAfterPromptCount !== undefined &&
						submitted > options.failAfterPromptCount,
					hangs:
						options.hangAfterPromptCount !== undefined &&
						submitted > options.hangAfterPromptCount,
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
			if (method === "POST" && path === "/free") {
				// Held like the other requests a spec may need parked: the
				// cross-model free has to happen before the take's own prompt.
				await gate(path);
				return reply(res, 200, {});
			}
			if (method === "GET" && path === "/system_stats") {
				return reply(res, 200, { system: { os: "fake" }, devices: [] });
			}
			if (method === "GET" && path.startsWith("/history/")) {
				const id = decodeURIComponent(path.slice("/history/".length));
				const entry = history.get(id);
				return reply(res, 200, entry === undefined ? {} : { [id]: entry });
			}
			if (method === "GET" && path === "/view") {
				await gate(path);
				const type = url.searchParams.get("type") ?? "output";
				const name = url.searchParams.get("filename") ?? "";
				const bytes =
					type === "input" ? uploads.get(name) : files.get(`${type}/${name}`);
				if (!bytes) return reply(res, 404, { error: "not found" });
				res.writeHead(200, {
					"content-type": /\.(mp4|webm|mov|mkv|m4v)$/i.test(name)
						? "video/mp4"
						: "image/png",
				});
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
		if (Date.now() < downUntil) {
			socket.destroy();
			return;
		}
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
		holdRequests(path, value) {
			if (value) {
				if (!parked.has(path)) parked.set(path, []);
				return;
			}
			const waiting = parked.get(path) ?? [];
			parked.delete(path);
			for (const release of waiting) release();
		},
		releaseHanging() {
			releaseHanging();
		},
		restart() {
			generation += 1;
			submitted = 0;
			releaseHanging();
			current = null;
			records.clear();
			prompts.clear();
			history.clear();
			files.clear();
		},
		outage(ms) {
			downUntil = Date.now() + ms;
			generation += 1;
			submitted = 0;
			releaseHanging();
			current = null;
			records.clear();
			prompts.clear();
			history.clear();
			files.clear();
			for (const socket of sockets.keys()) socket.destroy();
			server.closeAllConnections();
		},
		async close() {
			generation += 1;
			releaseHanging();
			for (const socket of sockets.keys()) socket.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
