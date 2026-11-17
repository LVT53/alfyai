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
	"<p>The first sentence is here. The second one is here. The third one is the longest of them all by far.</p>";

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
	} = {},
) {
	const audio = new FakeAudio();
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
		loadDetector: async () => detect,
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
								words: Array<{ kind: string; tokens: string[] }>;
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
			messageId: "m1",
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
				{ shown: "The", kind: "prose", tokens: ["The"] },
				{ shown: "first", kind: "prose", tokens: ["first"] },
				{ shown: "sentence", kind: "prose", tokens: ["sentence"] },
				{ shown: "is", kind: "prose", tokens: ["is"] },
				{ shown: "here.", kind: "prose", tokens: ["here."] },
			],
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
		).toBe("The first sentence is here.");
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

	it("marks words inside code with highlights, above the code's own background", async () => {
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
			expect(
				registry
					.get("read-aloud-code-sentence")
					?.ranges.map((r) => r.toString()),
			).toEqual(["getUserName()"]);
			t.controller.stop();
			expect(registry.size).toBe(0);
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

	it("done closes the events and never cancels; the end shows Finished, then closes", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		const events = t.sources[0] as FakeEventSource;
		events.send("done", {});
		expect(events.closed).toBe(true);
		expect(t.api.cancelReadingSession).not.toHaveBeenCalled();
		expect(t.last().status).toBe("playing");
		t.audio.ended = true;
		t.audio.emit("pause");
		t.audio.emit("ended");
		expect(t.last()).toMatchObject({ status: "finished", progress: 1 });
		vi.advanceTimersByTime(1100);
		expect(t.last().status).toBe("idle");
		expect(t.api.cancelReadingSession).toHaveBeenCalledWith("x1");
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

	it("switches to another reply without leaving the player", async () => {
		const t = setup();
		mountReply("m1");
		mountReply("m2", "<p>Another reply is read from here on now.</p>");
		await playing(t);
		start(t, "m2");
		expect(t.last()).toMatchObject({ status: "seeking", messageId: "m2" });
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
		const switched = t.views
			.slice(before)
			.filter((view) => view.messageId === "m2");
		expect(switched.length).toBeGreaterThan(0);
		// Never "Sentence 0 of 0" in the player while the new reply's voice comes.
		expect(switched.map((view) => view.count)).not.toContain(0);
	});

	it("says where a sentence starts, for the scrubber's bubble", async () => {
		const t = setup();
		mountReply();
		await playing(t);
		expect(t.controller.sentencePreview(1)).toBe(
			"2/3 · The second one is here.",
		);
		expect(t.controller.sentencePreview(2)).toBe("3/3 · The third one is the…");
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
