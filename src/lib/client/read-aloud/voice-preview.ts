/**
 * The voice preview (Plan 3, Decision 3): the one `<audio>` element that every ▶
 * in Settings and the voice editor plays through, so one sound plays at a time by
 * construction. A sound belongs to the button that started it (its `owner`):
 * "listen" (the editor's player), "base:<key>" (a built-in voice's card) or
 * "voice:<id>" (a saved voice's row).
 *
 * - A render is asked of the preview route; a newer start aborts the one in
 *   flight, and an answer that a later start overtook is dropped.
 * - The last 12 renders stay in memory as object addresses, so Yours / Original
 *   flips at once; nothing is cached on the server or written to a disk.
 * - It publishes `voicePreviewView` (the pill's view of the sound on every
 *   frame while it plays), and it pauses when the page is hidden.
 */

import {
	type BuiltInVoiceInfo,
	type PreviewRender,
	type PreviewRequestBody,
	renderVoicePreview,
} from "$lib/client/api/read-aloud-voices";
import { silentMp3DataUri } from "$lib/shared/read-aloud/silent-mp3";
import {
	KNOB_KEYS,
	type Knobs,
	ZERO_KNOBS,
} from "$lib/shared/read-aloud/voice-knobs";
import { VOICE_SAMPLES } from "$lib/shared/read-aloud/voice-samples";
import {
	idleReadAloudView,
	idleVoicePreviewView,
	type ReadAloudView,
	setVoicePreviewView,
	type VoicePreviewView,
} from "$lib/stores/read-aloud";
import type { AudioLike } from "./controller";
import { formatClock } from "./timeline";

/** A sound a button plays: what to render, and the sentences it says (for the pill's bubble). */
export type PreviewSound = {
	owner: string;
	request: PreviewRequestBody;
	sentences: readonly string[];
};

/** The editor's sound: the voice (or, for Original, its base) saying the sample or the person's words. */
export function listenSound(input: {
	base: BuiltInVoiceInfo;
	knobs: Knobs;
	compare: "yours" | "original";
	words: string | null;
}): PreviewSound {
	const knobs = input.compare === "original" ? { ...ZERO_KNOBS } : input.knobs;
	if (input.words !== null)
		return {
			owner: "listen",
			request: { base: input.base.key, knobs, text: input.words },
			sentences: [input.words],
		};
	return {
		owner: "listen",
		request: { base: input.base.key, knobs },
		sentences: VOICE_SAMPLES[input.base.language],
	};
}

export type VoicePreviewDeps = {
	audio: AudioLike;
	render: (
		body: PreviewRequestBody,
		signal: AbortSignal,
	) => Promise<PreviewRender>;
	createObjectUrl: (blob: Blob) => string;
	revokeObjectUrl: (url: string) => void;
	setView: (view: VoicePreviewView) => void;
	document: Document;
	requestFrame: (fn: () => void) => unknown;
	cancelFrame: (handle: unknown) => void;
};

export interface VoicePreview {
	/** The first call plays a silent clip on the element, synchronously, so iOS allows its later plays. */
	unlock(): void;
	/** The same button pauses or resumes its sound (from the start once it ended); another button's sound replaces it. */
	toggle(sound: PreviewSound): void;
	/** (Re)starts this sound from its first sentence, replacing whatever plays. */
	play(sound: PreviewSound): void;
	/** Plays the failed sound again. */
	retry(): void;
	seek(i: number): void;
	beginDrag(): void;
	dragTo(i: number): void;
	endDrag(i: number): void;
	/** `"2/2 · Shall I read you the…"`: the sentence's number and its first five words. */
	sentencePreview(i: number): string;
	/** Pauses and forgets the sound (the editor closed). */
	stop(): void;
	/** Stops, and revokes every address it keeps (Settings went). */
	dispose(): void;
}

/** How many renders are kept, so Yours / Original and a replay need no new render. */
const KEPT_RENDERS = 12;
/** The editor's estimate of a clip's length before it is rendered (Plan 3, Task 11). */
const ESTIMATE_CHARS_PER_SECOND = 15;

type Kept = { render: PreviewRender; url: string };

/** What a render is kept under: its base, its knobs on the 0.05 grid and its words. */
function renderKey(request: PreviewRequestBody): string {
	const knobs = KNOB_KEYS.map(
		(key) => Math.round((request.knobs[key] ?? 0) * 20) / 20,
	);
	return JSON.stringify([request.base, knobs, request.text ?? null]);
}

