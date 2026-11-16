// Read aloud, as the browser holds it: whether the feature is on.
//
// `readAloudAvailable` is seeded from the shell payload in
// `(app)/+layout.svelte`'s `onMount`, not during SSR: this is module state, and
// a server-side write would be shared by every concurrent request. The cost is
// the one the upload limit has: the server-rendered HTML shows no speaker, and
// it appears at hydration. A switched-off feature never shows one.

import { type Readable, writable } from "svelte/store";

const available = writable(false);

/** Whether the admin has read aloud switched on, with the speech service's address set. */
export const readAloudAvailable: Readable<boolean> = {
	subscribe: available.subscribe,
};

/** Publish the shell's answer. Only the app layout calls it. */
export function setReadAloudAvailable(on: boolean): void {
	available.set(on);
}
