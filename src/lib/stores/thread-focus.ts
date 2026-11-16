// A one-shot request for the thread to bring a place into view: read aloud's
// ⌖ ("center": the sentence being read, in the middle of the area above the
// composer) and a scrubber drag ("reveal": the target sentence, only when it is
// off screen). `MessageArea` owns the scroll and takes each request once, by its
// `seq`; the rect is a function, read when the scroll is planned.

import { type Readable, writable } from "svelte/store";

export type ThreadFocusRequest = {
	seq: number;
	rect: () => DOMRect | null;
	mode: "center" | "reveal";
};

const request = writable<ThreadFocusRequest | null>(null);
let seq = 0;

export const threadFocusRequest: Readable<ThreadFocusRequest | null> = {
	subscribe: request.subscribe,
};

export function requestThreadFocus(
	rect: () => DOMRect | null,
	mode: "center" | "reveal",
): void {
	seq += 1;
	request.set({ seq, rect, mode });
}
