// A loopback fake of the speech service's HTTP contract, for tests and for
// manual checks (Plan 2, Task 3). The contract is `deploy/speech-service/
// README.md`, not the plan's wording of it: where they differ, the README wins.
//
// What it keeps from the real service, because the app's server is built
// around it:
//   - one reader of each stream for a session's whole life: a second GET is
//     409, also after the first reader left; an unknown or forgotten session
//     is 404; `Range` is ignored (always 200 from byte 0, no length);
//   - sentences are made only while `i <= position + 2`, and position is the
//     sentence now playing, reported by `POST …/position` (422 for an id that
//     is not the session's);
//   - times are seconds on the stream's clock with the encoder's 0.025 s delay,
//     in whole MP3 frames; each sentence gets one `sentence` and one `words`
//     event; exactly one `error`, the last event, ends a failed reading;
//   - an ended session stays readable until its events have been read, or for
//     30 s: a late events reader gets what was said, a late audio reader an
//     empty 200; after that 404;
//   - a body is checked the way the service checks it (422 with a field path
//     and never a value, 413 over 4 MiB);
//   - `POST /v1/preview` answers one whole MP3 with a length: an ID3v2 tag and
//     silent frames as long as its text (Plan 3, Task 5).
//
// Node built-ins and relative imports only, so Playwright can import it. It
// writes nothing to disk and speaks no text: the audio is silent MP3 frames.

import { randomBytes } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
	MP3_FRAME_SECONDS,
	silentMp3Frames,
} from "../../../../shared/read-aloud/silent-mp3";

export type FakeSpeechOptions = {
	/** Seconds of audio a written character lasts. Default 0.02. */
	secondsPerChar?: number;
	/** Wait this long before the first sentence is made ("the voice is busy"). */
	firstAudioDelayMs?: number;
	/** `POST /v1/sessions` answers 503. */
	refuseSessions?: boolean;
	/** Wait this long before an error or a cut, so the sentences before it have started playing (a real failure comes after audio began). Default 0. */
	errorDelayMs?: number;
	/** Send `error {id, code: "synthesis_failed"}` at this sentence and end both streams. */
	failAtSentence?: number;
	/** Destroy both connections at this sentence, with no event. */
	cutAtSentence?: number;
	/** `"even"` splits a sentence's time over its tokens; `"null"` gives every token no time. */
	wordTimes?: "even" | "null";
	/** `POST /v1/preview` answers 503 `zonos_unavailable` (`"unavailable"`) or 502 `synthesis_failed` (`"failed"`), at once. */
	failPreview?: "unavailable" | "failed";
	/** Wait this long before a preview is answered. Default 0. */
	previewDelayMs?: number;
};

/** A preview body the fake accepted. */
export type FakePreview = {
	text: string;
	language: string;
	voice: { speaker_id: string; controls: Record<string, number> };
};

type FakeSentence = {
	id: string;
	language: string;
	voice: { speaker_id: string; controls: Record<string, number> };
	tokens: string[];
	paragraph_start: boolean;
};

export type FakeSpeechSession = {
	id: string;
	body: { sentences: FakeSentence[] };
	/** The sentence ids reported as now playing, in order. */
	positions: string[];
	deleted: boolean;
};

export interface FakeSpeechService {
	baseUrl: string;
	/** Every session ever made, the forgotten ones too. */
	sessions: FakeSpeechSession[];
	/** Every preview body accepted, in arrival order. */
	previews: FakePreview[];
	/** The accepted previews whose caller went away before they were answered (an aborted preview). */
	abortedPreviews: FakePreview[];
	/** Replaces the options as a whole: `setOptions({})` clears a failure. A session keeps the options it was made with. */
	setOptions(next: FakeSpeechOptions): void;
	close(): Promise<void>;
}

