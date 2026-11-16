// The readings registry: one reading per person, and the replay that lets any
// number of browser requests attach to it (Plan 2, Task 4).
//
// The speech service allows ONE reader of each stream per session, for the
// session's whole life, and ignores `Range`. A browser's <audio> element asks
// more than once (Safari probes with `bytes=0-1` first, then asks again), so
// this server is the service's only reader: it opens `audio` and `events` once
// each, as soon as the session exists, keeps what they say in memory, and
// serves every browser request from that replay. The replay is a chain of
// chunks and each reader holds its own place in it, so a slow reader never
// holds a fast one back and chunks no reader needs any more are freed.
//
// What it never does: log or store the reply's text or its audio on disk (logs
// carry the session id, counts and byte counts), DELETE a session because the
// service said `done` (that drops audio nobody has read yet; here only a stop,
// a jump, a replacement or the idle end cancels), or reopen a stream that ended
// (the service refuses a second GET; the browser starts a new session).

import {
	createSpeechSession,
	deleteSpeechSession,
	openSpeechStream,
	postSpeechPosition,
	type SpeechSentence,
} from "./speech-client";

export type Reading = { sessionId: string; userId: string };

/** A reading with no audio reader for this long closes (counted from its creation too). */
export const READING_IDLE_MS = 30_000;
/** About 8.7 minutes of audio at 128 kbit/s: past it, a new reader can no longer start from the first byte. */
export const AUDIO_REPLAY_MAX_BYTES = 8 * 1024 * 1024;
/** A comment line this often, so a proxy does not cut a quiet events stream. */
export const EVENTS_HEARTBEAT_MS = 15_000;

const EMPTY = new Uint8Array(0);
const REPLACED_EVENT = new TextEncoder().encode(
	"event: replaced\ndata: {}\n\n",
);
const HEARTBEAT = new TextEncoder().encode(": hb\n\n");

let idleMs = READING_IDLE_MS;
let replayMaxBytes = AUDIO_REPLAY_MAX_BYTES;
let heartbeatMs = EVENTS_HEARTBEAT_MS;

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

type Chunk = { data: Uint8Array; next: Chunk | null };

/** What one upstream stream has said, as a chain: every reader walks it at its own pace. */
class Replay {
	private head: Chunk | null;
	private last: Chunk;
	private waiting: Array<() => void> = [];
	bytes = 0;
	ended = false;
	failed = false;
	beats = 0;

	constructor() {
		// A chunk before the first one: a reader starts here.
		const start: Chunk = { data: EMPTY, next: null };
		this.head = start;
		this.last = start;
	}

	/** Where a new reader starts, or null once the replay is released. */
	start(): Chunk | null {
		return this.head;
	}

	push(data: Uint8Array, capBytes = Number.POSITIVE_INFINITY): void {
		if (this.ended || data.length === 0) return;
		const chunk: Chunk = { data, next: null };
		this.last.next = chunk;
		this.last = chunk;
		this.bytes += data.length;
		// Released: readers already attached keep walking the chain, and nobody new can start.
		if (this.bytes > capBytes) this.head = null;
		this.wake();
	}

	end(failed: boolean): void {
		if (this.ended) return;
		this.ended = true;
		this.failed = failed;
		this.wake();
	}

	beat(): void {
		this.beats += 1;
		this.wake();
	}

	changed(): Promise<void> {
		return new Promise((resolve) => this.waiting.push(resolve));
	}

	private wake(): void {
		const waiting = this.waiting;
		this.waiting = [];
		for (const resolve of waiting) resolve();
	}
}

/**
 * One browser reader of a replay. It pulls only as the browser reads, so a
 * paused page holds nothing back and costs nothing. `onComplete` runs once, when
 * the reader has been given the replay's end; `onCancel` when the browser leaves.
 */
function replayStream(
	replay: Replay,
	from: Chunk,
	hooks: {
		onComplete: () => void;
		onCancel: () => void;
		heartbeat?: Uint8Array;
	},
): ReadableStream<Uint8Array> {
	let cursor = from;
	let seenBeats = replay.beats;
	let cancelled = false;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				for (;;) {
					if (cancelled) return;
					if (cursor.next) {
						cursor = cursor.next;
						controller.enqueue(cursor.data);
						return;
					}
					if (replay.ended) {
						if (replay.failed)
							controller.error(new Error("the speech service stopped"));
						else controller.close();
						hooks.onComplete();
						return;
					}
					if (hooks.heartbeat && replay.beats !== seenBeats) {
						seenBeats = replay.beats;
						controller.enqueue(hooks.heartbeat);
						return;
					}
					await replay.changed();
				}
			},
			cancel() {
				cancelled = true;
				hooks.onCancel();
			},
		},
		{ highWaterMark: 1 },
	);
}

