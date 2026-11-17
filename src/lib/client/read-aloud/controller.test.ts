import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerHealth } from "$lib/client/api/health";
import { ApiError } from "$lib/client/api/http";
import type { ReadingStart } from "$lib/client/api/read-aloud";
import type { ReadAloudView } from "$lib/stores/read-aloud";
import {
	type AudioLike,
	createReadAloudController,
	type EventSourceLike,
	type ReadAloudController,
	type ReadAloudDeps,
} from "./controller";

class FakeAudio extends EventTarget implements AudioLike {
	src = "";
	currentTime = 0;
	playbackRate = 1;
	preservesPitch = false;
	paused = true;
	ended = false;
	readonly plays: string[] = [];
	play = vi.fn(async () => {
		this.plays.push(this.src);
		this.paused = false;
	});
	pause = vi.fn(() => {
		if (this.paused) return;
		this.paused = true;
		this.emit("pause");
	});
	load = vi.fn(() => {});
	removeAttribute(name: string) {
		if (name === "src") this.src = "";
	}
	emit(type: string) {
		this.dispatchEvent(new Event(type));
	}
}

/** The browser's Media Session: what the OS's media keys and Now Playing talk to. */
class FakeMediaSession {
	playbackState: "none" | "paused" | "playing" = "none";
	metadata: unknown = null;
	readonly handlers = new Map<string, (() => void) | null>();
	setActionHandler(action: string, handler: (() => void) | null) {
		this.handlers.set(action, handler);
	}
	/** The handlers set now, by action. */
	live(): string[] {
		return [...this.handlers].filter(([, h]) => h !== null).map(([a]) => a);
	}
}

class FakeEventSource extends EventTarget implements EventSourceLike {
	readyState = 0;
	closed = false;
	constructor(readonly url: string) {
		super();
	}
	close() {
		this.closed = true;
		this.readyState = 2;
	}
	send(name: string, data: unknown) {
		this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
	}
	fail(readyState: 0 | 2) {
		this.readyState = readyState;
		this.dispatchEvent(new Event("error"));
	}
}

const REPLY =
	"<p>The first sentence is here, and it is long enough to stand alone. The second one is here as well, and it is just as long as the first. The third one is the longest of them all by far, so it ends the reply.</p>";

function codeBlock(lines: string[]): string {
	const body = lines
		.map((line) => `<span class="line"><span>${line}</span></span>`)
		.join("\n");
	return `<div class="code-block" data-language="ts"><div class="code-header"><button type="button">ts</button></div><div class="code-body"><pre class="shiki"><code>${body}</code></pre></div></div>`;
}

function mountReply(id = "m1", html = REPLY): HTMLElement {
	const row = document.createElement("div");
	row.setAttribute("data-message-id", id);
	row.innerHTML = `<div class="prose-container"><div class="markdown-container">${html}</div></div>`;
	document.body.append(row);
	return row;
}

/** Stub detector: German for German words, nothing for no letters, else English. */
const detect = (text: string) =>
	!/\p{L}/u.test(text)
		? ""
		: /\b(das|und|ist|nicht|die)\b/i.test(text)
			? "de"
			: "en";

const settle = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

const controllers: ReadAloudController[] = [];

function setup(
	options: {
		start?: Partial<ReadingStart>;
		health?: ServerHealth["state"];
		loadDetector?: ReadAloudDeps["loadDetector"];
	} = {},
) {
	const audio = new FakeAudio();
	const media = new FakeMediaSession();
	const sources: FakeEventSource[] = [];
	const views: ReadAloudView[] = [];
	const frames: Array<() => void> = [];
	let online = true;
	let hidden = false;
	let sessions = 0;
	const api = {
		createReadingSession: vi.fn(async (): Promise<ReadingStart> => {
			sessions += 1;
			return {
				sessionId: `x${sessions}`,
				defaultSpeed: 1,
				charsPerSecond: { en: 15, hu: 15 },
				...options.start,
			};
		}),
		cancelReadingSession: vi.fn(),
		reportReadingPosition: vi.fn(),
		readingAudioUrl: (id: string) => `/audio/${id}`,
		readingEventsUrl: (id: string) => `/events/${id}`,
	};
	const win = new EventTarget();
	const fetchHealth = vi.fn(
		async (): Promise<ServerHealth> => ({ state: options.health ?? "up" }),
	);
	const deps: ReadAloudDeps = {
		audio,
		createEventSource: (url) => {
			const source = new FakeEventSource(url);
			sources.push(source);
			return source;
		},
		api,
		loadDetector: options.loadDetector ?? (async () => detect),
		document,
		window: win,
		isOnline: () => online,
		isHidden: () => hidden,
		fetchHealth,
		reportUpdateSign: vi.fn(),
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (handle) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>),
		requestFrame: (fn) => frames.push(fn),
		cancelFrame: () => {},
		now: () => Date.now(),
		uiLanguage: () => "en",
		setView: (view) => views.push(view),
		requestFocus: vi.fn(),
		observe: () => () => {},
		mediaSession: media,
	};
	const controller = createReadAloudController(deps);
	controllers.push(controller);
	const runFrame = () => {
		const queued = frames.splice(0);
		for (const fn of queued) fn();
	};
	return {
		controller,
		audio,
		media,
		sources,
		views,
		api,
		deps,
		win,
		fetchHealth,
		runFrame,
		last: () => views[views.length - 1] as ReadAloudView,
		setOnline: (value: boolean) => {
			online = value;
		},
		setHidden: (value: boolean) => {
			hidden = value;
		},
		body: (call = 0) =>
			(
				api.createReadingSession.mock.calls as unknown as Array<
					[
						{
							sentences: Array<{
								id: string;
								words: Array<{ shown: string; kind: string; tokens: string[] }>;
							}>;
						},
					]
				>
			)[call]?.[0],
	};
}