const ENCODER_DELAY_SECONDS = 0.025;
const SENTENCE_GAP_SECONDS = 0.3;
const PARAGRAPH_GAP_SECONDS = 0.6;
const PREFETCH = 2;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const KEEP_ENDED_MS = 30_000;
const MAX_SENTENCES = 2000;
const MAX_JOINED_CHARS = 400;
const MAX_SEED = 4_294_967_295;
const MAX_PREVIEW_CHARS = 300;
/** A preview's tag: ID3v2.4, no flags, no frames (size 0). */
const PREVIEW_ID3 = Uint8Array.of(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0);

const DEFAULT_OPTIONS = {
	secondsPerChar: 0.02,
	firstAudioDelayMs: 0,
	errorDelayMs: 0,
	refuseSessions: false,
	wordTimes: "even",
	previewDelayMs: 0,
} as const;

type ResolvedOptions = FakeSpeechOptions & {
	secondsPerChar: number;
	firstAudioDelayMs: number;
	errorDelayMs: number;
	refuseSessions: boolean;
	wordTimes: "even" | "null";
	previewDelayMs: number;
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const framesFor = (seconds: number): number =>
	Math.ceil(seconds / MP3_FRAME_SECONDS);
const timeAtFrame = (frames: number): number =>
	round3(ENCODER_DELAY_SECONDS + frames * MP3_FRAME_SECONDS);
const sse = (event: string, data: unknown): string =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// ---------------------------------------------------------------------------
// The request body
// ---------------------------------------------------------------------------

type Checked =
	| { ok: true; sentences: FakeSentence[] }
	| { ok: false; field: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

type CheckedVoice =
	| { ok: true; voice: FakeSentence["voice"] }
	| { ok: false; field: string };

/** The service's rules for a voice (a session's sentence and a preview share them). `at` is the path of the voice. */
function checkVoice(raw: unknown, at: string): CheckedVoice {
	if (!isObject(raw)) return { ok: false, field: at };
	const speakerId = raw.speaker_id;
	if (typeof speakerId !== "string" || speakerId === "")
		return { ok: false, field: `${at}.speaker_id` };
	const rawControls = "controls" in raw ? raw.controls : {};
	if (!isObject(rawControls)) return { ok: false, field: `${at}.controls` };
	const controls: Record<string, number> = {};
	for (const [name, value] of Object.entries(rawControls)) {
		if (typeof value !== "number" || !Number.isFinite(value))
			return { ok: false, field: `${at}.controls` };
		controls[name] = value;
	}
	return { ok: true, voice: { speaker_id: speakerId, controls } };
}

type CheckedPreview =
	| { ok: true; preview: FakePreview }
	| { ok: false; field: string };

/** The service's rules for a preview request: text, then language, then voice; a text with nothing speakable is 422 `text` too. */
function checkPreviewBody(raw: unknown): CheckedPreview {
	if (!isObject(raw)) return { ok: false, field: "body" };
	const text = raw.text;
	if (
		typeof text !== "string" ||
		text === "" ||
		Array.from(text).length > MAX_PREVIEW_CHARS
	)
		return { ok: false, field: "text" };
	if (raw.language !== "en" && raw.language !== "hu")
		return { ok: false, field: "language" };
	const voice = checkVoice(raw.voice, "voice");
	if (!voice.ok) return { ok: false, field: voice.field };
	if (!/[\p{L}\p{N}]/u.test(text)) return { ok: false, field: "text" };
	return {
		ok: true,
		preview: { text, language: raw.language, voice: voice.voice },
	};
}

/** The service's rules for a session request; the first field that fails is named. */
function checkSessionBody(raw: unknown): Checked {
	if (!isObject(raw)) return { ok: false, field: "body" };
	const list = raw.sentences;
	if (!Array.isArray(list) || list.length < 1 || list.length > MAX_SENTENCES)
		return { ok: false, field: "sentences" };
	const sentences: FakeSentence[] = [];
	const ids = new Set<string>();
	for (let i = 0; i < list.length; i++) {
		const item: unknown = list[i];
		const at = `sentences[${i}]`;
		if (!isObject(item)) return { ok: false, field: at };
		if (typeof item.id !== "string" || item.id === "" || ids.has(item.id))
			return { ok: false, field: `${at}.id` };
		ids.add(item.id);
		if (item.language !== "en" && item.language !== "hu")
			return { ok: false, field: `${at}.language` };
		const voice = checkVoice(item.voice, `${at}.voice`);
		if (!voice.ok) return { ok: false, field: voice.field };
		const tokens = item.tokens;
		if (
			!Array.isArray(tokens) ||
			tokens.length === 0 ||
			!tokens.every((token) => typeof token === "string") ||
			tokens.join(" ").length > MAX_JOINED_CHARS
		)
			return { ok: false, field: `${at}.tokens` };
		if (typeof item.paragraph_start !== "boolean")
			return { ok: false, field: `${at}.paragraph_start` };
		sentences.push({
			id: item.id,
			language: item.language,
			voice: voice.voice,
			tokens: tokens as string[],
			paragraph_start: item.paragraph_start,
		});
	}
	if ("seed" in raw) {
		const seed = raw.seed;
		if (
			typeof seed !== "number" ||
			!Number.isInteger(seed) ||
			seed < 0 ||
			seed > MAX_SEED
		)
			return { ok: false, field: "seed" };
	}
	return { ok: true, sentences };
}

function readBody(
	req: IncomingMessage,
): Promise<{ tooLarge: true } | { tooLarge: false; text: string }> {
	return new Promise((resolve) => {
		let tooLarge = Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES;
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) tooLarge = true;
			if (!tooLarge) chunks.push(chunk);
		});
		// The whole body is read before the answer, so a client that is still
		// writing never meets a closed socket.
		req.on("end", () =>
			resolve(
				tooLarge
					? { tooLarge: true }
					: { tooLarge: false, text: Buffer.concat(chunks).toString("utf8") },
			),
		);
		req.on("error", () => resolve({ tooLarge: false, text: "" }));
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function sendText(
	res: ServerResponse,
	status: number,
	text: string,
	headers: Record<string, string> = {},
): void {
	res.writeHead(status, {
		"Content-Type": "text/plain; charset=utf-8",
		...headers,
	});
	res.end(text);
}

// ---------------------------------------------------------------------------
// One stream of one session
// ---------------------------------------------------------------------------

/** What is written to one reader: held until it attaches, then passed on. */
class Sink {
	private backlog: Buffer[] = [];
	private response: ServerResponse | null = null;
	private ended = false;
	private cutOff = false;
	/** A reader took this stream. There is one for the session's whole life. */
	taken = false;
	/** The reader has had everything, or has left. */
	finished = false;

	constructor(private readonly onFinished: () => void) {}

	write(chunk: Buffer | string): void {
		if (this.ended) return;
		const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		if (this.response) this.response.write(data);
		else if (!this.taken) this.backlog.push(data);
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.response?.end();
	}

	/** The connection is cut: what was written goes out, then the socket is destroyed. */
	cut(): void {
		this.ended = true;
		this.cutOff = true;
		this.dropOnceCut();
	}

	/** The audio made before a failure goes to a reader that was attached, and is dropped for one that was not. */
	dropBacklog(): void {
		this.backlog = [];
	}

	attach(response: ServerResponse): void {
		this.taken = true;
		this.response = response;
		response.on("close", () => {
			this.response = null;
			this.ended = true;
			this.finished = true;
			this.onFinished();
		});
		for (const chunk of this.backlog) response.write(chunk);
		this.backlog = [];
		if (this.cutOff) this.dropOnceCut();
		else if (this.ended) response.end();
	}

	/** Stop writing and leave. */
	stop(): void {
		this.ended = true;
		this.backlog = [];
		this.response?.destroy();
	}

	private dropOnceCut(): void {
		const response = this.response;
		if (!response) return;
		response.write("", () => response.destroy());
	}
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

type Outcome = "running" | "done" | "failed" | "cut" | "deleted";

class SessionState {
	position = 0;
	outcome: Outcome = "running";
	readonly events: Sink;
	readonly audio: Sink;
	private waiters: Array<() => void> = [];
	private keepTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		readonly record: FakeSpeechSession,
		private readonly options: ResolvedOptions,
		private readonly forget: (id: string) => void,
	) {
		this.events = new Sink(() => this.afterReaderFinished());
		this.audio = new Sink(() => this.afterReaderFinished());
	}

	private notify(): void {
		const waiting = this.waiters;
		this.waiters = [];
		for (const resolve of waiting) resolve();
	}

	private nextChange(): Promise<void> {
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	private async pause(ms: number): Promise<void> {
		const deadline = Date.now() + ms;
		while (this.outcome === "running" && Date.now() < deadline) {
			const timer = new Promise<void>((resolve) => {
				const handle = setTimeout(resolve, deadline - Date.now());
				handle.unref();
			});
			await Promise.race([timer, this.nextChange()]);
		}
	}

	/** Waits until sentence `index` is within the prefetch window. False when the session ended meanwhile. */
	private async waitForWindow(index: number): Promise<boolean> {
		while (this.outcome === "running" && index > this.position + PREFETCH)
			await this.nextChange();
		return this.outcome === "running";
	}

	/** A position report: the sentence now playing. Only a running session takes it. */
	report(sentenceId: string): void {
		if (this.outcome !== "running") return;
		this.record.positions.push(sentenceId);
		this.position = this.record.body.sentences.findIndex(
			(sentence) => sentence.id === sentenceId,
		);
		this.notify();
	}

	async run(): Promise<void> {
		const { sentences } = this.record.body;
		if (this.options.firstAudioDelayMs > 0)
			await this.pause(this.options.firstAudioDelayMs);
		let writtenFrames = 0;
		for (let i = 0; i < sentences.length; i++) {
			if (!(await this.waitForWindow(i))) return;
			const sentence = sentences[i] as FakeSentence;
			if (
				i === this.options.cutAtSentence ||
				i === this.options.failAtSentence
			) {
				await this.pause(this.options.errorDelayMs);
				if (this.outcome !== "running") return;
				return i === this.options.cutAtSentence
					? this.cut()
					: this.fail(sentence.id);
			}

			const gapFrames =
				i === 0
					? 0
					: framesFor(
							sentence.paragraph_start
								? PARAGRAPH_GAP_SECONDS
								: SENTENCE_GAP_SECONDS,
						);
			const chars = sentence.tokens.join(" ").length;
			const lengthFrames = framesFor(
				chars * this.options.secondsPerChar + SENTENCE_GAP_SECONDS,
			);
			const startFrames = writtenFrames + gapFrames;
			const endFrames = startFrames + lengthFrames;
			const start = timeAtFrame(startFrames);
			const end = timeAtFrame(endFrames);

			// The sentence event comes before the audio it describes, then its words.
			this.events.write(sse("sentence", { id: sentence.id, start, end }));
			this.audio.write(Buffer.from(silentMp3Frames(gapFrames + lengthFrames)));
			this.events.write(
				sse("words", {
					id: sentence.id,
					times: this.wordTimes(sentence.tokens, start, end),
				}),
			);
			writtenFrames = endFrames;
		}
		this.events.write(sse("done", {}));
		this.settle("done");
	}

	private wordTimes(
		tokens: string[],
		start: number,
		end: number,
	): Array<[number, number] | null> {
		if (this.options.wordTimes === "null") return tokens.map(() => null);
		const span = end - start;
		return tokens.map((token, k) =>
			token === ""
				? null
				: [
						round3(start + (span * k) / tokens.length),
						round3(start + (span * (k + 1)) / tokens.length),
					],
		);
	}

	private fail(sentenceId: string): void {
		this.events.write(
			sse("error", { id: sentenceId, code: "synthesis_failed" }),
		);
		if (!this.audio.taken) this.audio.dropBacklog();
		this.settle("failed");
	}

	private cut(): void {
		this.outcome = "cut";
		this.events.cut();
		this.audio.cut();
		this.keepForAWhile();
		this.notify();
	}

	private settle(outcome: "done" | "failed"): void {
		this.outcome = outcome;
		this.events.end();
		this.audio.end();
		this.keepForAWhile();
		this.notify();
	}

	/** A cancel: both streams end with neither `done` nor `error`, and the session is forgotten at once. */
	cancel(): void {
		this.record.deleted = true;
		this.outcome = "deleted";
		this.events.end();
		this.audio.end();
		this.clearTimer();
		this.notify();
		this.forget(this.record.id);
	}

	/** The service stops: nothing is left running. */
	shutDown(): void {
		this.outcome = "deleted";
		this.events.stop();
		this.audio.stop();
		this.clearTimer();
		this.notify();
	}

	private keepForAWhile(): void {
		this.keepTimer = setTimeout(
			() => this.forget(this.record.id),
			KEEP_ENDED_MS,
		);
		this.keepTimer.unref();
	}

	private clearTimer(): void {
		if (this.keepTimer) clearTimeout(this.keepTimer);
		this.keepTimer = null;
	}

	/** An ended session is forgotten once its events (and, after a `done`, its audio too) have been read. */
	private afterReaderFinished(): void {
		if (this.outcome === "running" || this.outcome === "deleted") return;
		const drained =
			this.outcome === "done"
				? this.events.finished && this.audio.finished
				: this.events.finished;
		if (drained) {
			this.clearTimer();
			this.forget(this.record.id);
		}
	}
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * A fake speech service on `127.0.0.1`. `listen.port` is for the script that
 * runs it by hand; tests take the free port the system gives.
 */
export async function createFakeSpeechService(
	options: FakeSpeechOptions = {},
	listen: { port?: number } = {},
): Promise<FakeSpeechService> {
	let current: FakeSpeechOptions = { ...options };
	const resolve = (): ResolvedOptions => ({ ...DEFAULT_OPTIONS, ...current });
	const sessions: FakeSpeechSession[] = [];
	const previews: FakePreview[] = [];
	const abortedPreviews: FakePreview[] = [];
	const live = new Map<string, SessionState>();

	const forget = (id: string): void => {
		live.delete(id);
	};

	async function createSession(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const optionsNow = resolve();
		const body = await readBody(req);
		if (optionsNow.refuseSessions)
			return sendJson(res, 503, { error: "unavailable" });
		if (body.tooLarge) return sendJson(res, 413, { error: "too_large" });
		let parsed: unknown;
		try {
			parsed = JSON.parse(body.text);
		} catch {
			return sendJson(res, 422, { error: "invalid", field: "body" });
		}
		const checked = checkSessionBody(parsed);
		if (!checked.ok)
			return sendJson(res, 422, { error: "invalid", field: checked.field });
		const record: FakeSpeechSession = {
			id: randomBytes(16).toString("hex"),
			body: { sentences: checked.sentences },
			positions: [],
			deleted: false,
		};
		sessions.push(record);
		const state = new SessionState(record, optionsNow, forget);
		live.set(record.id, state);
		void state.run();
		sendJson(res, 201, { session_id: record.id });
	}

	async function makePreview(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const optionsNow = resolve();
		const body = await readBody(req);
		if (body.tooLarge) return sendJson(res, 413, { error: "too_large" });
		let parsed: unknown;
		try {
			parsed = JSON.parse(body.text);
		} catch {
			return sendJson(res, 422, { error: "invalid", field: "body" });
		}
		const checked = checkPreviewBody(parsed);
		if (!checked.ok)
			return sendJson(res, 422, { error: "invalid", field: checked.field });
		const preview = checked.preview;
		previews.push(preview);
		if (optionsNow.failPreview === "unavailable")
			return sendJson(res, 503, { code: "zonos_unavailable" });
		if (optionsNow.failPreview === "failed")
			return sendJson(res, 502, { code: "synthesis_failed" });
		// A caller that goes away while the preview is "being made" is recorded, and
		// the wait ends with it, as the real service stops caring about a closed call.
		let answered = false;
		await new Promise<void>((done) => {
			const timer = setTimeout(done, optionsNow.previewDelayMs);
			res.on("close", () => {
				clearTimeout(timer);
				if (!answered) abortedPreviews.push(preview);
				done();
			});
		});
		if (res.destroyed) return;
		const frames = silentMp3Frames(
			Math.max(
				1,
				framesFor(Array.from(preview.text).length * optionsNow.secondsPerChar),
			),
		);
		const mp3 = new Uint8Array(PREVIEW_ID3.length + frames.length);
		mp3.set(PREVIEW_ID3);
		mp3.set(frames, PREVIEW_ID3.length);
		answered = true;
		res.writeHead(200, {
			"Content-Type": "audio/mpeg",
			"Content-Length": String(mp3.length),
		});
		res.end(mp3);
	}

	async function takePosition(
		req: IncomingMessage,
		res: ServerResponse,
		state: SessionState,
	): Promise<void> {
		const body = await readBody(req);
		let parsed: unknown;
		try {
			parsed = body.tooLarge ? null : JSON.parse(body.text);
		} catch {
			parsed = null;
		}
		if (!isObject(parsed))
			return sendJson(res, 422, { error: "invalid", field: "body" });
		const id = parsed.sentence_id;
		const known =
			typeof id === "string" &&
			state.record.body.sentences.some((sentence) => sentence.id === id);
		if (!known)
			return sendJson(res, 422, { error: "invalid", field: "sentence_id" });
		state.report(id);
		res.writeHead(204);
		res.end();
	}

	function openStream(
		res: ServerResponse,
		state: SessionState,
		kind: "audio" | "events",
	): void {
		const sink = kind === "audio" ? state.audio : state.events;
		if (sink.taken) {
			sendJson(res, 409, { error: "reader_taken" });
			return;
		}
		res.writeHead(
			200,
			kind === "audio"
				? { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" }
				: {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache",
					},
		);
		res.flushHeaders();
		sink.attach(res);
	}

	async function handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const method = req.method ?? "GET";
		const { pathname } = new URL(req.url ?? "/", "http://fake");
		if (pathname === "/health") {
			if (method !== "GET")
				return sendText(res, 405, "Method Not Allowed", { Allow: "GET" });
			return sendJson(res, 200, { ok: true, zonos: true, aligner: true });
		}
		if (pathname === "/v1/sessions") {
			if (method !== "POST")
				return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
			return createSession(req, res);
		}
		if (pathname === "/v1/preview") {
			if (method !== "POST")
				return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
			return makePreview(req, res);
		}
		const match =
			/^\/v1\/sessions\/([^/]+)(?:\/(audio|events|position))?$/u.exec(pathname);
		if (!match) return sendText(res, 404, "Not Found");
		const [, id = "", route] = match;
		const allowed = route === "position" ? "POST" : route ? "GET" : "DELETE";
		if (method !== allowed)
			return sendText(res, 405, "Method Not Allowed", { Allow: allowed });
		const state = live.get(id);
		if (!state) {
			if (route === "position") await readBody(req);
			return sendJson(res, 404, { error: "not_found" });
		}
		if (route === "audio" || route === "events")
			return openStream(res, state, route);
		if (route === "position") return takePosition(req, res, state);
		state.cancel();
		res.writeHead(204);
		res.end();
	}

	const server: Server = createServer((req, res) => {
		handle(req, res).catch(() => {
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
	await new Promise<void>((done) =>
		server.listen(listen.port ?? 0, "127.0.0.1", done),
	);
	const { port } = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		sessions,
		previews,
		abortedPreviews,
		setOptions(next) {
			current = { ...next };
		},
		async close() {
			for (const state of live.values()) state.shutDown();
			live.clear();
			await new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			});
		},
	};
}