// ---------------------------------------------------------------------------
// One reading
// ---------------------------------------------------------------------------

type Timer = ReturnType<typeof setTimeout>;

class ReadingState {
	readonly handle: Reading;
	readonly audio = new Replay();
	readonly events = new Replay();
	/** Audio readers attached that have neither left nor been given the end. */
	audioReaders = 0;
	/** Audio readers that were given the whole audio. */
	audioCompleted = 0;
	closed = false;
	idleTimer: Timer | null = null;
	heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		readonly userId: string,
		readonly sessionId: string,
		readonly baseUrl: string,
		readonly sentenceCount: number,
		readonly abort: AbortController,
	) {
		this.handle = { sessionId, userId };
	}
}

const readings = new Map<string, ReadingState>();
/** The last opening of each person, so two quick presses run one after the other. */
const openings = new Map<string, Promise<unknown>>();

function lookup(reading: Reading): ReadingState | null {
	const state = readings.get(reading.userId);
	return state && !state.closed && state.sessionId === reading.sessionId
		? state
		: null;
}

function disarmIdle(state: ReadingState): void {
	if (state.idleTimer) clearTimeout(state.idleTimer);
	state.idleTimer = null;
}

function armIdle(state: ReadingState): void {
	disarmIdle(state);
	if (state.closed) return;
	state.idleTimer = setTimeout(() => {
		void closeState(state, "idle");
	}, idleMs);
	state.idleTimer.unref();
}

/**
 * The audio and the timeline have both ended and a reader was given all of the
 * audio: nothing is left to serve. (A reader that left early, as Safari's
 * probe does, is not a reader that was given it all; and the timeline is
 * waited for, so closing never cuts it short.)
 */
function closeWhenDrained(state: ReadingState): void {
	if (
		!state.closed &&
		state.audio.ended &&
		state.events.ended &&
		state.audioCompleted > 0 &&
		state.audioReaders === 0
	)
		void closeState(state, "drained");
}

async function closeState(
	state: ReadingState,
	reason: "replaced" | "stopped" | "idle" | "drained" | "failed",
): Promise<void> {
	if (state.closed) return;
	state.closed = true;
	if (readings.get(state.userId) === state) readings.delete(state.userId);
	disarmIdle(state);
	if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
	state.heartbeatTimer = null;
	if (reason === "replaced") state.events.push(REPLACED_EVENT);
	state.abort.abort();
	state.audio.end(false);
	state.events.end(false);
	console.info("[READ_ALOUD] reading closed", {
		sessionId: state.sessionId,
		sentences: state.sentenceCount,
		audioBytes: state.audio.bytes,
		reason,
	});
	await deleteSpeechSession(state.baseUrl, state.sessionId);
}

/** Reads one upstream stream to its end into its replay. */
async function pump(
	state: ReadingState,
	stream: ReadableStream<Uint8Array>,
	replay: Replay,
	capBytes?: number,
): Promise<void> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			replay.push(value, capBytes);
		}
		replay.end(false);
	} catch {
		// A stream the service cut: its readers see an error, once, and it is
		// never reopened (the service refuses a second reader).
		replay.end(!state.closed);
	}
	closeWhenDrained(state);
}