type Setup = ReturnType<typeof setup>;

const start = (
	t: Setup,
	messageId = "m1",
	from?: { node: Node; offset: number },
) =>
	t.controller.start({
		conversationId: "c1",
		messageId,
		segmentIds: [messageId],
		from,
	});

async function playing(t: Setup) {
	start(t);
	await settle();
	t.audio.emit("playing");
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const controller of controllers.splice(0)) controller.stop();
	vi.useRealTimers();
	document.body.innerHTML = "";
});

describe("the reading controller", () => {
	it("unlocks the audio element before it waits for anything", async () => {
		const t = setup();
		mountReply();
		start(t);
		expect(t.audio.plays).toHaveLength(1);
		expect(t.audio.plays[0]).toMatch(/^data:audio\/mpeg;base64,/);
		expect(t.api.createReadingSession).not.toHaveBeenCalled();
		await settle();
		expect(t.audio.src).toBe("/audio/x1");
		t.controller.stop();
		start(t);
		await settle();
		expect(t.audio.plays.filter((src) => src.startsWith("data:"))).toHaveLength(
			1,
		);
	});

	it("ignores media events of the unlock clip", async () => {
		const t = setup();
		mountReply();
		start(t);
		t.audio.emit("playing");
		t.audio.emit("pause");
		t.audio.emit("ended");
		t.audio.emit("error");
		expect(t.last().status).toBe("opening");
		expect(t.fetchHealth).not.toHaveBeenCalled();
		await settle();
		t.audio.emit("playing");
		expect(t.last().status).toBe("playing");
	});

	it("opens a session from the pressed sentence and plays its audio", async () => {
		const t = setup();
		mountReply();
		start(t);
		expect(t.last()).toMatchObject({
			status: "opening",
			key: "m1",
			segmentIds: ["m1"],
		});
		await settle();
		expect(t.api.createReadingSession).toHaveBeenCalledTimes(1);
		const body = t.body() as unknown as {
			conversationId: string;
			messageId: string;
			sentences: Array<Record<string, unknown>>;
		};
		expect(body.conversationId).toBe("c1");
		expect(body.messageId).toBe("m1");
		expect(body.sentences.map((s) => s.id)).toEqual(["s0", "s1", "s2"]);
		expect(body.sentences[0]).toEqual({
			id: "s0",
			language: "en",
			paragraphStart: true,
			words: [
				"The",
				"first",
				"sentence",
				"is",
				"here,",
				"and",
				"it",
				"is",
				"long",
				"enough",
				"to",
				"stand",
				"alone.",
			].map((word) => ({ shown: word, kind: "prose", tokens: [word] })),
		});
		expect(t.audio).toMatchObject({
			src: "/audio/x1",
			playbackRate: 1,
			preservesPitch: true,
		});
		expect(t.audio.plays.at(-1)).toBe("/audio/x1");
		expect(t.sources[0]?.url).toBe("/events/x1");
		t.audio.emit("playing");
		expect(t.last()).toMatchObject({
			status: "playing",
			count: 3,
			sentence: 0,
			busy: false,
		});
		expect(
			t
				.last()
				.marks?.sentence.map((range) => range.toString())
				.join(" "),
		).toBe("The first sentence is here, and it is long enough to stand alone.");
		expect(t.last().notches[0]).toBe(0);
	});

	it("starts from the sentence holding a selection's start, inside a long code block too", async () => {
		const t = setup();
		const row = mountReply(
			"m1",
			`${REPLY}${codeBlock(["const secretCode = 42;", "let a = 1;", "let b = 2;", "let c = 3;", "let d = 4;"])}`,
		);
		const text = row.querySelector("p")?.firstChild as Text;
		start(t, "m1", { node: text, offset: text.data.indexOf("second") });
		await settle();
		expect(t.body(0)?.sentences.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect(t.last()).toMatchObject({ status: "opening", sentence: 1 });
		t.controller.stop();
		const code = row.querySelector("pre span.line span")?.firstChild as Text;
		start(t, "m1", { node: code, offset: 0 });
		await settle();
		const body = t.body(1);
		expect(body?.sentences[0]?.words[0]?.kind).toBe("code");
		expect(
			body?.sentences.flatMap((s) => s.words.flatMap((w) => w.tokens)),
		).toContain("secret");
	});

	it("Read from here after the last word reads the last sentence, never nothing (early review R23)", async () => {
		const t = setup();
		const row = mountReply("m1", `${REPLY.replace("</p>", " 🙂</p>")}`);
		const text = row.querySelector("p")?.firstChild as Text;
		start(t, "m1", { node: text, offset: text.data.length });
		await settle();
		expect(t.body(0)?.sentences.map((s) => s.id)).toEqual(["s2"]);
		expect(t.last()).toMatchObject({ status: "opening", sentence: 2 });
	});

	it("Read from here sends a whole written sentence first: mid-sentence, or a single word", async () => {
		const t = setup();
		const clause =
			"the dough rests in a warm bowl under a clean towel for about an hour";
		const row = mountReply(
			"m1",
			`<p>A short opener comes first. First ${clause}, then ${clause}, and after that ${clause}, until it rises at last.</p>`,
		);
		const text = row.querySelector("p")?.firstChild as Text;
		const firstWords = (index: number) =>
			t
				.body(index)
				?.sentences[0]?.words.slice(0, 2)
				.map((word) => word.shown);
		// A selection that starts mid-sentence, in the part the voice would get last.
		start(t, "m1", { node: text, offset: text.data.indexOf("until") });
		await settle();
		expect(firstWords(0)).toEqual(["First", "the"]);
		t.controller.stop();
		// A one-word selection in the same part.
		start(t, "m1", { node: text, offset: text.data.indexOf("rises") });
		await settle();
		expect(firstWords(1)).toEqual(["First", "the"]);
	});

	it("a speaker press resumes a reading begun by Read from here in a long code block where it was", async () => {
		const t = setup();
		const row = mountReply(
			"m1",
			`${REPLY}${codeBlock(["const one = 1;", "const two = 2;", "const three = 3;", "const four = 4;", "const five = 5;"])}<p>And the text after the code goes on here.</p>`,
		);
		const third = row.querySelectorAll("pre span.line span")[2]
			?.firstChild as Text;
		start(t, "m1", { node: third, offset: 0 });
		await settle();
		const first = t.body(0)?.sentences[0]?.id;
		expect(t.body(0)?.sentences[0]?.words[0]?.kind).toBe("code");
		t.audio.emit("playing");
		t.controller.toggle();
		vi.advanceTimersByTime(30_000);
		expect(t.last()).toMatchObject({ status: "paused" });
		// The reply's own speaker resumes it: the same script, at the same sentence.
		start(t);
		await settle();
		expect(t.api.createReadingSession).toHaveBeenCalledTimes(2);
		expect(t.body(1)?.sentences[0]?.id).toBe(first);
		expect(t.last().status).toBe("seeking");
	});

	it("marks inline code above the code's own background, and clears it after a stop", async () => {
		const registry = new Map<string, { ranges: Range[] }>();
		class FakeHighlight {
			priority = 0;
			readonly ranges: Range[];
			constructor(...ranges: Range[]) {
				this.ranges = ranges;
			}
		}
		vi.stubGlobal("CSS", { highlights: registry });
		vi.stubGlobal("Highlight", FakeHighlight);
		try {
			const t = setup();
			mountReply(
				"m1",
				"<p>Then call <code>getUserName()</code> to read it.</p>",
			);
			await playing(t);
			// Inline code is tinted whole by an attribute (code-marks.ts), not a highlight.
			const code = document.querySelector("code") as HTMLElement;
			expect(code.getAttribute("data-read-aloud-code-mark")).toBe("sentence");
			expect(registry.size).toBe(0);
			t.controller.stop();
			await vi.waitFor(() =>
				expect(code.hasAttribute("data-read-aloud-code-mark")).toBe(false),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("reports the position when the sentence changes", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		const events = t.sources[0] as FakeEventSource;
		events.send("sentence", { id: "s0", start: 0.025, end: 1.0 });
		events.send("sentence", { id: "s1", start: 1.3, end: 2.5 });
		t.audio.currentTime = 0.5;
		t.runFrame();
		expect(t.api.reportReadingPosition).not.toHaveBeenCalled();
		t.audio.currentTime = 1.5;
		t.runFrame();
		expect(t.api.reportReadingPosition).toHaveBeenCalledWith("x1", "s1");
		expect(t.last().sentence).toBe(1);
		expect(t.last().progress).toBeGreaterThan(t.last().notches[1] as number);
	});

	it("marks the spoken word once its times arrive", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		const events = t.sources[0] as FakeEventSource;
		events.send("sentence", { id: "s0", start: 0.025, end: 2.0 });
		t.audio.currentTime = 0.6;
		t.runFrame();
		expect(t.last().marks?.word).toBeNull();
		events.send("words", {
			id: "s0",
			times: [
				[0.025, 0.3],
				[0.35, 0.7],
				[0.75, 1.2],
				[1.25, 1.5],
				[1.55, 2.0],
			],
		});
		t.runFrame();
		expect(t.last().marks?.word?.toString()).toBe("first");
	});

	it("classifies a broken stream as offline, an update or the voice", async () => {
		const offline = setup();
		mountReply();
		await playing(offline);
		offline.setOnline(false);
		offline.audio.emit("error");
		await settle();
		expect(offline.fetchHealth).not.toHaveBeenCalled();
		expect(offline.last()).toMatchObject({
			status: "waiting",
			failure: "offline",
		});
		offline.controller.stop();
		document.body.innerHTML = "";

		const update = setup({ health: "draining" });
		mountReply();
		await playing(update);
		update.audio.emit("error");
		await settle();
		expect(update.last()).toMatchObject({
			status: "waiting",
			failure: "updating",
		});
		expect(update.deps.reportUpdateSign).toHaveBeenCalled();
		update.controller.stop();
		document.body.innerHTML = "";

		const voice = setup();
		mountReply();
		await playing(voice);
		(voice.sources[0] as FakeEventSource).send("error", {
			id: "s0",
			code: "synthesis_failed",
		});
		await settle();
		expect(voice.sources[0]?.closed).toBe(true);
		// The audio made before the failure plays out first.
		expect(voice.last().status).toBe("playing");
		voice.audio.ended = true;
		voice.audio.emit("ended");
		await settle();
		expect(voice.fetchHealth).not.toHaveBeenCalled();
		expect(voice.last()).toMatchObject({ status: "stopped", failure: "voice" });
		voice.controller.stop();
		document.body.innerHTML = "";

		// The audio ending before the service said `done` is a break, and the health check names it.
		const early = setup();
		mountReply();
		await playing(early);
		early.audio.ended = true;
		early.audio.emit("pause");
		early.audio.emit("ended");
		await settle();
		expect(early.fetchHealth).toHaveBeenCalledTimes(1);
		expect(early.last()).toMatchObject({ status: "stopped", failure: "voice" });
	});

	it("an events stream that ends without done or error is a break", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		// A reconnect in progress is not a break.
		(t.sources[0] as FakeEventSource).fail(0);
		await settle();
		expect(t.last().status).toBe("playing");
		(t.sources[0] as FakeEventSource).fail(2);
		await settle();
		// What was made still plays; the stop lands when the audio ends.
		expect(t.last().status).toBe("playing");
		t.audio.ended = true;
		t.audio.emit("ended");
		await settle();
		expect(t.last()).toMatchObject({ status: "stopped", failure: "voice" });
	});

	it("plays out the audio made before a failure, then stops at the failing sentence", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		const events = t.sources[0] as FakeEventSource;
		events.send("sentence", { id: "s0", start: 0.025, end: 1.0 });
		events.send("error", { id: "s1", code: "synthesis_failed" });
		t.audio.currentTime = 0.5;
		t.runFrame();
		expect(t.last()).toMatchObject({ status: "playing", sentence: 0 });
		t.audio.ended = true;
		t.audio.emit("ended");
		await settle();
		expect(t.last()).toMatchObject({
			status: "stopped",
			failure: "voice",
			sentence: 1,
		});
		t.controller.retry();
		await settle();
		expect(t.body(1)?.sentences[0]?.id).toBe("s1");
	});

	it("a press a later press overtook on the server (409 superseded) ends quietly, with no note", async () => {
		// Track A's R5: the session route answers the earlier of two quick presses of one
		// person (here, or in another tab) with 409 superseded; the later one carries on.
		const t = setup();
		mountReply();
		t.api.createReadingSession.mockRejectedValueOnce(
			new ApiError("superseded", { status: 409 }),
		);
		start(t);
		await settle();
		expect(t.last().status).toBe("idle");
		expect(t.fetchHealth).not.toHaveBeenCalled();
	});

	it("fails to start when the service refuses, and while opening an error event fails the start", async () => {
		const t = setup();
		mountReply();
		t.api.createReadingSession.mockRejectedValueOnce(
			new ApiError("voice_unavailable", { status: 503 }),
		);
		start(t);
		await settle();
		expect(t.last().status).toBe("startFailed");
		expect(t.fetchHealth).not.toHaveBeenCalled();
		vi.advanceTimersByTime(3000);
		expect(t.last().status).toBe("idle");
		start(t);
		await settle();
		(t.sources[0] as FakeEventSource).send("error", {
			id: "s0",
			code: "zonos_unavailable",
		});
		// No audio was made: the empty stream fails to play, and the start fails.
		t.audio.emit("error");
		await settle();
		expect(t.last().status).toBe("startFailed");
		expect(t.fetchHealth).not.toHaveBeenCalled();
	});

	it("resumes by itself when the browser is back online", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		const events = t.sources[0] as FakeEventSource;
		events.send("sentence", { id: "s0", start: 0.025, end: 1.0 });
		events.send("sentence", { id: "s1", start: 1.3, end: 2.5 });
		t.audio.currentTime = 1.5;
		t.runFrame();
		t.setOnline(false);
		t.win.dispatchEvent(new Event("offline"));
		expect(t.last()).toMatchObject({
			status: "waiting",
			failure: "offline",
			sentence: 1,
		});
		expect(t.api.cancelReadingSession).toHaveBeenCalledWith("x1");
		expect(events.closed).toBe(true);
		t.setOnline(true);
		t.win.dispatchEvent(new Event("online"));
		await settle();
		expect(t.last().status).toBe("seeking");
		expect(t.body(1)?.sentences[0]?.id).toBe("s1");
		t.audio.emit("playing");
		expect(t.last().status).toBe("playing");
	});

	it("an update waits, polls health, and gives up after eight minutes", async () => {
		const t = setup({ health: "draining" });
		mountReply();
		await playing(t);
		t.audio.emit("error");
		await settle();
		expect(t.last()).toMatchObject({ status: "waiting", failure: "updating" });
		await vi.advanceTimersByTimeAsync(9000);
		expect(t.fetchHealth.mock.calls.length).toBeGreaterThanOrEqual(3);
		await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
		expect(t.last()).toMatchObject({ status: "stopped", failure: "voice" });
		const polls = t.fetchHealth.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(t.fetchHealth.mock.calls.length).toBe(polls);
	});

	it("an update waits, and resumes when the server is back", async () => {
		const t = setup({ health: "draining" });
		mountReply();
		await playing(t);
		t.audio.emit("error");
		await settle();
		t.fetchHealth.mockResolvedValue({ state: "up" });
		await vi.advanceTimersByTimeAsync(3000);
		await settle();
		expect(t.last().status).toBe("seeking");
		expect(t.api.createReadingSession).toHaveBeenCalledTimes(2);
	});

	it("rebuilds the script when its nodes are replaced but the text is the same", async () => {
		const t = setup();
		const row = mountReply();
		await playing(t);
		const paragraph = row.querySelector("p") as HTMLElement;
		const before = t.last().marks?.sentence[0];
		const html = paragraph.innerHTML;
		paragraph.innerHTML = html;
		// Ranges are live: the old one has collapsed onto the paragraph, so it no longer marks a word.
		expect(before?.toString()).toBe("");
		t.runFrame();
		expect(t.last().status).toBe("playing");
		const after = t.last().marks?.sentence[0];
		expect(after?.startContainer.nodeType).toBe(Node.TEXT_NODE);
		expect(after?.startContainer.isConnected).toBe(true);
		expect(after?.toString()).toBe("The");
		expect(t.api.cancelReadingSession).not.toHaveBeenCalled();
		paragraph.textContent = "Something else entirely is written here now.";
		t.runFrame();
		expect(t.last().status).toBe("idle");
		expect(t.api.cancelReadingSession).toHaveBeenCalledWith("x1");
	});

	it("stops when the reply being read leaves the page", async () => {
		const t = setup();
		const row = mountReply();
		await playing(t);
		row.remove();
		t.runFrame();
		expect(t.last()).toMatchObject({ status: "idle", marks: null });
		expect(t.api.cancelReadingSession).toHaveBeenCalledWith("x1");
		expect(t.sources[0]?.closed).toBe(true);
		expect(t.audio.src).toBe("");
	});

	it("a replaced reading ends quietly", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		(t.sources[0] as FakeEventSource).send("replaced", {});
		expect(t.last()).toMatchObject({ status: "idle", failure: null });
	});

	it("pauses when the page is hidden, and play restarts at that sentence", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		t.setHidden(true);
		document.dispatchEvent(new Event("visibilitychange"));
		expect(t.last().status).toBe("paused");
		expect(t.api.cancelReadingSession).toHaveBeenCalledWith("x1");
		t.setHidden(false);
		t.controller.toggle();
		await settle();
		expect(t.last().status).toBe("seeking");
		expect(t.body(1)?.sentences[0]?.id).toBe("s0");
	});

	it("a hidden page that follows an interruption gives the session up, and play restarts at the sentence (early review R14)", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		t.audio.paused = true;
		t.audio.emit("pause");
		expect(t.last().status).toBe("paused");
		expect(t.api.cancelReadingSession).not.toHaveBeenCalled();
		t.setHidden(true);
		document.dispatchEvent(new Event("visibilitychange"));
		expect(t.last().status).toBe("paused");
		expect(t.api.cancelReadingSession).toHaveBeenCalledWith("x1");
		// The long-pause timer has nothing left to do.
		vi.advanceTimersByTime(31_000);
		expect(t.api.cancelReadingSession).toHaveBeenCalledTimes(1);
		t.setHidden(false);
		t.controller.toggle();
		await settle();
		expect(t.last().status).toBe("seeking");
		expect(t.body(1)?.sentences[0]?.id).toBe("s0");
	});

	it("an interruption pauses, and play resumes the same audio", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		t.audio.paused = true;
		t.audio.emit("pause");
		expect(t.last().status).toBe("paused");
		t.controller.toggle();
		expect(t.last().status).toBe("playing");
		expect(t.api.createReadingSession).toHaveBeenCalledTimes(1);
		// A pause the controller asked for is not an interruption.
		t.controller.toggle();
		expect(t.audio.pause).toHaveBeenCalled();
		expect(t.last().status).toBe("paused");
	});

	it("done keeps the events open and never cancels; the end shows Finished, then closes them", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		const events = t.sources[0] as FakeEventSource;
		events.send("done", {});
		// `done` is synthesis finished, not playback: the stream stays, so a reading another
		// tab starts meanwhile still reaches this one (early review R7).
		expect(events.closed).toBe(false);
		expect(t.api.cancelReadingSession).not.toHaveBeenCalled();
		expect(t.last().status).toBe("playing");
		t.audio.ended = true;
		t.audio.emit("pause");
		t.audio.emit("ended");
		expect(t.last()).toMatchObject({ status: "finished", progress: 1 });
		expect(events.closed).toBe(false);
		vi.advanceTimersByTime(1100);
		expect(t.last().status).toBe("idle");
		// The reading is over: closing the stream is what lets the server close it, so
		// there is nothing to cancel (a DELETE of it would be a 404).
		expect(events.closed).toBe(true);
		expect(t.api.cancelReadingSession).not.toHaveBeenCalled();
		expect(t.audio.src).toBe("");
	});

	it("a reading another tab replaces after done ends quietly, and the server's closed session is not cancelled", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		const events = t.sources[0] as FakeEventSource;
		events.send("done", {});
		events.send("replaced", {});
		expect(t.last()).toMatchObject({ status: "idle", failure: null });
		expect(t.api.cancelReadingSession).not.toHaveBeenCalled();
		expect(events.closed).toBe(true);
		expect(t.audio.src).toBe("");
		expect(t.audio.paused).toBe(true);
		// Nothing wakes it again.
		t.audio.paused = false;
		t.audio.emit("play");
		expect(t.audio.paused).toBe(true);
	});

	it("an events stream that ends after done is not a break: the reading finishes", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		const events = t.sources[0] as FakeEventSource;
		events.send("done", {});
		// The server closed the stream when it ended the reading (and a reconnect found nothing).
		events.fail(0);
		events.fail(2);
		await settle();
		expect(t.last().status).toBe("playing");
		t.audio.ended = true;
		t.audio.emit("pause");
		t.audio.emit("ended");
		await settle();
		expect(t.last()).toMatchObject({ status: "finished", failure: null });
		expect(t.fetchHealth).not.toHaveBeenCalled();
	});

	it("the end takes the marks away while Finished shows (they fade)", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		expect(t.last().marks).not.toBeNull();
		(t.sources[0] as FakeEventSource).send("done", {});
		t.audio.ended = true;
		t.audio.emit("pause");
		t.audio.emit("ended");
		expect(t.last()).toMatchObject({ status: "finished", marks: null });
	});

	it("a new reading starts at the default speed, and a jump keeps the person's speed", async () => {
		const t = setup({ start: { defaultSpeed: 1.25 } });
		mountReply();
		await playing(t);
		expect(t.audio.playbackRate).toBe(1.25);
		expect(t.last().speed).toBe(1.25);
		t.controller.setSpeed(1.5);
		expect(t.audio.playbackRate).toBe(1.5);
		t.controller.seek(2);
		await settle();
		expect(t.body(1)?.sentences[0]?.id).toBe("s2");
		expect(t.audio.playbackRate).toBe(1.5);
		expect(t.last().speed).toBe(1.5);
	});

	describe("nothing plays once a reading is over (the owner's replay on staging)", () => {
		it("a stop, the end and a replacement each tear the audio down", async () => {
			const t = setup();
			mountReply();
			await playing(t);
			t.controller.stop();
			expect(t.audio.src).toBe("");
			expect(t.audio.paused).toBe(true);
			expect(t.audio.load).toHaveBeenCalled();
			await playing(t);
			(t.sources.at(-1) as FakeEventSource).send("done", {});
			t.audio.ended = true;
			t.audio.emit("pause");
			t.audio.emit("ended");
			vi.advanceTimersByTime(1100);
			expect(t.last().status).toBe("idle");
			expect(t.audio.src).toBe("");
		});

		it("a play the reading did not ask for is stopped at once: paused, or over", async () => {
			const t = setup();
			mountReply();
			await playing(t);
			t.controller.toggle();
			expect(t.last().status).toBe("paused");
			// The browser resumes the element by itself: a media key, Now Playing, headphones.
			t.audio.paused = false;
			t.audio.emit("play");
			expect(t.audio.paused).toBe(true);
			expect(t.last().status).toBe("paused");
			t.controller.stop();
			t.audio.paused = false;
			t.audio.emit("play");
			expect(t.audio.paused).toBe(true);
			expect(t.last().status).toBe("idle");
		});

		it("holds the Media Session while it reads, routes its keys to the reading, and lets it go at the end", async () => {
			const t = setup();
			mountReply();
			expect(t.media.playbackState).toBe("none");
			await playing(t);
			expect(t.media.playbackState).toBe("playing");
			expect(t.media.live().sort()).toEqual(["pause", "play", "stop"]);
			t.media.handlers.get("pause")?.();
			expect(t.last().status).toBe("paused");
			expect(t.media.playbackState).toBe("paused");
			t.media.handlers.get("play")?.();
			expect(t.last().status).toBe("playing");
			expect(t.media.playbackState).toBe("playing");
			t.media.handlers.get("stop")?.();
			expect(t.last().status).toBe("idle");
			expect(t.media.playbackState).toBe("none");
			expect(t.media.live()).toEqual([]);
			expect(t.media.metadata).toBeNull();
		});
	});

	it('spins the play button when the voice falls behind for over half a second (owner: "Yes, spin it")', async () => {
		const t = setup();
		mountReply();
		await playing(t);
		expect(t.last().buffering).toBe(false);
		// The audio waits for data mid-reading.
		t.audio.emit("waiting");
		vi.advanceTimersByTime(400);
		expect(t.last().buffering).toBe(false);
		vi.advanceTimersByTime(200);
		expect(t.last()).toMatchObject({ status: "playing", buffering: true });
		// The moment playback goes on, it stops.
		t.audio.emit("playing");
		expect(t.last().buffering).toBe(false);
		// A short wait never shows: no flicker.
		const seen = t.views.length;
		t.audio.emit("waiting");
		vi.advanceTimersByTime(300);
		t.audio.emit("playing");
		vi.advanceTimersByTime(1000);
		expect(t.views.slice(seen).some((view) => view.buffering)).toBe(false);
		// A stop ends it too.
		t.audio.emit("waiting");
		vi.advanceTimersByTime(600);
		expect(t.last().buffering).toBe(true);
		t.controller.stop();
		expect(t.last().buffering).toBe(false);
		vi.advanceTimersByTime(600);
		expect(t.last().buffering).toBe(false);
	});

	it("switches to another reply without leaving the player", async () => {
		const t = setup();
		mountReply("m1");
		mountReply("m2", "<p>Another reply is read from here on now.</p>");
		await playing(t);
		start(t, "m2");
		expect(t.last()).toMatchObject({ status: "seeking", key: "m2" });
		expect(t.api.cancelReadingSession).toHaveBeenCalledWith("x1");
		await settle();
		expect((t.body(1) as unknown as { messageId: string }).messageId).toBe(
			"m2",
		);
	});

	it("a switch shows the new reply's sentences from its first view", async () => {
		const t = setup();
		mountReply("m1");
		mountReply(
			"m2",
			"<p>Another reply is read from here on now. It has a second sentence too.</p>",
		);
		await playing(t);
		const before = t.views.length;
		start(t, "m2");
		await settle();
		const switched = t.views.slice(before).filter((view) => view.key === "m2");
		expect(switched.length).toBeGreaterThan(0);
		// Never "Sentence 0 of 0" in the player while the new reply's voice comes.
		expect(switched.map((view) => view.count)).not.toContain(0);
	});

	it("says where a sentence starts, for the scrubber's bubble", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		expect(t.controller.sentencePreview(1)).toBe(
			"2/3 · The second one is here…",
		);
		expect(t.controller.sentencePreview(2)).toBe("3/3 · The third one is the…");
	});

	it("a drag that starts while a jump loads still lands where it is let go (early review R15)", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		t.controller.seek(1);
		await settle();
		expect(t.last().status).toBe("seeking");
		expect(t.body(1)?.sentences[0]?.id).toBe("s1");
		// The finger goes down again before the jump's audio has come.
		t.controller.beginDrag();
		expect(t.audio.pause).toHaveBeenCalled();
		t.controller.dragTo(2);
		expect(t.last().drag).toBe(2);
		t.controller.endDrag(2);
		await settle();
		expect(t.last()).toMatchObject({
			status: "seeking",
			drag: null,
			sentence: 2,
		});
		expect(t.body(2)?.sentences[0]?.id).toBe("s2");
	});

	it("asks the thread to bring the sentence into view", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		t.controller.locate();
		expect(t.deps.requestFocus).toHaveBeenCalledWith(
			expect.any(Function),
			"center",
		);
		t.controller.beginDrag();
		t.controller.dragTo(2);
		expect(t.deps.requestFocus).toHaveBeenLastCalledWith(
			expect.any(Function),
			"reveal",
		);
		expect(t.last().drag).toBe(2);
		t.controller.endDrag(2);
		await settle();
		expect(t.body(1)?.sentences[0]?.id).toBe("s2");
	});
});