/** Each sentence's share of the text, for notches before the render answers. */
function textShares(sentences: readonly string[]): number[] {
	const total = sentences.reduce((sum, text) => sum + text.length, 0);
	let before = 0;
	return sentences.map((text) => {
		const share = total > 0 ? before / total : 0;
		before += text.length;
		return share;
	});
}

export function createVoicePreview(deps: VoicePreviewDeps): VoicePreview {
	const { audio } = deps;
	audio.playbackRate = 1;

	let unlocked = false;
	/** Each start takes a token; an answer for an older one is dropped. */
	let token = 0;
	let inFlight: AbortController | null = null;
	/** The kept renders, oldest first. */
	const kept = new Map<string, Kept>();

	let sound: PreviewSound | null = null;
	let soundKey: string | null = null;
	/** The render loaded on the element. */
	let current: Kept | null = null;
	let status: VoicePreviewView["status"] = "idle";
	let finished = false;
	let drag: number | null = null;
	let dragWasPlaying = false;
	let frame: unknown = null;

	const ours = () => current !== null && audio.src === current.url;
	const sentenceCount = () =>
		current ? current.render.sentences.length : (sound?.sentences.length ?? 0);
	const clipLength = () =>
		current ? (current.render.sentences.at(-1)?.[1] ?? 0) : 0;
	const clampSentence = (i: number) =>
		Math.max(0, Math.min(sentenceCount() - 1, Math.round(i)));

	function playerView(): ReadAloudView {
		if (!sound) return idleReadAloudView;
		const count = sentenceCount();
		const length = clipLength();
		const at = current ? audio.currentTime : 0;
		const starts = current
			? current.render.sentences.map(([start]) => start)
			: [];
		let sentence = 0;
		for (let i = 0; i < starts.length; i++)
			if ((starts[i] ?? 0) <= at) sentence = i;
		const estimate =
			sound.sentences.reduce((sum, text) => sum + text.length, 0) /
			ESTIMATE_CHARS_PER_SECOND;
		return {
			...idleReadAloudView,
			status:
				status === "loading"
					? "seeking"
					: status === "failed"
						? "stopped"
						: status === "playing"
							? "playing"
							: status === "paused"
								? finished
									? "finished"
									: "paused"
								: "idle",
			sentence: drag ?? sentence,
			count,
			notches:
				current && length > 0
					? starts.map((start) => start / length)
					: textShares(sound.sentences),
			progress: finished ? 1 : length > 0 ? Math.min(1, at / length) : 0,
			elapsed: formatClock(at),
			total: formatClock(current ? length : estimate),
			totalIsEstimate: !current,
			speed: 1,
			drag,
		};
	}

	function publish() {
		deps.setView(
			sound
				? { owner: sound.owner, status, player: playerView() }
				: idleVoicePreviewView,
		);
	}

	function tick() {
		frame = null;
		publish();
		if (status === "playing") frame = deps.requestFrame(tick);
	}

	function startFrames() {
		if (frame === null) frame = deps.requestFrame(tick);
	}

	function stopFrames() {
		if (frame !== null) deps.cancelFrame(frame);
		frame = null;
	}

	function playElement() {
		audio.playbackRate = 1;
		void audio.play().catch((error: unknown) => {
			// A pause or a newer start interrupts play() with an AbortError; only a
			// refused play (autoplay) is a failure, and Try again is a press.
			if (
				ours() &&
				error instanceof Error &&
				error.name === "NotAllowedError"
			) {
				status = "failed";
				stopFrames();
				publish();
			}
		});
	}

	function pauseElement() {
		if (!audio.paused) audio.pause();
	}

	function load(entry: Kept) {
		current = entry;
		audio.src = entry.url;
		audio.currentTime = 0;
		playElement();
	}

	function keep(key: string, entry: Kept) {
		kept.set(key, entry);
		while (kept.size > KEPT_RENDERS) {
			let evicted = false;
			for (const [oldKey, old] of kept) {
				if (old === current) continue;
				kept.delete(oldKey);
				deps.revokeObjectUrl(old.url);
				evicted = true;
				break;
			}
			if (!evicted) break;
		}
	}

	function forgetCurrent() {
		if (!current) return;
		for (const [key, entry] of kept)
			if (entry === current) {
				kept.delete(key);
				deps.revokeObjectUrl(entry.url);
			}
		current = null;
	}

	audio.addEventListener("playing", () => {
		if (!ours() || !sound) return;
		status = "playing";
		finished = false;
		startFrames();
		publish();
	});
	audio.addEventListener("pause", () => {
		if (!ours() || status !== "playing" || audio.ended) return;
		status = "paused";
		stopFrames();
		publish();
	});
	audio.addEventListener("ended", () => {
		if (!ours() || !sound) return;
		status = "paused";
		finished = true;
		stopFrames();
		publish();
	});
	audio.addEventListener("error", () => {
		if (!ours() || !sound) return;
		// The clip itself would not play: drop it, so Try again renders it anew.
		forgetCurrent();
		status = "failed";
		stopFrames();
		publish();
	});
	deps.document.addEventListener("visibilitychange", () => {
		if (deps.document.visibilityState !== "hidden" || status !== "playing")
			return;
		status = "paused";
		pauseElement();
		stopFrames();
		publish();
	});

	const preview: VoicePreview = {
		unlock() {
			if (unlocked) return;
			unlocked = true;
			audio.src = silentMp3DataUri();
			void audio.play().catch(() => {});
		},

		toggle(next) {
			const key = renderKey(next.request);
			if (sound && sound.owner === next.owner && soundKey === key) {
				if (status === "loading") return;
				if (status === "failed") {
					preview.retry();
					return;
				}
				if (status === "playing") {
					status = "paused";
					pauseElement();
					stopFrames();
					publish();
					return;
				}
				if (status === "paused" && current) {
					if (finished) {
						audio.currentTime = 0;
						finished = false;
					}
					playElement();
					publish();
					return;
				}
			}
			preview.play(next);
		},

		play(next) {
			token += 1;
			const mine = token;
			inFlight?.abort();
			inFlight = null;
			const key = renderKey(next.request);
			// The pause below sees "loading" and is not taken for the person's pause.
			status = "loading";
			finished = false;
			drag = null;
			sound = next;
			soundKey = key;
			pauseElement();
			stopFrames();
			const hit = kept.get(key);
			if (hit) {
				kept.delete(key);
				kept.set(key, hit);
				load(hit);
				publish();
				return;
			}
			current = null;
			publish();
			const abort = new AbortController();
			inFlight = abort;
			deps.render(next.request, abort.signal).then(
				(render) => {
					if (mine !== token) return;
					inFlight = null;
					const entry = { render, url: deps.createObjectUrl(render.blob) };
					load(entry);
					keep(key, entry);
					publish();
				},
				() => {
					if (mine !== token) return;
					inFlight = null;
					status = "failed";
					publish();
				},
			);
		},

		retry() {
			if (status === "failed" && sound) preview.play(sound);
		},

		seek(i) {
			if (!current) return;
			const index = clampSentence(i);
			audio.currentTime = current.render.sentences[index]?.[0] ?? 0;
			finished = false;
			if (audio.paused) playElement();
			publish();
		},

		beginDrag() {
			if (!current) return;
			dragWasPlaying = status === "playing";
			if (dragWasPlaying) {
				status = "paused";
				pauseElement();
				stopFrames();
			}
			drag = playerView().sentence;
			publish();
		},

		dragTo(i) {
			if (!current) return;
			drag = clampSentence(i);
			publish();
		},

		endDrag(i) {
			if (!current) return;
			drag = null;
			const index = clampSentence(i);
			audio.currentTime = current.render.sentences[index]?.[0] ?? 0;
			finished = false;
			if (dragWasPlaying) playElement();
			dragWasPlaying = false;
			publish();
		},

		sentencePreview(i) {
			const text = sound?.sentences[i];
			if (!sound || text === undefined) return "";
			const words = text.split(/\s+/u).filter((word) => word !== "");
			const head = words.slice(0, 5).join(" ");
			return `${i + 1}/${sound.sentences.length} · ${head}${words.length > 5 ? "…" : ""}`;
		},

		stop() {
			token += 1;
			inFlight?.abort();
			inFlight = null;
			status = "idle";
			sound = null;
			soundKey = null;
			finished = false;
			drag = null;
			stopFrames();
			pauseElement();
			publish();
		},

		dispose() {
			preview.stop();
			for (const entry of kept.values()) deps.revokeObjectUrl(entry.url);
			kept.clear();
			current = null;
		},
	};
	return preview;
}

let shared: VoicePreview | null = null;

/** The app's one voice preview, made on first use with its own `<audio preload="auto">`. */
export function getVoicePreview(): VoicePreview {
	if (shared) return shared;
	const audio = document.createElement("audio");
	audio.preload = "auto";
	shared = createVoicePreview({
		audio,
		render: (body, signal) => renderVoicePreview(body, signal),
		createObjectUrl: (blob) => URL.createObjectURL(blob),
		revokeObjectUrl: (url) => URL.revokeObjectURL(url),
		setView: setVoicePreviewView,
		document,
		requestFrame: (fn) => requestAnimationFrame(fn),
		cancelFrame: (handle) => cancelAnimationFrame(handle as number),
	});
	return shared;
}
