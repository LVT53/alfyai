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
	messageId: string | null;
	segmentIds: readonly string[];
	/** Index of the sentence being read, or chosen. */
	sentence: number;
	count: number;
	/** Each sentence's share of the text: where its notch sits. */
	notches: number[];
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
	/** The sentence a scrubber drag would land on, while dragging. */
	drag: number | null;
	marks: { sentence: Range[]; word: Range | null; target: Range[] } | null;
};

export const idleReadAloudView: ReadAloudView = {
	status: "idle",
	messageId: null,
	segmentIds: [],
	sentence: 0,
	count: 0,
	notches: [],
	progress: 0,
	elapsed: "0:00",
	total: "0:00",
	totalIsEstimate: false,
	speed: 1,
	failure: null,
	busy: false,
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