describe("assessReadability", () => {
	it("says whether a reply can be read before anyone presses", async () => {
		const t = setup();
		expect(await t.controller.assessReadability(["missing"])).toEqual({
			kind: "unknown",
		});
		mountReply("empty", "");
		expect(await t.controller.assessReadability(["empty"])).toEqual({
			kind: "unknown",
		});
		mountReply("m1");
		expect(await t.controller.assessReadability(["m1"])).toEqual({
			kind: "ready",
		});
		mountReply(
			"de",
			"<p>Das ist ein deutscher Absatz und die Stimme liest ihn nicht vor.</p>",
		);
		expect(await t.controller.assessReadability(["de"])).toEqual({
			kind: "noVoice",
			language: "de",
		});
		mountReply("code", codeBlock(["a();", "b();", "c();", "d();", "e();"]));
		expect(await t.controller.assessReadability(["code"])).toEqual({
			kind: "nothing",
		});
	});
});

describe("a detector that does not load (early review R16)", () => {
	const gone = () => new Error("Failed to fetch dynamically imported module");

	it("a press ends as a failed start at once, and tells the app its code may be out of date", async () => {
		const loadDetector = vi
			.fn<ReadAloudDeps["loadDetector"]>()
			.mockRejectedValueOnce(gone())
			.mockResolvedValue(detect);
		const t = setup({ loadDetector });
		mountReply();
		start(t);
		await settle();
		// No spinner for 20 s and no unhandled rejection: the start failed, now.
		expect(t.last().status).toBe("startFailed");
		expect(t.deps.reportUpdateSign).toHaveBeenCalledTimes(1);
		expect(t.api.createReadingSession).not.toHaveBeenCalled();
		// The load is tried again with the next press.
		start(t);
		await settle();
		expect(t.api.createReadingSession).toHaveBeenCalledTimes(1);
		t.audio.emit("playing");
		expect(t.last().status).toBe("playing");
	});

	it("Read from here does nothing but tell the app its code may be out of date", async () => {
		const loadDetector = vi
			.fn<ReadAloudDeps["loadDetector"]>()
			.mockRejectedValue(gone());
		const t = setup({ loadDetector });
		mountReply();
		const text = document.querySelector("p")?.firstChild as Text;
		start(t, "m1", { node: text, offset: 4 });
		await settle();
		expect(t.views.at(-1)?.status ?? "idle").toBe("idle");
		expect(t.deps.reportUpdateSign).toHaveBeenCalledTimes(1);
		expect(t.api.createReadingSession).not.toHaveBeenCalled();
	});

	it("a reply's readability is unknown, not a rejection, while the detector is missing", async () => {
		const loadDetector = vi
			.fn<ReadAloudDeps["loadDetector"]>()
			.mockRejectedValue(gone());
		const t = setup({ loadDetector });
		mountReply();
		await expect(t.controller.assessReadability(["m1"])).resolves.toEqual({
			kind: "unknown",
		});
	});
});

