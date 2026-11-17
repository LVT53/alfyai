import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "$lib/client/api/http";
import type {
	BuiltInVoiceInfo,
	PreviewRender,
	PreviewRequestBody,
} from "$lib/client/api/read-aloud-voices";
import { silentMp3DataUri } from "$lib/shared/read-aloud/silent-mp3";
import { type Knobs, ZERO_KNOBS } from "$lib/shared/read-aloud/voice-knobs";
import { VOICE_SAMPLES } from "$lib/shared/read-aloud/voice-samples";
import type { VoicePreviewView } from "$lib/stores/read-aloud";
import type { AudioLike } from "./controller";
import {
	createVoicePreview,
	listenSound,
	type PreviewSound,
	type VoicePreview,
} from "./voice-preview";

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
		this.ended = false;
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

type Pending = {
	body: PreviewRequestBody;
	signal: AbortSignal;
	resolve: (render: PreviewRender) => void;
	reject: (error: unknown) => void;
};

const made: VoicePreview[] = [];

function setup() {
	const audio = new FakeAudio();
	const renders: Pending[] = [];
	const render = vi.fn(
		(body: PreviewRequestBody, signal: AbortSignal) =>
			new Promise<PreviewRender>((resolve, reject) =>
				renders.push({ body, signal, resolve, reject }),
			),
	);
	let urls = 0;
	const createObjectUrl = vi.fn((_blob: Blob) => `blob:preview-${++urls}`);
	const revokeObjectUrl = vi.fn((_url: string) => {});
	const views: VoicePreviewView[] = [];
	const frames = new Map<number, () => void>();
	let frameId = 0;
	const preview = createVoicePreview({
		audio,
		render,
		createObjectUrl,
		revokeObjectUrl,
		setView: (view) => views.push(view),
		document,
		requestFrame: (fn) => {
			frameId += 1;
			frames.set(frameId, fn);
			return frameId;
		},
		cancelFrame: (handle) => frames.delete(handle as number),
	});
	made.push(preview);
	const frame = () => {
		const pending = [...frames.values()];
		frames.clear();
		for (const fn of pending) fn();
	};
	const last = () => views.at(-1) as VoicePreviewView;
	return {
		audio,
		render,
		renders,
		createObjectUrl,
		revokeObjectUrl,
		preview,
		frame,
		last,
	};
}

const answer = (
	sentences: Array<[number, number]> = [
		[0, 1.2],
		[1.5, 2.6],
	],
): PreviewRender => ({
	blob: new Blob([new Uint8Array([1])], { type: "audio/mpeg" }),
	sentences,
});

const IMOGEN: BuiltInVoiceInfo = {
	key: "imogen",
	name: "Imogen",
	language: "en",
};

const sound = (owner: string, knobs: Partial<Knobs> = {}): PreviewSound => ({
	owner,
	request: { base: "imogen", knobs: { ...ZERO_KNOBS, ...knobs } },
	sentences: VOICE_SAMPLES.en,
});

/** Lets a resolved render's `then` run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Plays a sound and answers its render. */
async function played(
	t: ReturnType<typeof setup>,
	which: PreviewSound,
	sentences?: Array<[number, number]>,
) {
	t.preview.play(which);
	t.renders.at(-1)?.resolve(answer(sentences));
	await settle();
	t.audio.emit("playing");
}

afterEach(() => {
	for (const preview of made.splice(0)) preview.dispose();
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
});

describe("listenSound", () => {
	it("sends the base's sample, Original sends no knobs, and the person's words replace the sample", () => {
		const knobs = { ...ZERO_KNOBS, pace: -1 };
		expect(
			listenSound({ base: IMOGEN, knobs, compare: "yours", words: null }),
		).toEqual({
			owner: "listen",
			request: { base: "imogen", knobs },
			sentences: VOICE_SAMPLES.en,
		});
		expect(
			listenSound({ base: IMOGEN, knobs, compare: "original", words: null })
				.request.knobs,
		).toEqual(ZERO_KNOBS);
		expect(
			listenSound({
				base: IMOGEN,
				knobs,
				compare: "yours",
				words: "Hello there.",
			}),
		).toEqual({
			owner: "listen",
			request: { base: "imogen", knobs, text: "Hello there." },
			sentences: ["Hello there."],
		});
	});
});

