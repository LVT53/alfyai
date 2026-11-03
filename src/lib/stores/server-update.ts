import { writable } from "svelte/store";

/**
 * What the app has seen of a server update (a deploy) while someone is using
 * it. State only: nothing here fetches. The chat runtime reports what it saw,
 * and the shell watches the server and shows its notices from these (the
 * layout under `src/routes/(app)`; rules in `src/lib/components/chat/AGENTS.md`,
 * "An Update During A Turn").
 */

/**
 * Rises each time something saw a sign of an update: a message the server turned
 * away because it is draining, or a reply that an update cut off. A rise is
 * what makes the shell watch the server for a while; the number itself means
 * nothing.
 */
export const serverUpdateSign = writable(0);

export function reportServerUpdateSign(): void {
	serverUpdateSign.update((count) => count + 1);
}

/**
 * True while a message waits for the update to finish. It has not reached the
 * server (or the reply it was reading was cut), so a reload now would lose it:
 * the shell holds its Refresh notice until this goes false.
 */
export const turnWaitingForUpdate = writable(false);

export function setTurnWaitingForUpdate(waiting: boolean): void {
	turnWaitingForUpdate.set(waiting);
}

/**
 * How many chats hold words that have not reached the server yet: a draft save
 * that failed and is being sent again (`createDraftPersistence`), say the words of
 * a message that waited for the update when its chat was left. Like a message that
 * waits, they exist nowhere else, so the shell holds its Refresh notice while this
 * is above zero. The persistence reports; the count itself means nothing more.
 */
export const pendingDraftSaves = writable(0);

export function setPendingDraftSaves(count: number): void {
	pendingDraftSaves.set(count);
}