describe("a reply of more than 2,000 sentences (early review R21)", () => {
	const paragraphs = (count: number) =>
		Array.from(
			{ length: count },
			(_, i) =>
				`<p>Sentence number ${i} is written here, and it is long enough to stand alone.</p>`,
		).join("");

	it("is read in sessions of at most 2,000 sentences, the next one opening when one ends", async () => {
		const t = setup();
		mountReply("m1", paragraphs(2001));
		start(t);
		await settle();
		const first = t.body(0)?.sentences ?? [];
		expect(first).toHaveLength(2000);
		expect(first[0]?.id).toBe("s0");
		expect(first.at(-1)?.id).toBe("s1999");
		t.audio.emit("playing");
		expect(t.last()).toMatchObject({ status: "playing", count: 2001 });

		// The first session's audio ends after its last sentence: this is not the end.
		(t.sources[0] as FakeEventSource).send("done", {});
		t.audio.ended = true;
		t.audio.emit("pause");
		t.audio.emit("ended");
		await settle();
		expect(t.last().status).toBe("seeking");
		expect(t.api.createReadingSession).toHaveBeenCalledTimes(2);
		expect(t.body(1)?.sentences.map((sentence) => sentence.id)).toEqual([
			"s2000",
		]);
		// The player says where it is: the last sentence of the reply.
		expect(t.last().sentence).toBe(2000);

		t.audio.ended = false;
		t.audio.emit("playing");
		(t.sources[1] as FakeEventSource).send("done", {});
		t.audio.ended = true;
		t.audio.emit("pause");
		t.audio.emit("ended");
		await settle();
		expect(t.last()).toMatchObject({ status: "finished", progress: 1 });
		expect(t.api.createReadingSession).toHaveBeenCalledTimes(2);
	}, 30_000);

	it("a reply of exactly 2,000 sentences needs one session", async () => {
		const t = setup();
		mountReply("m1", paragraphs(2000));
		start(t);
		await settle();
		expect(t.body(0)?.sentences).toHaveLength(2000);
		t.audio.emit("playing");
		(t.sources[0] as FakeEventSource).send("done", {});
		t.audio.ended = true;
		t.audio.emit("pause");
		t.audio.emit("ended");
		await settle();
		expect(t.last().status).toBe("finished");
		expect(t.api.createReadingSession).toHaveBeenCalledTimes(1);
	}, 30_000);
});

