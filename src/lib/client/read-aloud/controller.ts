/**
 * The reading controller: it carries out what the reading machine decides
 * (`reading-machine.ts`). It owns the one `<audio>` element, the session's
 * `EventSource`, the timers, and the calls to the session routes, and it turns
 * what happens to them back into the machine's events. Components read
 * `readAloudView` and call this; nothing else touches the audio or the routes.
 *
 * Built on the speech service's contract (`deploy/speech-service/README.md`):
 * - position is reported from playback time, so synthesis keeps two sentences ahead;
 * - `done` means synthesis finished, not playback: it never ends a reading;
 * - an events stream that ends without `done` or `error` is a stop;
 * - a jump, a resume after a long pause and a retry are new sessions.
 */

import { get } from "svelte/store";
import { fetchServerHealth, type ServerHealth } from "$lib/client/api/health";
import { ApiError } from "$lib/client/api/http";
import {
	cancelReadingSession,
	createReadingSession,
	type ReadingRequestBody,
	type ReadingStart,
	readingAudioUrl,
	readingEventsUrl,
	reportReadingPosition,
} from "$lib/client/api/read-aloud";
import {
	SERVER_UPDATE_WATCH_MAX_MS,
	SERVER_UPDATE_WATCH_POLL_MS,
} from "$lib/client/server-update-watch";
import { silentMp3DataUri } from "$lib/shared/read-aloud/silent-mp3";
import { type ReadAloudView, setReadAloudView } from "$lib/stores/read-aloud";
import { reportServerUpdateSign } from "$lib/stores/server-update";
import { uiLanguage } from "$lib/stores/settings";
import { requestThreadFocus } from "$lib/stores/thread-focus";
import { type Detect, loadDetector } from "./language";
import {
	type BreakKind,
	classifyBreak,
	initialReadingState,
	READING_TIMER_MS,
	type ReadingCommand,
	type ReadingEvent,
	type ReadingState,
	type ReadingStatus,
	type ReadingTimer,
	reduce,
} from "./reading-machine";
import {
	buildSpeechScript,
	type ScriptSentence,
	type SpeechScript,
	sentenceAtPoint,
} from "./speech-script";
import {
	estimateSeconds,
	formatClock,
	notches,
	SessionTimeline,
	shareAt,
} from "./timeline";

export type StartRequest = {
	conversationId: string;
	messageId: string;
	segmentIds: readonly string[];
	/** Read from here: the selection's start. */
	from?: { node: Node; offset: number };
};

export type Readability =
	| { kind: "ready" }
	| { kind: "noVoice"; language: string | null }
	| { kind: "nothing" }
	| { kind: "unknown" };

export interface ReadAloudController {
	start(r: StartRequest): void;
	toggle(): void;
	seek(i: number): void;
	retry(): void;
	beginDrag(): void;
	dragTo(i: number): void;
	endDrag(i: number): void;
	setSpeed(v: number): void;
	stop(): void;
	locate(): void;
	/** `"4/9 · Feed it once a day…"`: the sentence's number and its first written words. */
	sentencePreview(i: number): string;
	assessReadability(segmentIds: readonly string[]): Promise<Readability>;
}

/** What the controller needs of an `<audio>` element. */
export type AudioLike = EventTarget & {
	src: string;
	currentTime: number;
	playbackRate: number;
	preservesPitch: boolean;
	readonly paused: boolean;
	readonly ended: boolean;
	play(): Promise<void>;
	pause(): void;
	load(): void;
	removeAttribute(name: string): void;
};

/** What the controller needs of an `EventSource`. */
export type EventSourceLike = EventTarget & {
	readonly readyState: number;
	close(): void;
};

export type ReadAloudDeps = {
	audio: AudioLike;
	createEventSource: (url: string) => EventSourceLike;
	api: {
		createReadingSession: (body: ReadingRequestBody) => Promise<ReadingStart>;
		cancelReadingSession: (id: string) => void;
		reportReadingPosition: (id: string, sentenceId: string) => void;
		readingAudioUrl: (id: string) => string;
		readingEventsUrl: (id: string) => string;
	};
	loadDetector: () => Promise<Detect>;
	document: Document;
	/** Where `online` and `offline` are heard. */
	window: EventTarget;
	isOnline: () => boolean;
	isHidden: () => boolean;
	fetchHealth: () => Promise<ServerHealth>;
	reportUpdateSign: () => void;
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
	requestFrame: (fn: () => void) => unknown;
	cancelFrame: (handle: unknown) => void;
	now: () => number;
	uiLanguage: () => "en" | "hu";
	setView: (view: ReadAloudView) => void;
	requestFocus: (rect: () => DOMRect | null, mode: "center" | "reveal") => void;
	/** Calls `onChange` when the thread's DOM changes; returns the way to stop. */
	observe: (target: Node, onChange: () => void) => () => void;
};