describe("the voice preview", () => {
	it("unlocks synchronously, before the render is awaited", () => {
		const t = setup();
		t.preview.unlock();
		t.preview.toggle(sound("listen"));
		// Nothing was awaited between the press and the silent clip's play (iOS).
		expect(t.audio.plays).toEqual([silentMp3DataUri()]);
		expect(t.render).toHaveBeenCalledTimes(1);
		t.preview.unlock();
		expect(t.audio.plays).toHaveLength(1);
	});

	it("plays one sound at a time: starting another stops the first", async () => {
		const t = setup();
		t.preview.toggle(sound("base:imogen"));
		expect(t.last()).toMatchObject({
			owner: "base:imogen",
			status: "loading",
			player: { status: "seeking" },
		});
		t.renders[0]?.resolve(answer());
		await settle();
		t.audio.emit("playing");
		expect(t.audio.src).toBe("blob:preview-1");
		expect(t.last()).toMatchObject({ owner: "base:imogen", status: "playing" });
		t.preview.toggle(sound("base:rupert", { pace: 1 }));
		expect(t.audio.paused).toBe(true);
		expect(t.last()).toMatchObject({ owner: "base:rupert", status: "loading" });
		t.renders[1]?.resolve(answer());
		await settle();
		expect(t.audio.plays.at(-1)).toBe("blob:preview-2");
	});

	it("a second press of the same button pauses, a third resumes, and after the end it starts again", async () => {
		const t = setup();
		const imogen = sound("base:imogen");
		t.preview.toggle(imogen);
		t.renders[0]?.resolve(answer());
		await settle();
		t.audio.emit("playing");
		t.audio.currentTime = 0.8;
		t.preview.toggle(imogen);
		expect(t.audio.paused).toBe(true);
		expect(t.last().status).toBe("paused");
		t.preview.toggle(imogen);
		expect(t.audio.paused).toBe(false);
		expect(t.audio.currentTime).toBe(0.8);
		expect(t.render).toHaveBeenCalledTimes(1);
		t.audio.emit("playing");
		expect(t.last().status).toBe("playing");
		t.audio.paused = true;
		t.audio.ended = true;
		t.audio.emit("ended");
		expect(t.last()).toMatchObject({
			status: "paused",
			player: { status: "finished" },
		});
		t.preview.toggle(imogen);
		expect(t.audio.currentTime).toBe(0);
		expect(t.audio.paused).toBe(false);
		expect(t.render).toHaveBeenCalledTimes(1);
	});

	it("a press of the playing button pauses it, even after its sound changed", async () => {
		// The review's I2: the editor's pill passes the sound built from the knobs now; a
		// knob moved while it played (Play after each change off) must not make ⏸ render.
		const t = setup();
		await played(t, sound("listen"));
		t.preview.toggle(sound("listen", { pace: -1 }));
		expect(t.render).toHaveBeenCalledTimes(1);
		expect(t.audio.paused).toBe(true);
		expect(t.last().status).toBe("paused");
		// From paused, the changed sound is a new one: it renders and plays.
		t.preview.toggle(sound("listen", { pace: -1 }));
		expect(t.render).toHaveBeenCalledTimes(2);
	});

	it("drops a render that a later press overtook", async () => {
		const t = setup();
		t.preview.toggle(sound("base:imogen"));
		t.preview.toggle(sound("base:rupert", { pace: 1 }));
		expect(t.renders[0]?.signal.aborted).toBe(true);
		t.renders[1]?.resolve(answer());
		await settle();
		expect(t.audio.src).toBe("blob:preview-1");
		t.renders[0]?.resolve(answer());
		await settle();
		expect(t.audio.src).toBe("blob:preview-1");
		expect(t.createObjectUrl).toHaveBeenCalledTimes(1);
		expect(t.last().owner).toBe("base:rupert");
	});

	it("replays a render it has kept without asking again, and keeps no more than 12, never evicting the one playing", async () => {
		const t = setup();
		const sounds = Array.from({ length: 13 }, (_, i) =>
			sound("listen", { pace: (i - 6) * 0.25 }),
		);
		for (let i = 0; i < 12; i++) await played(t, sounds[i] as PreviewSound);
		expect(t.render).toHaveBeenCalledTimes(12);
		// Kept: it plays at once, from its start.
		t.audio.currentTime = 2;
		t.preview.play(sounds[0] as PreviewSound);
		expect(t.render).toHaveBeenCalledTimes(12);
		expect(t.audio.src).toBe("blob:preview-1");
		expect(t.audio.currentTime).toBe(0);
		// The 13th goes in; the oldest kept render is now the second sound's, not the one played.
		await played(t, sounds[12] as PreviewSound);
		expect(t.revokeObjectUrl.mock.calls).toEqual([["blob:preview-2"]]);
		t.preview.play(sounds[1] as PreviewSound);
		expect(t.render).toHaveBeenCalledTimes(14);
	});

	it("shows where the sound is on every frame", async () => {
		const t = setup();
		await played(t, sound("listen"), [
			[0, 1.2],
			[1.5, 2.6],
		]);
		t.audio.currentTime = 1.6;
		t.frame();
		expect(t.last().player).toMatchObject({
			status: "playing",
			sentence: 1,
			count: 2,
			elapsed: "0:01",
			total: "0:02",
			totalIsEstimate: false,
			speed: 1,
		});
		expect(t.last().player.notches).toEqual([0, 1.5 / 2.6]);
		expect(t.last().player.progress).toBeCloseTo(1.6 / 2.6, 5);
		expect(t.audio.playbackRate).toBe(1);
	});

	it("seeks to a sentence's start, and a drag pauses and resumes there", async () => {
		const t = setup();
		await played(t, sound("listen"), [
			[0, 1.2],
			[1.5, 2.6],
		]);
		t.preview.seek(1);
		expect(t.audio.currentTime).toBe(1.5);
		expect(t.audio.paused).toBe(false);
		t.preview.beginDrag();
		expect(t.audio.paused).toBe(true);
		t.preview.dragTo(0);
		expect(t.last().player.drag).toBe(0);
		t.preview.endDrag(0);
		expect(t.audio.currentTime).toBe(0);
		expect(t.audio.paused).toBe(false);
		expect(t.last().player.drag).toBeNull();
	});

	it("a failed render shows stopped and retry renders it again", async () => {
		const t = setup();
		t.preview.toggle(sound("listen"));
		t.renders[0]?.reject(new ApiError("voice_unavailable", { status: 503 }));
		await settle();
		expect(t.last()).toMatchObject({
			owner: "listen",
			status: "failed",
			player: { status: "stopped" },
		});
		t.preview.retry();
		expect(t.render).toHaveBeenCalledTimes(2);
		t.renders[1]?.resolve(answer());
		await settle();
		expect(t.audio.plays.at(-1)).toBe("blob:preview-1");
	});

	it("pauses when the page is hidden", async () => {
		const t = setup();
		await played(t, sound("listen"));
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "hidden",
		});
		document.dispatchEvent(new Event("visibilitychange"));
		expect(t.audio.paused).toBe(true);
		expect(t.last().status).toBe("paused");
	});

	it("plays nothing it did not ask for: a paused or stopped sample is not woken by the OS", async () => {
		const t = setup();
		const imogen = sound("base:imogen");
		await played(t, imogen);
		t.preview.toggle(imogen);
		expect(t.last().status).toBe("paused");
		// A media key, Now Playing or headphones resume the element by themselves.
		t.audio.paused = false;
		t.audio.emit("play");
		expect(t.audio.paused).toBe(true);
		expect(t.last().status).toBe("paused");
		// Its own resume still plays.
		t.preview.toggle(imogen);
		t.audio.emit("play");
		expect(t.audio.paused).toBe(false);
		t.audio.emit("playing");
		expect(t.last().status).toBe("playing");
		// Stopped, it is torn down, and a woken element is paused at once.
		t.preview.stop();
		expect(t.audio.src).toBe("");
		expect(t.audio.load).toHaveBeenCalled();
		t.audio.paused = false;
		t.audio.emit("play");
		expect(t.audio.paused).toBe(true);
		// A kept render still plays again from a press.
		t.preview.play(imogen);
		t.audio.emit("play");
		expect(t.audio.paused).toBe(false);
		expect(t.audio.src).toBe("blob:preview-1");
	});

	it("stop forgets the sound, and dispose revokes every address", async () => {
		const t = setup();
		for (let i = 0; i < 3; i++)
			await played(t, sound("listen", { pitch: i - 1 }));
		t.preview.stop();
		expect(t.audio.paused).toBe(true);
		expect(t.last()).toMatchObject({ owner: null, status: "idle" });
		expect(t.revokeObjectUrl).not.toHaveBeenCalled();
		t.preview.dispose();
		expect(t.revokeObjectUrl.mock.calls.map(([url]) => url).sort()).toEqual([
			"blob:preview-1",
			"blob:preview-2",
			"blob:preview-3",
		]);
	});

	it('says "2/2 · Shall I read you the…" for the scrubber\'s bubble', async () => {
		const t = setup();
		await played(t, sound("listen"));
		expect(t.preview.sentencePreview(1)).toBe("2/2 · Shall I read you the…");
		expect(t.preview.sentencePreview(0)).toBe(
			"1/2 · Here's the short version: feed…",
		);
		expect(t.preview.sentencePreview(5)).toBe("");
	});
});