describe("the marks (early review R22)", () => {
	it("are the same object while only the progress moves, and new when the sentence or the word does", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		const events = t.sources[0] as FakeEventSource;
		events.send("sentence", { id: "s0", start: 0.025, end: 2.0 });
		events.send("sentence", { id: "s1", start: 2.3, end: 4.0 });
		t.audio.currentTime = 0.4;
		t.runFrame();
		const first = t.last().marks;
		expect(first).not.toBeNull();
		const progress = t.last().progress;

		// No word times: the progress moves every frame, and the marks do not.
		t.audio.currentTime = 1.2;
		t.runFrame();
		expect(t.last().progress).toBeGreaterThan(progress);
		expect(t.last().marks).toBe(first);

		// A word is a new mark; the same word again is not.
		events.send("words", {
			id: "s0",
			times: [
				[0.025, 0.3],
				[0.35, 0.7],
				[0.75, 1.2],
				[1.25, 1.5],
				[1.55, 2.0],
			],
		});
		t.audio.currentTime = 0.5;
		t.runFrame();
		const word = t.last().marks;
		expect(word).not.toBe(first);
		expect(word?.word?.toString()).toBe("first");
		t.audio.currentTime = 0.6;
		t.runFrame();
		expect(t.last().marks).toBe(word);

		// A new sentence is new marks.
		t.audio.currentTime = 2.6;
		t.runFrame();
		expect(t.last().sentence).toBe(1);
		expect(t.last().marks).not.toBe(word);
	});
});