const EVENTSOURCE_CLOSED = 2;
const DEFAULT_CHARS_PER_SECOND: Record<"en" | "hu", number> = {
	en: 15,
	hu: 15,
};
const TIMER_EVENTS: Record<ReadingTimer, ReadingEvent["type"]> = {
	busy: "busyTimeout",
	start: "startTimeout",
	failedSpeaker: "startFailedTimeout",
	longPause: "longPause",
	finished: "finishedTimeout",
};
const NO_READING: ReadonlySet<ReadingStatus> = new Set([
	"idle",
	"finished",
	"startFailed",
]);

/** One reply being read: what it is, its script, and what its sessions have measured. */
type Reading = {
	conversationId: string;
	messageId: string;
	segmentIds: readonly string[];
	/** Which `.code-block` of the reply Read from here started in, by its place (the element may be redrawn). */
	readBlockIndex: number | null;
	script: SpeechScript | null;
	/**
	 * Each sentence's first text node, kept when the script was built. Word ranges are live: when a
	 * re-render removes their node they collapse onto its parent and still look connected, so a
	 * redrawn reply is noticed by these nodes, not by the ranges.
	 */
	anchors: Node[];
	known: Map<number, number>;
	charsPerSecond: Record<"en" | "hu", number>;
};

/** One session of the speech service: a reading from sentence `from` on. */
type Session = {
	id: string;
	from: number;
	timeline: SessionTimeline;
	events: EventSourceLike | null;
	/** How the stream said it failed, held until the audio made before it has played. */
	failure: { serviceError: boolean; sentenceId: string | null } | null;
};

function quoteId(id: string): string {
	return id.replace(/["\\]/g, "\\$&");
}

function uniqueRanges(ranges: readonly Range[]): Range[] {
	return [...new Set(ranges)];
}

function unionRect(ranges: readonly Range[]): DOMRect | null {
	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const range of ranges) {
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) continue;
		left = Math.min(left, rect.left);
		top = Math.min(top, rect.top);
		right = Math.max(right, rect.right);
		bottom = Math.max(bottom, rect.bottom);
	}
	if (!Number.isFinite(left)) return null;
	return new DOMRect(left, top, right - left, bottom - top);
}