async function open(p: {
	userId: string;
	baseUrl: string;
	sentences: SpeechSentence[];
}): Promise<Reading> {
	const previous = readings.get(p.userId);
	if (previous) await closeState(previous, "replaced");

	const sessionId = await createSpeechSession(p.baseUrl, p.sentences);
	const abort = new AbortController();
	let audioStream: ReadableStream<Uint8Array>;
	let eventsStream: ReadableStream<Uint8Array>;
	try {
		// Both at once, as soon as the session exists: nothing reopens them later.
		[audioStream, eventsStream] = await Promise.all([
			openSpeechStream(p.baseUrl, sessionId, "audio", abort.signal),
			openSpeechStream(p.baseUrl, sessionId, "events", abort.signal),
		]);
	} catch (error) {
		abort.abort();
		await deleteSpeechSession(p.baseUrl, sessionId);
		throw error;
	}

	const state = new ReadingState(
		p.userId,
		sessionId,
		p.baseUrl,
		p.sentences.length,
		abort,
	);
	readings.set(p.userId, state);
	armIdle(state);
	state.heartbeatTimer = setInterval(() => state.events.beat(), heartbeatMs);
	state.heartbeatTimer.unref();
	void pump(state, audioStream, state.audio, replayMaxBytes);
	void pump(state, eventsStream, state.events);
	console.info("[READ_ALOUD] reading opened", {
		sessionId,
		sentences: p.sentences.length,
	});
	return state.handle;
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

/**
 * Opens a reading for a person. Their current reading is closed first, and its
 * events readers are told (`event: replaced`). Throws `SpeechUnavailable` when
 * the service cannot be reached or answers with a server error.
 */
export function openReading(p: {
	userId: string;
	baseUrl: string;
	sentences: SpeechSentence[];
}): Promise<Reading> {
	const before = openings.get(p.userId) ?? Promise.resolve();
	const next = before.catch(() => undefined).then(() => open(p));
	openings.set(p.userId, next);
	const clear = () => {
		if (openings.get(p.userId) === next) openings.delete(p.userId);
	};
	next.then(clear, clear);
	return next;
}

/** The person's reading, if `sessionId` is it: any other id is not theirs to read. */
export function currentReading(
	userId: string,
	sessionId: string,
): Reading | null {
	const state = readings.get(userId);
	return state && !state.closed && state.sessionId === sessionId
		? state.handle
		: null;
}

/**
 * The audio from its first byte, then live. Null once the replay is released
 * (the audio passed `AUDIO_REPLAY_MAX_BYTES`) or the reading is over.
 */
export function attachAudio(
	reading: Reading,
): ReadableStream<Uint8Array> | null {
	const state = lookup(reading);
	const from = state?.audio.start();
	if (!state || !from) return null;
	state.audioReaders += 1;
	disarmIdle(state);
	let left = false;
	const leave = () => {
		if (left) return;
		left = true;
		state.audioReaders -= 1;
		if (state.audioReaders === 0) armIdle(state);
	};
	return replayStream(state.audio, from, {
		onCancel: leave,
		onComplete: () => {
			if (!left) state.audioCompleted += 1;
			leave();
			closeWhenDrained(state);
		},
	});
}

/** The timeline from its first event, then live, with a comment line every 15 s. */
export function attachEvents(reading: Reading): ReadableStream<Uint8Array> {
	const state = lookup(reading);
	const from = state?.events.start();
	if (!state || !from) {
		return new ReadableStream({
			start(controller) {
				controller.close();
			},
		});
	}
	return replayStream(state.events, from, {
		onCancel: () => undefined,
		onComplete: () => undefined,
		heartbeat: HEARTBEAT,
	});
}

/** The sentence now playing, from the browser's playback time. */
export async function reportPosition(
	reading: Reading,
	sentenceId: string,
): Promise<void> {
	const state = lookup(reading);
	if (!state) return;
	await postSpeechPosition(state.baseUrl, state.sessionId, sentenceId);
}

/** A stop or a jump: cancels the session, ends every reader and forgets the reading. */
export async function closeReading(reading: Reading): Promise<void> {
	const state = lookup(reading);
	if (state) await closeState(state, "stopped");
}

/** Test seam: shorter times and a smaller cap. */
export function configureReadingsForTests(o: {
	idleMs?: number;
	replayMaxBytes?: number;
	heartbeatMs?: number;
}): void {
	if (o.idleMs !== undefined) idleMs = o.idleMs;
	if (o.replayMaxBytes !== undefined) replayMaxBytes = o.replayMaxBytes;
	if (o.heartbeatMs !== undefined) heartbeatMs = o.heartbeatMs;
}

/** Test seam: forget every reading, without calling the service, and restore the limits. */
export function resetReadingsForTests(): void {
	for (const state of readings.values()) {
		state.closed = true;
		disarmIdle(state);
		if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
		state.abort.abort();
		state.audio.end(false);
		state.events.end(false);
	}
	readings.clear();
	openings.clear();
	idleMs = READING_IDLE_MS;
	replayMaxBytes = AUDIO_REPLAY_MAX_BYTES;
	heartbeatMs = EVENTS_HEARTBEAT_MS;
}
