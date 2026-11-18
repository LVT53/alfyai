// Read aloud, as the browser holds it: whether the feature is on.
//
// `readAloudAvailable` is seeded from the shell payload in
// `(app)/+layout.svelte`'s `onMount`, not during SSR: this is module state, and
// a server-side write would be shared by every concurrent request. The cost is
// the one the upload limit has: the server-rendered HTML shows no speaker, and
// it appears at hydration. A switched-off feature never shows one.

import { type Readable, writable } from "svelte/store";
import type {
	BreakKind,
	ReadingStatus,
} from "$lib/client/read-aloud/reading-machine";

const available = writable(false);

/** Whether the admin has read aloud switched on, with the speech service's address set. */
export const readAloudAvailable: Readable<boolean> = {
	subscribe: available.subscribe,
};

/** Publish the shell's answer. Only the app layout calls it. */
export function setReadAloudAvailable(on: boolean): void {
	available.set(on);
}

// The reading as the screen draws it. Only the reading controller
// (`src/lib/client/read-aloud/controller.ts`) sets it; the speaker, the marks
// and the player read it and call the controller.

/** What the speaker, the marks and the player draw: the reading's state, its place and its marks. */
export type ReadAloudView = {
	status: ReadingStatus;
	/** What is being read: a reply's message id, or a Document's or a report's key (`readingKey` in `controller.ts`). */
	key: string | null;
	/** Whether a reply, a Document or a standard report is being read; null when nothing is. */
	target: "reply" | "document" | "report" | null;
	/** A reply's segments ("Ask me first"); none for a Document. */
	segmentIds: readonly string[];
	/** Index of the sentence being read, or chosen. */
	sentence: number;
	count: number;
	/** Each sentence's share of the text: where its notch sits. */
	notches: number[];
	/**
	 * The sentences whose notch the scrubber draws (`drawnNotches` in `timeline.ts`): every
	 * sentence's in a short reading, a long one's headings or paragraphs, never crowded. Null
	 * draws every sentence's. Every sentence is still a place to land.
	 */
	drawnNotches: number[] | null;
	/** The share of the text read: the sentence and the word within it (1 when finished). */
	progress: number;
	/** Listening time so far, `m:ss`. */
	elapsed: string;
	/** The whole reading's listening time, `m:ss`; an estimate while `totalIsEstimate`. */
	total: string;
	totalIsEstimate: boolean;
	speed: number;
	failure: BreakKind | null;
	busy: boolean;
	/**
	 * The voice fell behind: the audio has waited for data for over about half a
	 * second while the reading plays. The player's play button spins (owner,
	 * 2026-11-17: "Yes, spin it").
	 */
	buffering: boolean;
	/** The sentence a scrubber drag would land on, while dragging. */
	drag: number | null;
	marks: { sentence: Range[]; word: Range | null; target: Range[] } | null;
};

export const idleReadAloudView: ReadAloudView = {
	status: "idle",
	key: null,
	target: null,
	segmentIds: [],
	sentence: 0,
	count: 0,
	notches: [],
	drawnNotches: null,
	progress: 0,
	elapsed: "0:00",
	total: "0:00",
	totalIsEstimate: false,
	speed: 1,
	failure: null,
	busy: false,
	buffering: false,
	drag: null,
	marks: null,
};

const view = writable<ReadAloudView>(idleReadAloudView);

export const readAloudView: Readable<ReadAloudView> = {
	subscribe: view.subscribe,
};

/** Only the reading controller calls it. */
export function setReadAloudView(next: ReadAloudView): void {
	view.set(next);
}

// Where a Document's or a standard report's reading shows its player. The
// composer's player shows it beside a docked panel in a chat; where the panel
// covers the chat (a phone, an expanded panel) or has none beside it (the
// Knowledge page), the panel draws the player for its own item's reading, and
// says so here so the composer's player leaves that reading to it.
const playerInPanel = writable(false);

/** The open panel draws the player for its Document's or report's reading. */
export const readAloudPlayerInPanel: Readable<boolean> = {
	subscribe: playerInPanel.subscribe,
};

/** Only the Document panel (`DocumentWorkspace.svelte`) calls it. */
export function setReadAloudPlayerInPanel(on: boolean): void {
	playerInPanel.set(on);
}

// The voice preview as Settings and the editor draw it. Only the voice preview
// (`src/lib/client/read-aloud/voice-preview.ts`) sets it; every ▶ there and the
// editor's player read it and call the preview.

/**
 * Which button's sound it is (`"listen"`, `"base:<key>"`, `"voice:<id>"`), what
 * it is doing, and the pill's view of it: a loading render is the pill's
 * spinner (`"seeking"`), the end is `"finished"`, a failed render `"stopped"`.
 */
export type VoicePreviewView = {
	owner: string | null;
	status: "idle" | "loading" | "playing" | "paused" | "failed";
	player: ReadAloudView;
};

export const idleVoicePreviewView: VoicePreviewView = {
	owner: null,
	status: "idle",
	player: idleReadAloudView,
};

const previewView = writable<VoicePreviewView>(idleVoicePreviewView);

export const voicePreviewView: Readable<VoicePreviewView> = {
	subscribe: previewView.subscribe,
};

/** Only the voice preview calls it. */
export function setVoicePreviewView(next: VoicePreviewView): void {
	previewView.set(next);
}