function parseData(event: Event): Record<string, unknown> | null {
	if (!(event instanceof MessageEvent) || typeof event.data !== "string")
		return null;
	try {
		const data = JSON.parse(event.data) as unknown;
		return data && typeof data === "object"
			? (data as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export function createReadAloudController(
	deps: ReadAloudDeps,
): ReadAloudController {
	const { audio, api } = deps;
	let state: ReadingState = initialReadingState;
	let reading: Reading | null = null;
	/** The reading a press or a selection asked for, taken by the `open` it causes. */
	let pending: Reading | null = null;
	let starting = false;
	let session: Session | null = null;
	let openToken = 0;
	let defaultSpeedPending = false;
	let expectPause = false;
	let unlocked = false;
	let detect: Detect | null = null;
	let lastLocate: {
		sentence: number;
		word: number | null;
		within: number;
	} | null = null;
	let frame: unknown = null;
	let active = false;
	let stopObserving: (() => void) | null = null;
	let endRecovery: (() => void) | null = null;
	let lastViewKey = "";
	const timers = new Map<ReadingTimer, unknown>();

	const isUnlockClip = () => audio.src.startsWith("data:");
	const hasSessionAudio = () => session !== null && !isUnlockClip();

	// -------------------------------------------------------------------
	// The machine
	// -------------------------------------------------------------------

	function dispatch(event: ReadingEvent) {
		const previous = state;
		const step = reduce(state, event);
		state = step.state;
		for (const command of step.commands) run(command, previous);
		if (previous.status === "waiting" && state.status !== "waiting")
			stopRecovery();
		if (state.status === "idle") deactivate();
		else activate();
		publish();
	}

	function run(command: ReadingCommand, previous: ReadingState) {
		switch (command.kind) {
			case "open":
				void openSession(command.messageId, command.from, previous);
				return;
			case "close":
				openToken += 1;
				closeSession();
				return;
			case "play":
				expectPause = false;
				void audio.play().catch(() => {});
				return;
			case "pause":
				if (!audio.paused) expectPause = true;
				audio.pause();
				return;
			case "report": {
				const sentence = reading?.script?.sentences[command.sentence];
				if (session && sentence)
					api.reportReadingPosition(session.id, sentence.id);
				return;
			}
			case "speed":
				audio.playbackRate = command.value;
				return;
			case "startTimer": {
				clearTimer(command.timer);
				const timer = command.timer;
				timers.set(
					timer,
					deps.setTimeout(() => {
						timers.delete(timer);
						dispatch({ type: TIMER_EVENTS[timer] } as ReadingEvent);
					}, READING_TIMER_MS[timer]),
				);
				return;
			}
			case "clearTimer":
				clearTimer(command.timer);
				return;
			case "awaitRecovery":
				startRecovery(command.from);
				return;
		}
	}

	function clearTimer(timer: ReadingTimer) {
		const handle = timers.get(timer);
		if (handle === undefined) return;
		deps.clearTimeout(handle);
		timers.delete(timer);
	}

	// -------------------------------------------------------------------
	// The reply and its script
	// -------------------------------------------------------------------

	function messageElement(id: string): Element | null {
		return deps.document.querySelector(`[data-message-id="${quoteId(id)}"]`);
	}

	function rootsOf(segmentIds: readonly string[]): Element[] | null {
		const roots: Element[] = [];
		for (const id of segmentIds) {
			const root = messageElement(id)?.querySelector(".markdown-container");
			if (!root) return null;
			roots.push(root);
		}
		return roots;
	}

	const codeBlocksOf = (roots: readonly Element[]) =>
		roots.flatMap((root) => [...root.querySelectorAll(".code-block, pre")]);

	function buildFor(
		target: Pick<Reading, "segmentIds" | "readBlockIndex">,
	): SpeechScript | null {
		const roots = rootsOf(target.segmentIds);
		if (!roots || !detect) return null;
		const readBlock =
			target.readBlockIndex === null
				? null
				: (codeBlocksOf(roots)[target.readBlockIndex] ?? null);
		return buildSpeechScript(roots, detect, {
			fallbackLanguage: deps.uiLanguage(),
			readBlock,
		});
	}

	function setScript(target: Reading, script: SpeechScript | null) {
		target.script = script;
		target.anchors = script
			? script.sentences.flatMap((sentence) => {
					const node = sentence.ranges[0]?.startContainer;
					return node ? [node] : [];
				})
			: [];
	}

	async function ensureDetector(): Promise<Detect> {
		detect ??= await deps.loadDetector();
		return detect;
	}

	/** A harmless re-render (evidence loading, a theme switch) replaces the text nodes: rebuild and go on, or stop if the words changed. */
	function checkStale() {
		if (!reading || state.status === "idle") return;
		for (const id of reading.segmentIds) {
			if (!messageElement(id)) {
				dispatch({ type: "stop" });
				return;
			}
		}
		const script = reading.script;
		if (!script || reading.anchors.every((node) => node.isConnected)) return;
		const rebuilt = buildFor(reading);
		const same =
			rebuilt !== null &&
			rebuilt.sentences.length === script.sentences.length &&
			rebuilt.sentences.every(
				(sentence, i) => sentence.text === script.sentences[i]?.text,
			);
		if (!same) {
			dispatch({ type: "stop" });
			return;
		}
		setScript(reading, rebuilt);
	}

	// -------------------------------------------------------------------
	// Sessions
	// -------------------------------------------------------------------

	async function openSession(
		messageId: string,
		from: number,
		previous: ReadingState,
	) {
		const token = ++openToken;
		closeSession();
		const sameReading =
			reading !== null &&
			reading.messageId === messageId &&
			!NO_READING.has(previous.status);
		if (starting && pending && pending.messageId === messageId) {
			const changed =
				!sameReading ||
				reading?.readBlockIndex !== pending.readBlockIndex ||
				pending.script !== null;
			if (changed) {
				if (!sameReading) defaultSpeedPending = true;
				reading = {
					...pending,
					charsPerSecond: reading?.charsPerSecond ?? DEFAULT_CHARS_PER_SECOND,
				};
			}
			pending = null;
		}
		const target = reading;
		if (!target || target.messageId !== messageId) {
			dispatch({ type: "stop" });
			return;
		}
		await ensureDetector();
		if (token !== openToken) return;
		if (!target.script) {
			setScript(target, buildFor(target));
			target.known = new Map();
		}
		const script = target.script;
		const sentences = script?.sentences.slice(from) ?? [];
		if (!script || sentences.length === 0) {
			dispatch({ type: "stop" });
			return;
		}
		let answer: ReadingStart;
		try {
			answer = await api.createReadingSession({
				conversationId: target.conversationId,
				messageId,
				sentences: sentences.map(toRequestSentence),
			});
		} catch (error) {
			if (token !== openToken) return;
			const serviceError =
				error instanceof ApiError && !error.serverUnavailable;
			const kind = await classify(serviceError);
			if (token === openToken) dispatch({ type: "sessionFailed", kind });
			return;
		}
		if (token !== openToken) {
			api.cancelReadingSession(answer.sessionId);
			return;
		}
		target.charsPerSecond = answer.charsPerSecond;
		session = {
			id: answer.sessionId,
			from,
			timeline: new SessionTimeline(script, from),
			events: null,
			failure: null,
		};
		if (defaultSpeedPending) {
			defaultSpeedPending = false;
			dispatch({ type: "speed", value: answer.defaultSpeed });
		}
		audio.src = api.readingAudioUrl(answer.sessionId);
		audio.playbackRate = state.speed;
		audio.preservesPitch = true;
		expectPause = false;
		void audio.play().catch(() => {});
		session.events = openEvents(session);
		publish();
	}

	function toRequestSentence(
		sentence: ScriptSentence,
	): ReadingRequestBody["sentences"][number] {
		return {
			id: sentence.id,
			language: sentence.language,
			paragraphStart: sentence.paragraphStart,
			words: sentence.words.map((word) => ({
				shown: word.shown,
				kind: word.kind,
				tokens: [...word.tokens],
			})),
		};
	}

	function closeSession() {
		const closing = session;
		session = null;
		lastLocate = null;
		expectPause = false;
		closing?.events?.close();
		if (!isUnlockClip() && audio.src !== "") {
			audio.removeAttribute("src");
			audio.load();
		}
		if (closing) api.cancelReadingSession(closing.id);
	}

	function openEvents(owner: Session): EventSourceLike {
		const events = deps.createEventSource(api.readingEventsUrl(owner.id));
		const mine = () => session === owner && owner.events === events;
		events.addEventListener("sentence", (event) => {
			const data = parseData(event);
			if (!mine() || !data || typeof data.id !== "string") return;
			if (typeof data.start === "number" && typeof data.end === "number") {
				owner.timeline.addSentence(data.id, data.start, data.end);
			}
		});
		events.addEventListener("words", (event) => {
			const data = parseData(event);
			if (
				!mine() ||
				!data ||
				typeof data.id !== "string" ||
				!Array.isArray(data.times)
			)
				return;
			owner.timeline.addWords(
				data.id,
				data.times as Array<[number, number] | null>,
			);
		});
		events.addEventListener("done", () => {
			if (!mine()) return;
			events.close();
			dispatch({ type: "done" });
		});
		events.addEventListener("replaced", () => {
			if (mine()) dispatch({ type: "replaced" });
		});
		events.addEventListener("error", (event) => {
			if (!mine()) return;
			const data = parseData(event);
			if (data !== null) {
				// The service's own `error` event, the stream's last: the voice failed at that
				// sentence. The audio made before it still reaches the player whole.
				events.close();
				owner.failure = {
					serviceError: true,
					sentenceId: typeof data.id === "string" ? data.id : null,
				};
				return;
			}
			// A stream that ended without `done` or `error` (an EventSource that gave up
			// reconnecting) is a stop. What was made still plays out first.
			if (events.readyState === EVENTSOURCE_CLOSED) {
				owner.failure ??= { serviceError: false, sentenceId: null };
			}
		});
		return events;
	}

	/**
	 * The audio ended (or could not play) before `done`: the reading broke. A failure the
	 * stream named lands here, after the audio made before it has played, at the sentence
	 * that failed; any other is asked of the browser and the server's health.
	 */
	async function landBreak() {
		const owner = session;
		if (!owner) return;
		const failure = owner.failure ?? { serviceError: false, sentenceId: null };
		const kind = await classify(failure.serviceError);
		if (session !== owner) return;
		const failed =
			failure.sentenceId === null
				? undefined
				: reading?.script?.sentences.find(
						(sentence) => sentence.id === failure.sentenceId,
					);
		if (failed && state.status === "playing" && failed.index > state.sentence) {
			dispatch({ type: "progress", sentence: failed.index, word: null });
		}
		fail(kind);
	}

	/** Before the first audio a failure is a failed start; after it, a break. */
	function fail(kind: BreakKind) {
		dispatch(
			state.status === "opening"
				? { type: "sessionFailed", kind }
				: { type: "broke", kind },
		);
	}

	async function classify(serviceError: boolean): Promise<BreakKind> {
		if (serviceError) return "voice";
		const online = deps.isOnline();
		const health = online ? (await deps.fetchHealth()).state : null;
		const kind = classifyBreak({ serviceError, online, health });
		if (kind === "updating") deps.reportUpdateSign();
		return kind;
	}

	// -------------------------------------------------------------------
	// Recovery
	// -------------------------------------------------------------------

	function startRecovery(from: "offline" | "updating") {
		stopRecovery();
		if (from === "offline") {
			const onOnline = () => {
				stopRecovery();
				dispatch({ type: "recovered" });
			};
			deps.window.addEventListener("online", onOnline);
			endRecovery = () => deps.window.removeEventListener("online", onOnline);
			return;
		}
		let ended = false;
		let handle: unknown = null;
		const startedAt = deps.now();
		const poll = async () => {
			handle = null;
			const health = await deps.fetchHealth();
			if (ended) return;
			if (health.state === "up") {
				stopRecovery();
				dispatch({ type: "recovered" });
				return;
			}
			if (deps.now() - startedAt >= SERVER_UPDATE_WATCH_MAX_MS) {
				stopRecovery();
				dispatch({ type: "broke", kind: "voice" });
				return;
			}
			handle = deps.setTimeout(() => void poll(), SERVER_UPDATE_WATCH_POLL_MS);
		};
		handle = deps.setTimeout(() => void poll(), SERVER_UPDATE_WATCH_POLL_MS);
		endRecovery = () => {
			ended = true;
			if (handle !== null) deps.clearTimeout(handle);
		};
	}

	function stopRecovery() {
		const end = endRecovery;
		endRecovery = null;
		end?.();
	}

	// -------------------------------------------------------------------
	// The page, the audio and the frame loop
	// -------------------------------------------------------------------

	const onOffline = () => {
		if (state.status === "playing" || state.status === "seeking")
			dispatch({ type: "broke", kind: "offline" });
	};
	const onVisibility = () => {
		if (deps.isHidden()) dispatch({ type: "hidden" });
	};

	function activate() {
		if (active) return;
		active = true;
		deps.window.addEventListener("offline", onOffline);
		deps.document.addEventListener("visibilitychange", onVisibility);
		stopObserving = deps.observe(deps.document.body, () => checkStale());
		frame = deps.requestFrame(tick);
	}

	function deactivate() {
		if (!active) return;
		active = false;
		deps.window.removeEventListener("offline", onOffline);
		deps.document.removeEventListener("visibilitychange", onVisibility);
		stopObserving?.();
		stopObserving = null;
		if (frame !== null) deps.cancelFrame(frame);
		frame = null;
		stopRecovery();
		for (const timer of [...timers.keys()]) clearTimer(timer);
	}

	function tick() {
		frame = null;
		if (!active) return;
		checkStale();
		if (state.status === "playing" && session) {
			const at = session.timeline.locate(audio.currentTime);
			if (at) {
				lastLocate = at;
				dispatch({ type: "progress", sentence: at.sentence, word: at.word });
			}
		}
		publish();
		if (active) frame = deps.requestFrame(tick);
	}

	audio.addEventListener("playing", () => {
		if (!hasSessionAudio()) return;
		expectPause = false;
		if (state.status === "opening" || state.status === "seeking")
			dispatch({ type: "firstAudio" });
	});
	audio.addEventListener("pause", () => {
		if (!hasSessionAudio() || audio.ended) return;
		if (expectPause) {
			expectPause = false;
			return;
		}
		if (state.status === "playing") dispatch({ type: "interrupted" });
	});
	audio.addEventListener("ended", () => {
		if (!hasSessionAudio()) return;
		if (state.doneReceived && !session?.failure) dispatch({ type: "ended" });
		else void landBreak();
	});
	audio.addEventListener("error", () => {
		if (hasSessionAudio()) void landBreak();
	});

	// -------------------------------------------------------------------
	// The view
	// -------------------------------------------------------------------

	function publish() {
		const script = reading?.script ?? null;
		if (session)
			for (const [index, seconds] of session.timeline.durations())
				reading?.known.set(index, seconds);
		const known = reading?.known ?? new Map<number, number>();
		const rates = reading?.charsPerSecond ?? DEFAULT_CHARS_PER_SECOND;
		const speed = state.speed > 0 ? state.speed : 1;
		const total = script
			? estimateSeconds(script, known, rates)
			: { seconds: 0, estimate: false };
		let elapsed = 0;
		if (script) {
			const sameAudio =
				session !== null &&
				(state.status === "playing" ||
					(state.status === "paused" && !state.restartOnResume));
			elapsed = sameAudio
				? estimateSeconds(script, known, rates, session?.from).seconds +
					audio.currentTime
				: estimateSeconds(script, known, rates, state.sentence).seconds;
		}
		if (state.status === "finished") elapsed = total.seconds;
		const within =
			lastLocate && lastLocate.sentence === state.sentence
				? lastLocate.within
				: 0;
		const progress =
			state.status === "finished"
				? 1
				: script
					? shareAt(script, state.sentence, within)
					: 0;
		const current = script?.sentences[state.sentence];
		const target = state.drag
			? script?.sentences[state.drag.target]
			: undefined;
		const view: ReadAloudView = {
			status: state.status,
			messageId: state.messageId,
			segmentIds: state.status === "idle" ? [] : (reading?.segmentIds ?? []),
			sentence: state.sentence,
			count: script?.sentences.length ?? 0,
			notches: script ? notches(script) : [],
			progress,
			elapsed: formatClock(elapsed / speed),
			total: formatClock(total.seconds / speed),
			totalIsEstimate: total.estimate,
			speed: state.speed,
			failure: state.failure,
			busy: state.busy,
			drag: state.drag?.target ?? null,
			marks:
				state.status === "idle" || !current
					? null
					: {
							sentence: uniqueRanges(current.ranges),
							word:
								state.word === null
									? null
									: (current.ranges[state.word] ?? null),
							target: target ? uniqueRanges(target.ranges) : [],
						},
		};
		const key = JSON.stringify([
			view.status,
			view.messageId,
			view.segmentIds,
			view.sentence,
			view.count,
			view.progress,
			view.elapsed,
			view.total,
			view.totalIsEstimate,
			view.speed,
			view.failure,
			view.busy,
			view.drag,
			state.word,
			script !== null && script === reading?.script ? script.totalChars : null,
		]);
		if (key === lastViewKey && view.marks?.sentence[0] === lastMarksAnchor)
			return;
		lastViewKey = key;
		lastMarksAnchor = view.marks?.sentence[0];
		deps.setView(view);
	}
	let lastMarksAnchor: Range | undefined;

	// -------------------------------------------------------------------
	// The surface
	// -------------------------------------------------------------------

	function unlock() {
		if (unlocked) return;
		unlocked = true;
		audio.src = silentMp3DataUri();
		void audio.play().catch(() => {});
	}

	function startWith(event: ReadingEvent) {
		starting = true;
		try {
			dispatch(event);
		} finally {
			starting = false;
		}
	}

	const count = () => reading?.script?.sentences.length ?? 0;
	const clamp = (i: number) =>
		Math.min(Math.max(0, Math.round(i)), Math.max(0, count() - 1));

	function focusSentence(index: number, mode: "center" | "reveal") {
		const sentence = reading?.script?.sentences[index];
		if (!sentence) return;
		const ranges = uniqueRanges(sentence.ranges);
		deps.requestFocus(() => unionRect(ranges), mode);
	}

	return {
		start(r) {
			unlock();
			const base: Reading = {
				conversationId: r.conversationId,
				messageId: r.messageId,
				segmentIds: [...r.segmentIds],
				readBlockIndex: null,
				script: null,
				anchors: [],
				known: new Map(),
				charsPerSecond: DEFAULT_CHARS_PER_SECOND,
			};
			const from = r.from;
			if (!from) {
				pending = base;
				startWith({ type: "press", messageId: r.messageId, from: 0 });
				return;
			}
			void (async () => {
				await ensureDetector();
				const roots = rootsOf(base.segmentIds);
				if (!roots) return;
				const element =
					from.node instanceof Element ? from.node : from.node.parentElement;
				const block = element?.closest(".code-block, pre") ?? null;
				const index = block ? codeBlocksOf(roots).indexOf(block) : -1;
				const candidate: Reading = {
					...base,
					readBlockIndex: index >= 0 ? index : null,
				};
				setScript(candidate, buildFor(candidate));
				if (!candidate.script) return;
				const sentence = sentenceAtPoint(
					candidate.script,
					from.node,
					from.offset,
				);
				if (sentence === null) return;
				pending = candidate;
				startWith({ type: "readFrom", messageId: r.messageId, from: sentence });
			})();
		},
		toggle: () => dispatch({ type: "toggle" }),
		seek: (i) => dispatch({ type: "seek", sentence: clamp(i) }),
		retry: () => dispatch({ type: "retry" }),
		beginDrag: () => dispatch({ type: "dragStart" }),
		dragTo(i) {
			const sentence = clamp(i);
			dispatch({ type: "dragMove", sentence });
			if (state.drag) focusSentence(sentence, "reveal");
		},
		endDrag: (i) => dispatch({ type: "dragEnd", sentence: clamp(i) }),
		setSpeed: (v) => dispatch({ type: "speed", value: v }),
		stop: () => dispatch({ type: "stop" }),
		locate: () => focusSentence(state.sentence, "center"),
		sentencePreview(i) {
			const script = reading?.script;
			const sentence = script?.sentences[i];
			if (!script || !sentence) return "";
			const words = sentence.words
				.filter((word) => word.kind !== "listNumber")
				.map((word) => word.range.toString().trim())
				.filter((word) => word !== "");
			const head = words.slice(0, 5).join(" ");
			return `${i + 1}/${script.sentences.length} · ${head}${words.length > 5 ? "…" : ""}`;
		},
		async assessReadability(segmentIds) {
			const roots = rootsOf(segmentIds);
			if (
				!roots ||
				roots.some((root) => (root.textContent ?? "").trim() === "")
			)
				return { kind: "unknown" };
			const script = buildSpeechScript(roots, await ensureDetector(), {
				fallbackLanguage: deps.uiLanguage(),
			});
			if (script.sentences.length > 0) return { kind: "ready" };
			if (script.missingLanguage !== null)
				return { kind: "noVoice", language: script.missingLanguage };
			return script.nothingToRead ? { kind: "nothing" } : { kind: "unknown" };
		},
	};
}

let singleton: ReadAloudController | null = null;

/** The browser's one controller, made on first use. */
export function getReadAloud(): ReadAloudController {
	singleton ??= createReadAloudController(browserDeps());
	return singleton;
}

/** Whether a reply can be read before anyone presses: the speaker is dimmed only when this says so. */
export function assessReadability(
	segmentIds: readonly string[],
): Promise<Readability> {
	return getReadAloud().assessReadability(segmentIds);
}

function browserDeps(): ReadAloudDeps {
	const audio = document.createElement("audio");
	audio.preload = "auto";
	return {
		audio,
		createEventSource: (url) => new EventSource(url),
		api: {
			createReadingSession,
			cancelReadingSession,
			reportReadingPosition,
			readingAudioUrl,
			readingEventsUrl,
		},
		loadDetector,
		document,
		window,
		isOnline: () => navigator.onLine,
		isHidden: () => document.visibilityState === "hidden",
		fetchHealth: () => fetchServerHealth(),
		reportUpdateSign: reportServerUpdateSign,
		setTimeout: (fn, ms) => window.setTimeout(fn, ms),
		clearTimeout: (handle) => window.clearTimeout(handle as number),
		requestFrame: (fn) => window.requestAnimationFrame(fn),
		cancelFrame: (handle) => window.cancelAnimationFrame(handle as number),
		now: () => performance.now(),
		uiLanguage: () => get(uiLanguage),
		setView: setReadAloudView,
		requestFocus: requestThreadFocus,
		observe: (target, onChange) => {
			const observer = new MutationObserver(onChange);
			observer.observe(target, {
				childList: true,
				subtree: true,
				characterData: true,
			});
			return () => observer.disconnect();
		},
	};
}
